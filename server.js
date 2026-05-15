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
const { runComparison } = require('./lib/playwrightRunner');
const { buildUrlForLanguage, LANGUAGE_HOSTS } = require('./lib/changeLanguage');

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
 * - language: ENG | GER | ITA | FRE | JAP | SPA
 * - pageUrl: optional full URL to open
 */
app.post('/api/run', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing file field "file".' });
    }

    const language = String(req.body.language || '').trim();
    if (!language) {
      return res.status(400).json({ error: 'Missing language.' });
    }

    const rawUrl = String(req.body.pageUrl || '').trim() || DEFAULT_LHW_URL;
    let pageUrl;
    try {
      pageUrl = buildUrlForLanguage(rawUrl, language);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }

    const headless = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

    const {
      results,
      diningMeta,
      spaMeta,
      propertySearchMeta,
      propertyOverviewSpecialMeta,
      propertyHighlightMeta,
      messageBannerMeta,
      specialNoticeMessage,
      hotelName,
    } = await runComparison({
      excelPath: req.file.path,
      languageCode: language,
      pageUrl,
      headless,
    });

    // Clean up uploaded file after run (keep disk tidy)
    fs.promises.unlink(req.file.path).catch(() => {});

    res.json({
      results,
      diningMeta,
      spaMeta,
      propertySearchMeta,
      propertyOverviewSpecialMeta,
      propertyHighlightMeta,
      messageBannerMeta,
      specialNoticeMessage,
      pageUrl,
      language,
      hotelName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
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
