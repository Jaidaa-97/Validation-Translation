/**
 * Small Express server:
 * - Serves the web UI from /public
 * - Accepts Excel upload + language choice
 * - Runs Playwright comparison and returns JSON results
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const express = require('express');
const multer = require('multer');
const {
  runComparison,
  launchRunBrowser,
  setActiveRunBrowser,
  closeActiveRunBrowser,
  isRunCancelledError,
} = require('./lib/playwrightRunner');
const { buildUrlForLanguage, LANGUAGE_HOSTS } = require('./lib/changeLanguage');
const { isFeatureSectionLabel } = require('./lib/featuresComparison');

const ALL_LANGUAGE_ORDER = ['ENG', 'GER', 'ITA', 'FRE', 'JAP', 'SPA'];

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseLanguageCodeList(raw) {
  if (!raw) {
    return [];
  }
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      list = raw.split(/[,;\s]+/);
    }
  }
  if (!Array.isArray(list)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const code = String(item || '')
      .trim()
      .toUpperCase();
    if (!LANGUAGE_HOSTS[code] || seen.has(code)) {
      continue;
    }
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** @param {string[]} codes */
function orderLanguageCodes(codes) {
  const set = new Set(codes);
  return ALL_LANGUAGE_ORDER.filter((code) => set.has(code));
}

/**
 * @param {import('express').Request['body']} body
 * @returns {string[]}
 */
function parseRequestedLanguages(body) {
  const fromList = parseLanguageCodeList(body.languages);
  if (fromList.length) {
    return orderLanguageCodes(fromList);
  }
  const requested = String(body.language || '')
    .trim()
    .toUpperCase();
  if (!requested || requested === 'ALL') {
    return ALL_LANGUAGE_ORDER.filter((code) => LANGUAGE_HOSTS[code]);
  }
  if (LANGUAGE_HOSTS[requested]) {
    return [requested];
  }
  return ALL_LANGUAGE_ORDER.filter((code) => LANGUAGE_HOSTS[code]);
}

/** Default hotel page from your brief — override in the form or with DEFAULT_LHW_URL. */
const DEFAULT_LHW_URL =
  process.env.DEFAULT_LHW_URL ||
  'https://www.lhw.com/hotel/Kahala-Yokohama-Japan?rooms=1&numadult1=2&numchild1=0';

const app = express();

const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const MAX_PORT_TRIES = 15;

/** Actual TCP port the UI is served on (updated when `server.listen` fires). */
let boundListenPort = PREFERRED_PORT;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.originalname.toLowerCase().endsWith('.xlsx');
    if (!ok) {
      return cb(new Error('Please upload an .xlsx file.'));
    }
    cb(null, true);
  },
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    // Dev-only: tell the browser never to cache the UI files so changes to
    // public/* are picked up the moment you reload the page.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    },
    etag: false,
    lastModified: false,
  }),
);

/** @type {{ cancel: () => void } | null} */
let activeHttpRun = null;

function cancelActiveHttpRun() {
  if (activeHttpRun) {
    activeHttpRun.cancel();
    activeHttpRun = null;
  }
}

/**
 * Stop the in-flight Playwright run (called when the user clicks Stop in the UI).
 */
app.post('/api/run/stop', (_req, res) => {
  cancelActiveHttpRun();
  closeActiveRunBrowser()
    .catch(() => {})
    .finally(() => {
      res.json({ ok: true });
    });
});

/**
 * Health check
 */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    listenPort: boundListenPort,
    listenUrl: `http://localhost:${boundListenPort}`,
    defaultUrl: DEFAULT_LHW_URL,
    languageHosts: LANGUAGE_HOSTS,
  });
});

/**
 * POST multipart form:
 * - file: Excel workbook
 * - pageUrl: optional full URL to open
 * - languages: optional JSON array of locale codes to run (e.g. ["ENG","GER","JAP"])
 * - language: legacy single code or ALL (used when languages is omitted)
 * - skipLanguages: optional JSON array of locale codes already completed (resume after Stop)
 *
 * Runs every configured LHW language and streams one result group as soon as it is ready.
 */
