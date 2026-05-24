/**
 * Front-end logic: form submit via fetch, expandable per-language results.
 */

const DEFAULT_PAGE_URL =
  'https://www.lhw.com/hotel/Kahala-Yokohama-Japan?rooms=1&numadult1=2&numchild1=0';

const LANGUAGE_LABELS = {
  ALL: 'All Languages',
  ENG: 'English',
  GER: 'German',
  ITA: 'Italian',
  FRE: 'French',
  JAP: 'Japanese',
  SPA: 'Spanish',
};

/** Same order as server ALL_LANGUAGE_ORDER. */
const ALL_LANGUAGE_ORDER = ['ENG', 'GER', 'ITA', 'FRE', 'JAP', 'SPA'];

/** Same as server LANGUAGE_HOSTS — used if /api/health has no languageHosts yet. */
const FALLBACK_LANGUAGE_HOSTS = {
  ENG: 'www.lhw.com',
  GER: 'de.lhw.com',
  ITA: 'it.lhw.com',
  FRE: 'fr.lhw.com',
  JAP: 'jp.lhw.com',
  SPA: 'es.lhw.com',
};

/** Filled from GET /api/health */
let languageHosts = { ...FALLBACK_LANGUAGE_HOSTS };
let serverDefaultUrl = DEFAULT_PAGE_URL;

const form = document.getElementById('run-form');
const fileInput = document.getElementById('file');
const languageInput = document.getElementById('language');
const pageUrlInput = document.getElementById('pageUrl');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const statusEl = document.getElementById('status');
const resultsContainer = document.getElementById('results-container');
const propertyOverviewSpecialSection = document.getElementById('property-overview-special-section');
const propertyOverviewSpecialIntro = document.getElementById('property-overview-special-intro');
const propertyOverviewSpecialPreviewEl = document.getElementById('property-overview-special-preview');
const messageBannerSection = document.getElementById('message-banner-section');
const messageBannerIntro = document.getElementById('message-banner-intro');
const messageBannerPreviewEl = document.getElementById('message-banner-preview');
const specialNoticeSection = document.getElementById('special-notice-section');
const specialNoticeIntro = document.getElementById('special-notice-intro');
const specialNoticePreviewEl = document.getElementById('special-notice-preview');
/** @type {AbortController | null} */
let runAbortController = null;
let stopRequestedByUser = false;
/** Bumped on each new run or stop — stale stream events are ignored. */
let runSessionId = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let runProgressTimer = null;

/**
 * After Stop on an ALL run, the next Run resumes languages already finished.
 * @type {{ fileKey: string, pageUrl: string, languageMode: string, stoppedPartially: boolean, completedRuns: object[] } | null}
 */
let runResumeState = null;

