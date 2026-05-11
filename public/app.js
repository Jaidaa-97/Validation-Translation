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
const diningSection = document.getElementById('dining-source-section');
const diningIntro = document.getElementById('dining-source-intro');
const diningPreviewEl = document.getElementById('dining-source-preview');
const spaSection = document.getElementById('spa-source-section');
const spaIntro = document.getElementById('spa-source-intro');
const spaPreviewEl = document.getElementById('spa-source-preview');
const propertySearchSection = document.getElementById('property-search-section');
const propertySearchIntro = document.getElementById('property-search-intro');
const propertySearchPreviewEl = document.getElementById('property-search-preview');

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
  } catch {
    pageUrlInput.placeholder = DEFAULT_PAGE_URL;
    serverDefaultUrl = DEFAULT_PAGE_URL;
  }
}

loadDefaultUrlHint();

const appOriginHint = document.getElementById('app-origin-hint');
if (appOriginHint && typeof window !== 'undefined' && window.location?.origin) {
  appOriginHint.textContent = `Use this address in your browser (port matters if 3000 is busy): ${window.location.origin}`;
}

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
    tr.innerHTML = '<td colspan="6">No rows returned.</td>';
    resultsBody.appendChild(tr);
    return;
  }

  for (const r of rows) {
    const tr = document.createElement('tr');
    const st = r.status || '';
    tr.innerHTML = `
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

/** @param {Record<string, unknown> | null | undefined} dm */
function renderDiningMeta(dm) {
  if (!diningSection || !diningIntro || !diningPreviewEl) {
    return;
  }
  if (!dm || !dm.url) {
    diningSection.hidden = true;
    diningPreviewEl.textContent = '';
    return;
  }

  diningSection.hidden = false;
  const opened = dm.openedOverviewFirst
    ? 'Opened the hotel overview first, then loaded the dining subpage.'
    : 'Loaded the dining subpage after the overview URL.';
  const count = typeof dm.characterCount === 'number' ? dm.characterCount : 0;
  const status = dm.fetchedText
    ? `Captured ${count} character(s) from the page.`
    : 'No body text was captured. Try: close other tabs using the same hotel run, set environment variable HEADLESS=false, or check the hotel URL slug.';
  diningIntro.innerHTML = `${escapeHtml(String(dm.url))}<br /><span class="hint">${escapeHtml(opened)} ${escapeHtml(status)}</span>`;
  diningPreviewEl.textContent = dm.fetchedText && dm.preview ? String(dm.preview) : '(empty preview)';
}

/** @param {Record<string, unknown> | null | undefined} sm */
function renderSpaMeta(sm) {
  if (!spaSection || !spaIntro || !spaPreviewEl) {
    return;
  }
  if (!sm || !sm.url) {
    spaSection.hidden = true;
    spaPreviewEl.textContent = '';
    return;
  }

  spaSection.hidden = false;
  const opened = sm.openedOverviewFirst
    ? 'Opened the hotel overview first, then loaded the spa subpage.'
    : 'Loaded the spa subpage after the overview URL.';
  const count = typeof sm.characterCount === 'number' ? sm.characterCount : 0;
  const status = sm.fetchedText
    ? `Captured ${count} character(s) from the page.`
    : 'No body text was captured. Try HEADLESS=false in the terminal before npm start, or confirm …/services-amenities/spa exists for this hotel.';
  spaIntro.innerHTML = `${escapeHtml(String(sm.url))}<br /><span class="hint">${escapeHtml(opened)} ${escapeHtml(status)}</span>`;
  spaPreviewEl.textContent = sm.fetchedText && sm.preview ? String(sm.preview) : '(empty preview)';
}

/** @param {Record<string, unknown> | null | undefined} pm */
function renderPropertySearchMeta(pm) {
  if (!propertySearchSection || !propertySearchIntro || !propertySearchPreviewEl) {
    return;
  }
  if (!pm || (!pm.query && !pm.url)) {
    propertySearchSection.hidden = true;
    propertySearchPreviewEl.textContent = '';
    return;
  }

  propertySearchSection.hidden = false;
  const q = pm.query ? `Search query used: ${String(pm.query)}` : 'Search query could not be derived from the hotel URL.';
  const count = typeof pm.characterCount === 'number' ? pm.characterCount : 0;
  const status = pm.fetchedText
    ? `Captured ${count} character(s) from p.hotel-desc.`
    : 'No hotel description captured (search field not found, no results, or bot block).';
  const urlLine = pm.url ? String(pm.url) : '(no result URL)';
  propertySearchIntro.innerHTML = `${escapeHtml(q)}<br />${escapeHtml(urlLine)}<br /><span class="hint">${escapeHtml(status)}</span>`;
  propertySearchPreviewEl.textContent = pm.fetchedText && pm.preview ? String(pm.preview) : '(empty preview)';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
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
    renderDiningMeta(data.diningMeta ?? null);
    renderSpaMeta(data.spaMeta ?? null);
    renderPropertySearchMeta(data.propertySearchMeta ?? null);
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
    renderDiningMeta(null);
    renderSpaMeta(null);
    renderPropertySearchMeta(null);
    renderResults([
      {
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