app.post('/api/run', upload.single('file'), async (req, res) => {
  cancelActiveHttpRun();
  const runControl = {
    cancelled: false,
    cancel() {
      this.cancelled = true;
      closeActiveRunBrowser().catch(() => {});
    },
  };
  activeHttpRun = runControl;

  try {
    if (!req.file) {
      activeHttpRun = null;
      return res.status(400).json({ error: 'Missing file field "file".' });
    }

    const rawUrl = String(req.body.pageUrl || '').trim() || DEFAULT_LHW_URL;
    let basePageUrl;
    try {
      basePageUrl = buildUrlForLanguage(rawUrl, 'ENG');
    } catch (e) {
      activeHttpRun = null;
      return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }

    const headless = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
    const allLanguages = parseRequestedLanguages(req.body);
    if (!allLanguages.length) {
      activeHttpRun = null;
      fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'No valid languages selected.' });
    }
    const skipLanguages = parseLanguageCodeList(req.body.skipLanguages);
    const skipSet = new Set(skipLanguages);
    const languages = allLanguages.filter((code) => !skipSet.has(code));
    if (!languages.length) {
      activeHttpRun = null;
      fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        error:
          skipLanguages.length > 0
            ? 'Every language in this run was already completed. Change the file, URL, or language selection to start fresh.'
            : 'No languages selected to run.',
      });
    }
    const strictEnglishBaseline =
      String(process.env.ENG_BASELINE_STRICT || '').toLowerCase() === 'true';
    const languageRuns = [];
    let abortedMessage = '';
    let baselineWarning = '';
    const startedAtMs = Date.now();

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    if (res.socket) {
      res.socket.setNoDelay(true);
    }

    /** User clicked Stop or closed the tab while the response stream is still open. */
    let runCancelled = false;
    const shouldStopRun = () => runControl.cancelled || runCancelled;
    res.on('close', () => {
      if (res.writableFinished || runCancelled) {
        return;
      }
      runCancelled = true;
      runControl.cancel();
    });

    const writeEvent = (event) => {
      if (res.destroyed || res.writableEnded) {
        return;
      }
      res.write(`${JSON.stringify(event)}\n`);
      if (typeof res.flush === 'function') {
        res.flush();
      }
    };

    writeEvent({
      type: 'start',
      pageUrl: basePageUrl,
      languages: allLanguages,
      languagesToRun: languages,
      skippedLanguages: skipLanguages,
      resumed: skipLanguages.length > 0,
      startedAtMs,
    });

    const isBaselineContentRow = (row) => {
      const section = String(row.section || '').replace(/^Hotel Features\s*→\s*/i, '');
      if (!section || section.startsWith('(')) {
        return false;
      }
      return !isFeatureSectionLabel(section);
    };

    /** Hard stop: run error or row-level Failed (not mere copy mismatch). */
    const englishBaselineHardFailed = (run) => {
      if (run?.error) {
        return true;
      }
      const rows = run?.results || [];
      return rows.some((row) => {
        if (!isBaselineContentRow(row)) {
          return false;
        }
        return String(row.status || '').toLowerCase() === 'failed';
      });
    };

    /** Strict mode (ENG_BASELINE_STRICT=true): any non-pass content row aborts other languages. */
    const englishBaselineStrictFailed = (run) => {
      if (englishBaselineHardFailed(run)) {
        return true;
      }
      const rows = run?.results || [];
      return rows.some((row) => {
        if (!isBaselineContentRow(row)) {
          return false;
        }
        const status = String(row.status || '').toLowerCase();
        return status !== 'passed' && status !== 'skipped';
      });
    };

    const englishBaselineMismatchSummary = (run) => {
      const rows = (run?.results || []).filter(isBaselineContentRow);
      const notFound = rows.filter(
        (row) => String(row.status || '').toLowerCase() === 'not found',
      );
      const failed = rows.filter((row) => String(row.status || '').toLowerCase() === 'failed');
      if (!notFound.length && !failed.length) {
        return '';
      }
      const parts = [];
      if (notFound.length) {
        parts.push(`${notFound.length} Not Found`);
      }
      if (failed.length) {
        parts.push(`${failed.length} Failed`);
      }
      return parts.join(', ');
    };

    /** @type {import('playwright').Browser | null} */
    let batchBrowser = null;
    if (languages.length > 0) {
      batchBrowser = await launchRunBrowser(headless);
      setActiveRunBrowser(batchBrowser);
      // eslint-disable-next-line no-console
      console.log('[Server] Reusing one browser for all languages in this run.');
    }

    try {
    for (const language of languages) {
      if (shouldStopRun()) {
        break;
      }
      const pageUrl = buildUrlForLanguage(basePageUrl, language);
      const languageStartedAtMs = Date.now();
      writeEvent({
        type: 'languageStart',
        language,
        pageUrl,
        startedAtMs: languageStartedAtMs,
        elapsedMs: languageStartedAtMs - startedAtMs,
      });
      let languageRun;
      try {
        const run = await runComparison({
          excelPath: req.file.path,
          languageCode: language,
          pageUrl,
          headless,
          sharedBrowser: batchBrowser || undefined,
          shouldAbort: shouldStopRun,
        });
        languageRun = {
          language,
          pageUrl,
          ...run,
        };
      } catch (runErr) {
        if (shouldStopRun() || isRunCancelledError(runErr)) {
          break;
        }
        const message = runErr instanceof Error ? runErr.message : String(runErr);
        languageRun = {
          language,
          pageUrl,
          results: [
            {
              hotelName: '',
              section: '(language run error)',
              language,
              expectedText: '',
              actualText: '',
              status: 'Failed',
              note: message,
            },
          ],
          error: message,
        };
      }
      const durationMs = Date.now() - languageStartedAtMs;
      languageRun.durationMs = durationMs;
      languageRuns.push(languageRun);
      if (shouldStopRun()) {
        break;
      }
      writeEvent({
        type: 'language',
        run: languageRun,
        durationMs,
        elapsedMs: Date.now() - startedAtMs,
      });
      if (languages.length > 1 && language === 'ENG') {
        const mismatchSummary = englishBaselineMismatchSummary(languageRun);
        const hardFailed = englishBaselineHardFailed(languageRun);
        const strictFailed = strictEnglishBaseline && englishBaselineStrictFailed(languageRun);

        if (hardFailed) {
          abortedMessage =
            'English validation hit a run error or failed row(s). Fix those issues before checking other languages.';
          writeEvent({
            type: 'baselineError',
            error: abortedMessage,
            mismatchSummary,
            elapsedMs: Date.now() - startedAtMs,
          });
          break;
        }

        if (strictFailed) {
          abortedMessage =
            'English copy in the uploaded file does not match the live site. Please update the English content before checking other languages.';
          writeEvent({
            type: 'baselineError',
            error: abortedMessage,
            mismatchSummary,
            elapsedMs: Date.now() - startedAtMs,
          });
          break;
        }

        if (mismatchSummary) {
          baselineWarning = `English check: ${mismatchSummary} on www.lhw.com. Other languages will still run — review the ENG section in the results.`;
          writeEvent({
            type: 'baselineWarning',
            warning: baselineWarning,
            mismatchSummary,
            elapsedMs: Date.now() - startedAtMs,
          });
        }
      }
    }

    // Clean up uploaded file after run (keep disk tidy)
    fs.promises.unlink(req.file.path).catch(() => {});

    const results = languageRuns.flatMap((run) => run.results || []);
    const stopped = shouldStopRun();
    writeEvent({
      type: 'done',
      pageUrl: basePageUrl,
      languages: allLanguages,
      languagesRun: languageRuns.map((run) => run.language),
      skippedLanguages: skipLanguages,
      totalRows: results.length,
      aborted: Boolean(abortedMessage) || stopped,
      error: stopped ? 'Run stopped.' : abortedMessage,
      baselineWarning,
      cancelled: stopped,
      elapsedMs: Date.now() - startedAtMs,
    });
    res.end();
    } finally {
      if (batchBrowser) {
        await closeActiveRunBrowser().catch(() => {});
        batchBrowser = null;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      res.write(`${JSON.stringify({ type: 'error', error: message })}\n`);
      res.end();
    } else {
      res.status(500).json({ error: message });
    }
  } finally {
    if (activeHttpRun === runControl) {
      activeHttpRun = null;
    }
  }
});