/** @param {File | undefined | null} file */
function workbookKey(file) {
  if (!file) {
    return '';
  }
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function resetRunResumeState() {
  runResumeState = null;
  updateRunButtonLabel();
}

function initRunResumeState() {
  runResumeState = {
    fileKey: workbookKey(fileInput.files[0]),
    pageUrl: pageUrlInput.value.trim(),
    languageMode: languageInput.value,
    stoppedPartially: false,
    completedRuns: [],
  };
  updateRunButtonLabel();
}

/** @param {object} run */
function recordCompletedLanguageRun(run) {
  const code = String(run?.language || '').trim();
  if (!code || !runResumeState || runResumeState.languageMode !== 'ALL') {
    return;
  }
  const snapshot = {
    language: code,
    pageUrl: run.pageUrl,
    results: run.results,
    durationMs: run.durationMs,
    error: run.error,
    specialNoticeMessage: run.specialNoticeMessage,
    specialNoticeMessages: run.specialNoticeMessages,
  };
  const idx = runResumeState.completedRuns.findIndex((r) => r.language === code);
  if (idx >= 0) {
    runResumeState.completedRuns[idx] = snapshot;
  } else {
    runResumeState.completedRuns.push(snapshot);
  }
}

function canResumeAllLanguageRun() {
  if (!runResumeState?.stoppedPartially || runResumeState.languageMode !== 'ALL') {
    return false;
  }
  if (languageInput.value !== 'ALL') {
    return false;
  }
  if (workbookKey(fileInput.files[0]) !== runResumeState.fileKey) {
    return false;
  }
  if (pageUrlInput.value.trim() !== runResumeState.pageUrl) {
    return false;
  }
  const done = runResumeState.completedRuns.length;
  return done > 0 && done < ALL_LANGUAGE_ORDER.length;
}

function skipLanguagesForResume() {
  return (runResumeState?.completedRuns || []).map((r) => r.language);
}

function markRunStoppedPartially() {
  if (runResumeState?.languageMode === 'ALL' && runResumeState.completedRuns.length > 0) {
    runResumeState.stoppedPartially = true;
    updateRunButtonLabel();
  }
}

function markRunFullyCompleted() {
  if (runResumeState) {
    runResumeState.stoppedPartially = false;
    updateRunButtonLabel();
  }
}

function countRowsInRuns(runs) {
  return (runs || []).reduce((sum, run) => sum + (run.results?.length || 0), 0);
}

function updateRunButtonLabel() {
  if (!runBtn) {
    return;
  }
  runBtn.textContent = canResumeAllLanguageRun() ? 'Resume remaining languages' : 'Run / Compare';
}

/**
 * Keep path + query; only swap the hostname to match the selected language (www, de, it, ...).
 * @param {string} urlString
 * @param {string} langCode ENG | GER | ...
 * @returns {string}
 */
function buildUrlWithLanguageHost(urlString, langCode) {
  const host = languageHosts[langCode];
  if (!host) {
    return urlString;
  }
  try {
    const u = new URL(urlString.trim() || serverDefaultUrl);
    if (!u.hostname.toLowerCase().endsWith('lhw.com')) {
      return urlString;
    }
    u.hostname = host;
    return u.toString();
  } catch {
    return urlString;
  }
}

document.querySelectorAll('.lang-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const lang = btn.getAttribute('data-lang');
    if (runResumeState && lang !== runResumeState.languageMode) {
      resetRunResumeState();
    }
    languageInput.value = lang;
    document.querySelectorAll('.lang-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    // Only rewrite the host when the user already entered a URL (default field stays empty).
    const base = pageUrlInput.value.trim();
    if (base && lang !== 'ALL') {
      pageUrlInput.value = buildUrlWithLanguageHost(base, lang);
    }
    updateRunButtonLabel();
  });
});

// Default selection: ENG
document.querySelector('.lang-btn[data-lang="ENG"]')?.classList.add('active');

async function loadDefaultUrlHint() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.languageHosts && typeof data.languageHosts === 'object') {
      languageHosts = { ...FALLBACK_LANGUAGE_HOSTS, ...data.languageHosts };
    }
    if (data.defaultUrl) {
      serverDefaultUrl = data.defaultUrl;
      // Hint only — input stays empty until the user pastes a link (server uses default if still empty).
      pageUrlInput.placeholder = data.defaultUrl;
    }
    if (appOriginHint && data.listenUrl && typeof window !== 'undefined' && window.location?.origin) {
      const same = window.location.origin === data.listenUrl;
      appOriginHint.textContent = same
        ? `Connected to this server at ${data.listenUrl} (port ${data.listenPort ?? ''}).`
        : `Server reports ${data.listenUrl} — open that URL if this tab (${window.location.origin}) does not match your terminal.`;
    } else if (appOriginHint && typeof window !== 'undefined' && window.location?.origin) {
      appOriginHint.textContent = `This app: ${window.location.origin}`;
    }
  } catch {
    pageUrlInput.placeholder = DEFAULT_PAGE_URL;
    serverDefaultUrl = DEFAULT_PAGE_URL;
  }
}

const appOriginHint = document.getElementById('app-origin-hint');
loadDefaultUrlHint();

function setRunControls(isRunning) {
  runBtn.disabled = Boolean(isRunning);
  if (stopBtn) {
    stopBtn.disabled = !isRunning;
  }
}

function statusClassForRow(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'passed') return 'pass';
  if (s === 'failed') return 'fail';
  return 'warn';
}

function countStatuses(rows) {
  return (rows || []).reduce(
    (acc, row) => {
      const status = String(row.status || '').toLowerCase();
      if (status === 'passed') acc.passed += 1;
      else if (status === 'failed') acc.failed += 1;
      else if (status === 'skipped') acc.skipped += 1;
      else acc.other += 1;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0, other: 0 },
  );
}

