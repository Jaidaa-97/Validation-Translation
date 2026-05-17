/**
 * Front-end logic: form submit via fetch, expandable per-language results.
 */

const DEFAULT_PAGE_URL =
  'https://www.lhw.com/hotel/Kahala-Yokohama-Japan?rooms=1&numadult1=2&numchild1=0';

const LANGUAGE_LABELS = {
  ENG: 'English',
  GER: 'German',
  ITA: 'Italian',
  FRE: 'French',
  JAP: 'Japanese',
  SPA: 'Spanish',
};

/** Filled from GET /api/health */
let serverDefaultUrl = DEFAULT_PAGE_URL;

const form = document.getElementById('run-form');
const fileInput = document.getElementById('file');
const pageUrlInput = document.getElementById('pageUrl');
const runBtn = document.getElementById('run-btn');
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

async function loadDefaultUrlHint() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
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

function renderLanguageRun(run, index) {
  const rows = run.results || [];
  const counts = countStatuses(rows);
  const details = document.createElement('details');
  details.className = 'language-section';
  details.open = index === 0 || counts.failed > 0 || Boolean(run.error);

  const summary = document.createElement('summary');
  summary.innerHTML = `
    <span class="language-title">${escapeHtml(languageTitle(run.language || ''))}</span>
    <span class="language-summary">
      ${rows.length} row(s) ·
      <span class="pass">${counts.passed} passed</span> ·
      <span class="fail">${counts.failed} failed</span> ·
      <span class="warn">${counts.skipped + counts.other} skipped/other</span>
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
  resultsContainer.appendChild(details);
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

async function readRunStream(res) {
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

  const handleEvent = (event) => {
    if (!event || typeof event !== 'object') {
      return;
    }
    if (event.type === 'start') {
      pageUrl = event.pageUrl || '';
      expectedLanguages = Array.isArray(event.languages) ? event.languages.length : 0;
      statusEl.textContent = `Running all languages… 0/${expectedLanguages || '?'} complete.`;
      return;
    }
    if (event.type === 'language') {
      const run = event.run || {};
      renderLanguageRun(run, completedLanguages);
      completedLanguages += 1;
      totalRows += (run.results || []).length;
      statusEl.textContent = `Running all languages… ${completedLanguages}/${expectedLanguages || '?'} complete.`;
      return;
    }
    if (event.type === 'done') {
      pageUrl = event.pageUrl || pageUrl;
      expectedLanguages = Array.isArray(event.languages) ? event.languages.length : expectedLanguages;
      if (typeof event.totalRows === 'number') {
        totalRows = event.totalRows;
      }
      if (event.aborted && event.error) {
        abortedMessage = event.error;
      }
      return;
    }
    if (event.type === 'baselineError') {
      abortedMessage =
        event.error ||
        'English copy in the uploaded file does not match the live site. Please update the English content before checking other languages.';
      resultsContainer.innerHTML = '';
      const message = document.createElement('p');
      message.className = 'run-error';
      message.textContent = abortedMessage;
      resultsContainer.appendChild(message);
      statusEl.textContent = abortedMessage;
      return;
    }
    if (event.type === 'error') {
      throw new Error(event.error || 'Run failed.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        handleEvent(JSON.parse(trimmed));
      }
    }
    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    handleEvent(JSON.parse(buffer.trim()));
  }

  return {
    pageUrl,
    languageCount: completedLanguages,
    totalRows,
    abortedMessage,
  };
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

/** @param {string | null | undefined} message */
function renderSpecialNoticeMessage(message) {
  if (!specialNoticeSection || !specialNoticeIntro || !specialNoticePreviewEl) {
    return;
  }
  const text = message != null ? String(message).trim() : '';
  if (!text) {
    specialNoticeSection.hidden = true;
    specialNoticePreviewEl.textContent = '';
    return;
  }

  specialNoticeSection.hidden = false;
  specialNoticeIntro.innerHTML = `<span class="hint">Captured ${text.length} character(s) from <code>div.alert.alert-info.special-notice div.message</code> (title, paragraphs, CTA link text).</span>`;
  specialNoticePreviewEl.textContent = text;
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
  clearRunOutput();
  statusEl.textContent = 'Running Playwright for all languages… this may take several minutes.';
  runBtn.disabled = true;

  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  // Empty = server applies DEFAULT_LHW_URL (see server.js).
  fd.append('pageUrl', pageUrlInput.value.trim());

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      body: fd,
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
    const summary = await readRunStream(res);
    statusEl.textContent = summary.abortedMessage
      ? summary.abortedMessage
      : `Done — ${summary.languageCount} language(s), ${summary.totalRows} total row(s). Base URL: ${summary.pageUrl}`;
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    statusEl.textContent = msg;
    clearRunOutput();
    renderErrorResult(msg);
  } finally {
    runBtn.disabled = false;
  }
});
