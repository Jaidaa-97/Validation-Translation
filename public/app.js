/**
 * Front-end logic: language buttons, form submit via fetch, results table.
 */

const DEFAULT_PAGE_URL =
  'https://www.lhw.com/hotel/Kahala-Yokohama-Japan?rooms=1&numadult1=2&numchild1=0';

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
const statusEl = document.getElementById('status');
const resultsBody = document.getElementById('results-body');
const propertyOverviewSpecialSection = document.getElementById('property-overview-special-section');
const propertyOverviewSpecialIntro = document.getElementById('property-overview-special-intro');
const propertyOverviewSpecialPreviewEl = document.getElementById('property-overview-special-preview');
const messageBannerSection = document.getElementById('message-banner-section');
const messageBannerIntro = document.getElementById('message-banner-intro');
const messageBannerPreviewEl = document.getElementById('message-banner-preview');
const specialNoticeSection = document.getElementById('special-notice-section');
const specialNoticeIntro = document.getElementById('special-notice-intro');
const specialNoticePreviewEl = document.getElementById('special-notice-preview');

/**
 * Keep path + query; only swap the hostname to match the selected language (www, de, it, …).
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
    languageInput.value = lang;
    document.querySelectorAll('.lang-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    // Only rewrite the host when the user already entered a URL (default field stays empty).
    const base = pageUrlInput.value.trim();
    if (base) {
      pageUrlInput.value = buildUrlWithLanguageHost(base, lang);
    }
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

function statusClassForRow(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'passed') return 'pass';
  if (s === 'failed') return 'fail';
  return 'warn';
}

function renderResults(rows) {
  resultsBody.innerHTML = '';
  if (!rows || !rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'placeholder';
    tr.innerHTML = '<td colspan="7">No rows returned.</td>';
    resultsBody.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    const st = r.status || '';
    tr.innerHTML = `
      <td>${escapeHtml(r.hotelName || '')}</td>
      <td>${escapeHtml(r.section || '')}</td>
      <td>${escapeHtml(r.language || '')}</td>
      <td>${escapeHtml(r.expectedText || '')}</td>
      <td>${escapeHtml(r.actualText || '')}</td>
      <td class="${statusClassForRow(st)}">${escapeHtml(st)}</td>
      <td class="muted">${escapeHtml(r.note || '')}</td>
    `;
    resultsBody.appendChild(tr);
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
  resultsBody.innerHTML = '';
  renderPropertyOverviewSpecialMeta(null);
  renderMessageBannerMeta(null);
  renderSpecialNoticeMessage(null);
  statusEl.textContent = 'Running Playwright… this may take a minute.';
  runBtn.disabled = true;

  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  fd.append('language', languageInput.value);
  // Empty = server applies DEFAULT_LHW_URL (see server.js).
  fd.append('pageUrl', pageUrlInput.value.trim());

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    renderResults(data.results);
    renderPropertyOverviewSpecialMeta(data.propertyOverviewSpecialMeta ?? null);
    renderMessageBannerMeta(data.messageBannerMeta ?? null);
    renderSpecialNoticeMessage(data.specialNoticeMessage ?? null);
    let statusMsg = `Done — ${data.results.length} row(s). URL used: ${data.pageUrl}`;
    const rows = data.results || [];
    const allSkipped =
      rows.length > 0 && rows.every((r) => String(r.status || '') === 'Skipped');
    if (allSkipped) {
      statusMsg +=
        ' Every row was skipped: fill the worksheet column for the language you selected (same codes as Excel: ENG, GER, …, SPA=Spanish).';
    }
    statusEl.textContent = statusMsg;
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    statusEl.textContent = msg;
    renderPropertyOverviewSpecialMeta(null);
    renderSpecialNoticeMessage(null);
    renderResults([
      {
        hotelName: '',
        section: '(client or server error)',
        language: languageInput.value,
        expectedText: '',
        actualText: '',
        status: 'Failed',
        note: msg,
      },
    ]);
  } finally {
    runBtn.disabled = false;
  }
});