function languageTitle(code) {
  const label = LANGUAGE_LABELS[code] || code;
  return `${label} (${code})`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function runProgressLabel(expectedLanguages) {
  return expectedLanguages === 1 ? 'Running selected language' : 'Running all languages';
}

function selectedRunLabel() {
  return languageInput.value === 'ALL' ? 'all languages' : languageInput.value || 'selected language';
}

function progressStatus(expectedLanguages, completedLanguages, elapsedMs, currentLanguage = '') {
  const active = currentLanguage ? ` (${currentLanguage})` : '';
  return `${runProgressLabel(expectedLanguages)}${active}… ${completedLanguages}/${expectedLanguages || '?'} complete. Elapsed: ${formatDuration(elapsedMs)}`;
}

function stopRunProgressTimer() {
  if (runProgressTimer) {
    window.clearInterval(runProgressTimer);
    runProgressTimer = null;
  }
}

function renderLanguageRun(run, index) {
  const rows = run.results || [];
  const counts = countStatuses(rows);
  const duration = typeof run.durationMs === 'number' ? ` · ${formatDuration(run.durationMs)}` : '';
  const langCode = String(run.language || '').trim();
  if (langCode) {
    resultsContainer
      .querySelectorAll(`.language-section[data-language="${langCode}"]`)
      .forEach((node) => node.remove());
  }
  const details = document.createElement('details');
  details.className = 'language-section';
  if (langCode) {
    details.dataset.language = langCode;
  }
  details.open = index === 0 || counts.failed > 0 || Boolean(run.error);

  const summary = document.createElement('summary');
  summary.innerHTML = `
    <span class="language-title">${escapeHtml(languageTitle(run.language || ''))}</span>
    <span class="language-summary">
      ${rows.length} row(s) ·
      <span class="pass">${counts.passed} passed</span> ·
      <span class="fail">${counts.failed} failed</span> ·
      <span class="warn">${counts.skipped + counts.other} skipped/other</span>${duration}
    </span>
  `;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'language-section-body';
  const runUrl = run.pageUrl ? `<p class="hint">URL: ${escapeHtml(run.pageUrl)}</p>` : '';
  const error = run.error ? `<p class="run-error">${escapeHtml(run.error)}</p>` : '';
  const rowsHtml = rows.length
    ? rows
        .map((r) => {
          const st = r.status || '';
          return `
            <tr>
              <td>${escapeHtml(r.hotelName || '')}</td>
              <td>${escapeHtml(r.section || '')}</td>
              <td>${escapeHtml(r.expectedText || '')}</td>
              <td>${escapeHtml(r.actualText || '')}</td>
              <td class="${statusClassForRow(st)}">${escapeHtml(st)}</td>
              <td class="muted">${escapeHtml(r.note || '')}</td>
            </tr>
          `;
        })
        .join('')
    : '<tr class="placeholder"><td colspan="6">No rows returned for this language.</td></tr>';

  body.innerHTML = `
    ${runUrl}
    ${error}
    <div class="table-wrap">
      <table class="results-table">
        <thead>
          <tr>
            <th>Hotel</th>
            <th>Section / Label</th>
            <th>Expected (Excel)</th>
            <th>Actual (site)</th>
            <th>Status</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
  details.appendChild(body);
  removeRunProgressHint();
  resultsContainer.appendChild(details);
  details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLanguageRuns(languageRuns) {
  resultsContainer.innerHTML = '';
  if (!languageRuns || !languageRuns.length) {
    resultsContainer.innerHTML = '<p class="placeholder">No language results returned.</p>';
    return;
  }

  languageRuns.forEach((run, index) => {
    renderLanguageRun(run, index);
  });
}

function clearRunOutput() {
  resultsContainer.innerHTML = '';
  renderPropertyOverviewSpecialMeta(null);
  renderMessageBannerMeta(null);
  renderSpecialNoticeMessage(null);
}

fileInput?.addEventListener('change', () => {
  resetRunResumeState();
});

pageUrlInput?.addEventListener('change', () => {
  if (runResumeState && pageUrlInput.value.trim() !== runResumeState.pageUrl) {
    resetRunResumeState();
  }
});

/** @param {string} message */
function showRunProgressHint(message) {
  let hint = document.getElementById('run-progress-hint');
  if (!hint) {
    hint = document.createElement('p');
    hint.id = 'run-progress-hint';
    hint.className = 'placeholder run-progress';
    resultsContainer.prepend(hint);
  }
  hint.textContent = message;
}

function removeRunProgressHint() {
  document.getElementById('run-progress-hint')?.remove();
}

function renderErrorResult(message) {
  renderLanguageRuns([
    {
      language: 'ERR',
      error: message,
      results: [
        {
          hotelName: '',
          section: '(client or server error)',
          expectedText: '',
          actualText: '',
          status: 'Failed',
          note: message,
        },
      ],
    },
  ]);
}

async function readRunStream(res, sessionId) {
  if (!res.body) {
    const data = await res.json();
    const languageRuns = data.languageRuns || [];
    renderLanguageRuns(languageRuns);
    return {
      pageUrl: data.pageUrl || '',
      languageCount: languageRuns.length,
      totalRows: Array.isArray(data.results)
        ? data.results.length
        : languageRuns.reduce((sum, run) => sum + (run.results?.length || 0), 0),
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pageUrl = '';
  let expectedLanguages = 0;
  let completedLanguages = 0;
  let totalRows = 0;
  let abortedMessage = '';
  let baselineWarning = '';
  let runCancelled = false;
  let elapsedMs = 0;
  let currentLanguage = '';
  let clientProgressStartedAt = 0;
  let serverElapsedAtLastEvent = 0;
  let priorRowCount = countRowsInRuns(runResumeState?.completedRuns);

  const isActiveSession = () => sessionId === runSessionId;

  const startProgressTimer = () => {
    stopRunProgressTimer();
    clientProgressStartedAt = Date.now();
    serverElapsedAtLastEvent = elapsedMs;
    runProgressTimer = window.setInterval(() => {
      if (!isActiveSession()) {
        stopRunProgressTimer();
        return;
      }
      const liveElapsedMs = serverElapsedAtLastEvent + (Date.now() - clientProgressStartedAt);
      statusEl.textContent = progressStatus(
        expectedLanguages,
        completedLanguages,
        liveElapsedMs,
        currentLanguage,
      );
    }, 1000);
  };

  const syncProgressTimer = () => {
    clientProgressStartedAt = Date.now();
    serverElapsedAtLastEvent = elapsedMs;
  };

  const handleEvent = (event) => {
    if (!isActiveSession() || !event || typeof event !== 'object') {
      return;
    }
    if (event.type === 'start') {
      pageUrl = event.pageUrl || '';
      expectedLanguages = Array.isArray(event.languages) ? event.languages.length : 0;
      const skipped = Array.isArray(event.skippedLanguages) ? event.skippedLanguages : [];
      if (skipped.length) {
        completedLanguages = skipped.length;
        priorRowCount = countRowsInRuns(runResumeState?.completedRuns);
        totalRows = 0;
      }
      const remaining = Array.isArray(event.languagesToRun)
        ? event.languagesToRun.length
        : Math.max(0, expectedLanguages - skipped.length);
      if (event.resumed && skipped.length) {
        showRunProgressHint(
          `Resuming — skipping ${skipped.join(', ')} (already done). ${remaining} language(s) remaining.`,
        );
        statusEl.textContent = `Resuming… ${completedLanguages}/${expectedLanguages} complete.`;
      } else {
        showRunProgressHint(
          expectedLanguages > 1
            ? `Running ${expectedLanguages} languages — results appear below as each language finishes.`
            : 'Running — results appear when the language finishes.',
        );
        statusEl.textContent = progressStatus(expectedLanguages, completedLanguages, 0);
      }
      startProgressTimer();
      return;
    }
    if (event.type === 'languageStart') {
      currentLanguage = event.language || '';
      if (typeof event.elapsedMs === 'number') {
        elapsedMs = event.elapsedMs;
      }
      showRunProgressHint(
        `Running ${languageTitle(currentLanguage)} (${completedLanguages + 1} of ${expectedLanguages || '?'})…`,
      );
      syncProgressTimer();
      statusEl.textContent = progressStatus(
        expectedLanguages,
        completedLanguages,
        elapsedMs,
        currentLanguage,
      );
      return;
    }
    if (event.type === 'language') {
      const run = event.run || {};
      if (typeof event.durationMs === 'number' && typeof run.durationMs !== 'number') {
        run.durationMs = event.durationMs;
      }
      renderSpecialNoticeFromRun(run);
      renderLanguageRun(run, completedLanguages);
      recordCompletedLanguageRun(run);
      completedLanguages += 1;
      totalRows += (run.results || []).length;
      if (typeof event.elapsedMs === 'number') {
        elapsedMs = event.elapsedMs;
      }
      currentLanguage = '';
      syncProgressTimer();
      statusEl.textContent = progressStatus(expectedLanguages, completedLanguages, elapsedMs);
      return;
    }
    if (event.type === 'done') {
      pageUrl = event.pageUrl || pageUrl;
      expectedLanguages = Array.isArray(event.languages) ? event.languages.length : expectedLanguages;
      if (typeof event.totalRows === 'number') {
        totalRows = event.totalRows;
      }
      if (typeof event.elapsedMs === 'number') {
        elapsedMs = event.elapsedMs;
      }
      if (event.aborted && event.error) {
        abortedMessage = event.error;
      }
      if (event.baselineWarning) {
        baselineWarning = String(event.baselineWarning);
      }
      if (event.cancelled) {
        runCancelled = true;
      } else if (
        expectedLanguages > 1 &&
        completedLanguages >= expectedLanguages &&
        !abortedMessage
      ) {
        markRunFullyCompleted();
      }
      removeRunProgressHint();
      return;
    }
    if (event.type === 'baselineWarning') {
      baselineWarning =
        event.warning ||
        (event.mismatchSummary
          ? `English check: ${event.mismatchSummary}. Other languages will still run.`
          : '');
      return;
    }
    if (event.type === 'baselineError') {
      abortedMessage =
        event.error ||
        'English copy in the uploaded file does not match the live site. Please update the English content before checking other languages.';
      if (event.mismatchSummary) {
        abortedMessage += ` (${event.mismatchSummary})`;
      }
      if (!resultsContainer.querySelector('.language-section')) {
        resultsContainer.innerHTML = '';
      }
      const message = document.createElement('p');
      message.className = 'run-error';
      message.textContent = abortedMessage;
      resultsContainer.prepend(message);
      if (typeof event.elapsedMs === 'number') {
        elapsedMs = event.elapsedMs;
      }
      statusEl.textContent = `${abortedMessage} Elapsed: ${formatDuration(elapsedMs)}`;
      return;
    }
    if (event.type === 'error') {
      throw new Error(event.error || 'Run failed.');
    }
  };

  try {
    while (true) {
      if (!isActiveSession()) {
        runCancelled = true;
        break;
      }
      let value;
      let done;
      try {
        ({ value, done } = await reader.read());
      } catch (readErr) {
        if (readErr && readErr.name === 'AbortError') {
          runCancelled = true;
          break;
        }
        throw readErr;
      }
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && isActiveSession()) {
          handleEvent(JSON.parse(trimmed));
        }
      }
      if (done) {
        break;
      }
    }

    if (buffer.trim() && isActiveSession()) {
      handleEvent(JSON.parse(buffer.trim()));
    }
  } finally {
    stopRunProgressTimer();
    if (isActiveSession()) {
      removeRunProgressHint();
    }
  }

  return {
    pageUrl,
    languageCount: completedLanguages,
    totalRows: priorRowCount + totalRows,
    abortedMessage,
    baselineWarning,
    runCancelled,
    elapsedMs,
  };
}

async function requestServerRunStop() {
  try {
    await fetch('/api/run/stop', { method: 'POST', keepalive: true });
  } catch {
    // Server may already be stopping the browser.
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** @param {Record<string, unknown> | null | undefined} om */
function renderPropertyOverviewSpecialMeta(om) {
  if (!propertyOverviewSpecialSection || !propertyOverviewSpecialIntro || !propertyOverviewSpecialPreviewEl) {
    return;
  }
  if (!om || !om.active) {
    propertyOverviewSpecialSection.hidden = true;
    propertyOverviewSpecialPreviewEl.textContent = '';
    return;
  }

  propertyOverviewSpecialSection.hidden = false;
  const count = typeof om.characterCount === 'number' ? om.characterCount : 0;
  let status = '';
  if (om.fetchedText) {
    status = `Captured ${count} character(s) from the property-overview block (Excel column H).`;
  } else if (om.selectorEmpty) {
    status =
      'Column H triggered this read, but the pinned property-overview selectors returned no text. Compare stays on main page text for non–special-note rows; special-note rows get an empty “Actual” pool.';
  } else {
    status = 'No text captured.';
  }
  propertyOverviewSpecialIntro.innerHTML = `<span class="hint">${escapeHtml(status)}</span>`;
  propertyOverviewSpecialPreviewEl.textContent =
    om.fetchedText && om.preview ? String(om.preview) : '(empty — see status above)';
}

/**
 * @param {string | null | undefined} message
 * @param {number} [blockCount]
 */
function renderSpecialNoticeMessage(message, blockCount = 0) {
  if (!specialNoticeSection || !specialNoticeIntro || !specialNoticePreviewEl) {
    return;
  }
  const text = message != null ? String(message).trim() : '';
  if (!text) {
    specialNoticeSection.hidden = true;
    specialNoticePreviewEl.innerHTML = '';
    return;
  }

  const blocks =
    blockCount > 0
      ? blockCount
      : (text.match(/^Special notice \d+/gm) || []).length || 1;

  specialNoticeSection.hidden = false;
  specialNoticeIntro.innerHTML = `<span class="hint">Captured ${blocks} special-notice block(s) from the property overview.</span>`;
  if (blocks > 1 && text.includes('\n---\n')) {
    const parts = text.split(/\n---\n/).map((part) => part.replace(/^Special notice \d+\s*/i, '').trim());
    specialNoticePreviewEl.innerHTML = parts
      .filter(Boolean)
      .map(
        (body, i) =>
          `<article class="notice-block"><h3 class="notice-block-title">Notice ${i + 1}</h3><pre class="notice-block-body">${escapeHtml(body)}</pre></article>`,
      )
      .join('');
  } else {
    specialNoticePreviewEl.innerHTML = `<article class="notice-block"><pre class="notice-block-body">${escapeHtml(text)}</pre></article>`;
  }
}

/** @param {Record<string, unknown> | null | undefined} run */
function renderSpecialNoticeFromRun(run) {
  if (!specialNoticeSection || !specialNoticeIntro || !specialNoticePreviewEl) {
    return;
  }
  const messages = Array.isArray(run?.specialNoticeMessages) ? run.specialNoticeMessages : [];
  if (!messages.length) {
    const preview = run?.specialNoticeMessage != null ? String(run.specialNoticeMessage).trim() : '';
    if (!preview) {
      return;
    }
    renderSpecialNoticeMessage(preview, 1);
    return;
  }

  specialNoticeSection.hidden = false;
  specialNoticeIntro.innerHTML = `<span class="hint">Captured <strong>${messages.length}</strong> special-notice block(s) from <code>div.alert.alert-info.special-notice div.message</code> (${escapeHtml(languageTitle(run.language || ''))}). Each Excel row is matched to one block by label #N, sheet order, or expected text.</span>`;

  specialNoticePreviewEl.innerHTML = messages
    .map((text, i) => {
      const body = String(text || '').trim();
      return `<article class="notice-block"><h3 class="notice-block-title">Notice ${i + 1}</h3><pre class="notice-block-body">${escapeHtml(body)}</pre></article>`;
    })
    .join('');
}

/** @param {Record<string, unknown> | null | undefined} mm */
function renderMessageBannerMeta(mm) {
  if (!messageBannerSection || !messageBannerIntro || !messageBannerPreviewEl) {
    return;
  }
  if (!mm || !mm.active) {
    messageBannerSection.hidden = true;
    messageBannerPreviewEl.textContent = '';
    return;
  }

  messageBannerSection.hidden = false;
  const sel = mm.selector ? String(mm.selector) : '#main-content div.message';
  const count = typeof mm.characterCount === 'number' ? mm.characterCount : 0;
  const status = mm.fetchedText
    ? `Captured ${count} character(s) from ${sel} (heading, paragraphs, link text).`
    : `No text from ${sel}. The hotel may not show a message strip on this locale, or the block is outside #main-content.`;
  messageBannerIntro.innerHTML = `<span class="hint">${escapeHtml(status)}</span>`;
  messageBannerPreviewEl.textContent =
    mm.fetchedText && mm.preview && String(mm.preview).trim()
      ? String(mm.preview)
      : '(empty — see status above)';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (runAbortController) {
    await requestServerRunStop();
    runAbortController.abort();
    runAbortController = null;
    stopRunProgressTimer();
  }
  runSessionId += 1;
  const sessionId = runSessionId;
  const resuming = canResumeAllLanguageRun();
  if (!resuming) {
    clearRunOutput();
    initRunResumeState();
  } else if (runResumeState) {
    runResumeState.stoppedPartially = false;
  }
  const skipList = resuming ? skipLanguagesForResume() : [];
  statusEl.textContent = resuming
    ? `Resuming ${selectedRunLabel()} — skipping ${skipList.join(', ')}…`
    : `Running Playwright for ${selectedRunLabel()}…`;
  runAbortController = new AbortController();
  stopRequestedByUser = false;
  setRunControls(true);

  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('language', languageInput.value);
  // Empty = server applies DEFAULT_LHW_URL (see server.js).
  fd.append('pageUrl', pageUrlInput.value.trim());
  if (skipList.length) {
    fd.append('skipLanguages', JSON.stringify(skipList));
  }

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      body: fd,
      signal: runAbortController.signal,
    });
    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        message = data.error || message;
      } catch {
        // Keep the generic HTTP error.
      }
      throw new Error(message);
    }
    const summary = await readRunStream(res, sessionId);
    if (sessionId !== runSessionId) {
      return;
    }
    if (summary.runCancelled || stopRequestedByUser) {
      markRunStoppedPartially();
      statusEl.textContent = `Stopped. ${summary.languageCount} language(s) completed, ${summary.totalRows} row(s). Click “Resume remaining languages” to continue. Elapsed: ${formatDuration(summary.elapsedMs)}`;
    } else if (summary.abortedMessage) {
      statusEl.textContent = `${summary.abortedMessage} Elapsed: ${formatDuration(summary.elapsedMs)}`;
    } else if (summary.baselineWarning) {
      statusEl.textContent = `${summary.baselineWarning} Done in ${formatDuration(summary.elapsedMs)} — ${summary.languageCount} language(s), ${summary.totalRows} total row(s).`;
    } else {
      statusEl.textContent = `Done in ${formatDuration(summary.elapsedMs)} — ${summary.languageCount} language(s), ${summary.totalRows} total row(s). Base URL: ${summary.pageUrl}`;
    }
  } catch (err) {
    console.error(err);
    if (sessionId !== runSessionId) {
      return;
    }
    if (stopRequestedByUser || (err && err.name === 'AbortError')) {
      markRunStoppedPartially();
      const done = runResumeState?.completedRuns?.length || 0;
      statusEl.textContent =
        done > 0
          ? `Run stopped. ${done} language(s) saved — click “Resume remaining languages” to continue.`
          : 'Run stopped by user.';
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    statusEl.textContent = msg;
    clearRunOutput();
    renderErrorResult(msg);
  } finally {
    stopRunProgressTimer();
    removeRunProgressHint();
    if (sessionId === runSessionId) {
      runAbortController = null;
      stopRequestedByUser = false;
      setRunControls(false);
      updateRunButtonLabel();
    }
  }
});

if (stopBtn) {
  stopBtn.addEventListener('click', async () => {
    if (!runAbortController) {
      return;
    }
    stopRequestedByUser = true;
    runSessionId += 1;
    stopRunProgressTimer();
    removeRunProgressHint();
    statusEl.textContent = 'Stopping run…';
    await requestServerRunStop();
    runAbortController.abort();
    runAbortController = null;
    markRunStoppedPartially();
    setRunControls(false);
    const done = runResumeState?.completedRuns?.length || 0;
    if (done > 0) {
      statusEl.textContent = `Stopped. ${done} language(s) saved — click “Resume remaining languages” to continue.`;
    } else {
      statusEl.textContent = 'Run stopped by user.';
    }
    updateRunButtonLabel();
  });
}

updateRunButtonLabel();