// Friendly errors for multer / upload issues
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : String(err);
  res.status(400).json({ error: message });
});

function listenWithFallback(port, triesLeft) {
  const server = http.createServer(app);
  server.listen(port, () => {
    boundListenPort = port;
    const origin = `http://localhost:${port}`;
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('================================================================');
    // eslint-disable-next-line no-console
    console.log('  LHW translation validator — open THIS address in your browser:');
    // eslint-disable-next-line no-console
    console.log(`  ${origin}`);
    // eslint-disable-next-line no-console
    console.log('================================================================');
    // eslint-disable-next-line no-console
    console.log(`(If Run / Compare fails, confirm the browser URL matches the line above. Port ${PREFERRED_PORT} is often busy if several terminals ran npm start.)`);
    // eslint-disable-next-line no-console
    console.log(`Default hotel URL: ${DEFAULT_LHW_URL}`);

    if (
      process.platform === 'win32' &&
      String(process.env.OPEN_BROWSER || '').toLowerCase() === 'true'
    ) {
      exec(`start "" "${origin}"`, { windowsHide: true }, () => {});
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.warn(`Port ${port} is already in use, trying ${port + 1}…`);
      listenWithFallback(port + 1, triesLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(
        `No free port found after ${MAX_PORT_TRIES} tries starting at ${PREFERRED_PORT}.`,
      );
      console.error('Close the other app using that port, or set PORT, e.g.: $env:PORT=4000; npm start');
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

listenWithFallback(PREFERRED_PORT, MAX_PORT_TRIES);
