const { chromium } = require('playwright');
const { buildUrlForLanguage, dismissOptionalCookieBanner } = require('./changeLanguage');
const { readContentSheet } = require('./excel');

/**
 * Airport / travel blurb under “Local Information” (from DevTools copy → selector).
 * If LHW changes wrapper divs, the shorter fallback still finds `section.local-information p.airport`.
 */
const LOCAL_INFO_AIRPORT_SELECTOR_FULL =
  '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.local-information.alt-bg.pb-5 > div > div.row > div:nth-child(2) > div > p.airport';

const LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK =
  '#main-content section.local-information p.airport';

/**
 * Collapse whitespace so small HTML/layout differences do not break comparisons.
 * @param {string} text
 */
function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Try to pull the slice of page text that corresponds to the expected string.
 * @param {string} pageText raw innerText from the page
 * @param {string} expected expected copy from Excel
 * @returns {string|null}
 */
function extractMatchingSnippet(pageText, expected) {
  const body = normalizeText(pageText);
  const exp = normalizeText(expected);
  if (!exp) {
    return null;
  }
  const idx = body.indexOf(exp);
  if (idx === -1) {
    return null;
  }
  return body.slice(idx, idx + exp.length);
}

/**
 * Excel column A (section label) must look like a Local Information row to use `p.airport` / airport line.
 * Adjust the regex if your sheet uses different labels.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isLocalInformationSectionLabel(sectionLabel) {
  const s = String(sectionLabel || '').trim();
  if (!s) {
    return false;
  }
  return (
    /local\s*information/i.test(s) ||
    /^local\s*info\b/i.test(s) ||
    /^airport\b/i.test(s)
  );
}

/**
 * Read `p.airport` text straight from the DOM.
 * Uses textContent so we still get copy when the tab panel is hidden (display:none) — innerText would be empty.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readAirportTextFromDom(page) {
  const raw = await page
    .evaluate(() => {
      const full = document.querySelector(
        '#main-content section.local-information p.airport',
      );
      if (full && full.textContent) {
        return full.textContent;
      }
      const section = document.querySelector('section.local-information');
      if (section) {
        const p = section.querySelector('p.airport');
        if (p && p.textContent) {
          return p.textContent;
        }
      }
      return '';
    })
    .catch(() => '');

  return String(raw || '').trim();
}

/**
 * Wait until the hotel overview has injected “Local Information” (section + airport line).
 * Without this, client-side rendering can still be empty right after domcontentloaded.
 * @param {import('playwright').Page} page
 */
async function waitForLocalInformationSection(page) {
  const section = page.locator('section.local-information').first();
  await section.waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
  const airport = section.locator('p.airport').first();
  await airport.waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
  await section.scrollIntoViewIfNeeded().catch(() => {});
  await airport.scrollIntoViewIfNeeded().catch(() => {});
}

/**
 * Try to activate “Local Information” in the UI (tabs, sticky nav, hash).
 * LHW often uses tabs; labels differ by locale.
 * @param {import('playwright').Page} page
 */
async function ensureLocalInformationVisible(page) {
  // Deep link: many SPAs scroll/open the right block when the hash is set (no full reload).
  await page
    .evaluate(() => {
      const h = 'local-information';
      if (!location.hash || !location.hash.toLowerCase().includes(h)) {
        location.hash = h;
      }
    })
    .catch(() => {});
  await page.waitForTimeout(900);

  // Tab / nav labels (English + common localized variants on de/it/fr/jp/es sites).
  const tabNameRegexes = [
    /local information/i,
    /local info/i,
    /lokale information/i,
    /informationen vor ort/i,
    /informazioni locali/i,
    /informations locales/i,
    /información local/i,
    /información sobre el destino/i,
    /現地情報/,
    /ローカル/,
  ];

  for (const re of tabNameRegexes) {
    try {
      const tab = page.getByRole('tab', { name: re }).first();
      if (await tab.isVisible({ timeout: 700 }).catch(() => false)) {
        await tab.scrollIntoViewIfNeeded().catch(() => {});
        await tab.click({ timeout: 8000, force: true });
        await page.waitForTimeout(700);
        return;
      }
    } catch {
      // try next pattern
    }
  }

  const extraClickers = [
    page.locator('a[href*="#local-information" i]').first(),
    page.locator('a[href*="local-information" i]').first(),
    page
      .locator('.sticky-nav-page-wrapper a, .js-stickybit-parent a, .nav-tabs a')
      .filter({ hasText: /local information|lokale information|informations locales|información local|informazioni locali|現地情報/i })
      .first(),
    page.locator('button').filter({ hasText: /local information|現地情報/i }).first(),
    page.getByRole('link', { name: /local information/i }).first(),
  ];

  for (const loc of extraClickers) {
    try {
      if (await loc.isVisible({ timeout: 700 }).catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 8000, force: true });
        await page.waitForTimeout(700);
        return;
      }
    } catch {
      // next
    }
  }

  // Scroll the section into view — helps lazy rendering even if we could not find a tab.
  await page
    .evaluate(() => {
      const s = document.querySelector('section.local-information');
      if (s) {
        s.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    })
    .catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * Read the airport paragraph under Local Information and return its text (or '').
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readLocalInformationAirportText(page) {
  await waitForLocalInformationSection(page);

  let text = await readAirportTextFromDom(page);
  if (normalizeText(text)) {
    return text;
  }

  await ensureLocalInformationVisible(page);
  await waitForLocalInformationSection(page);
  text = await readAirportTextFromDom(page);
  if (normalizeText(text)) {
    return text;
  }

  // Locator + textContent (works if element exists but Playwright visibility is flaky).
  for (const sel of [LOCAL_INFO_AIRPORT_SELECTOR_FULL, LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK]) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const raw = await loc
          .evaluate((el) => (el && el.textContent ? el.textContent : ''))
          .catch(() => '');
        if (normalizeText(raw)) {
          return String(raw).trim();
        }
      }
    } catch {
      // try next selector
    }
  }

  return '';
}

/**
 * Run one comparison pass: open URL, switch locale, read page text, compare each row.
 *
 * @param {object} opts
 * @param {string} opts.excelPath
 * @param {string} opts.languageCode ENG | GER | ...
 * @param {string} opts.pageUrl hotel deep link; host is rewritten to match opts.languageCode
 * @param {boolean} [opts.headless]
 * @returns {Promise<object[]>} rows for the results table
 */
async function runComparison({ excelPath, languageCode, pageUrl, headless = true }) {
  const lang = String(languageCode || '')
    .trim()
    .toUpperCase();
  const rows = readContentSheet(excelPath);
  const needsLocalInfoBlock = rows.some((r) => isLocalInformationSectionLabel(r.section));

  /** @type {import('playwright').Browser | null} */
  let browser = null;

  /** @type {object[]} */
  const results = [];

  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    // Taller window helps lazy-loaded blocks below the fold (Local Information is often near bottom).
    await page.setViewportSize({ width: 1280, height: 2200 });

    // One navigation: same path/query as pasted URL, subdomain matches selected language.
    const finalUrl = buildUrlForLanguage(pageUrl, lang);
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissOptionalCookieBanner(page);
    // Hotel detail is often a client-rendered shell; give tabs/sections time to mount.
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (needsLocalInfoBlock) {
      await waitForLocalInformationSection(page);
    }

    // Grab visible text from the main document. Adjust selector if the site structure changes.
    let pageText = '';
    try {
      const main = page.locator('main').first();
      if (await main.count()) {
        pageText = await main.innerText({ timeout: 15_000 });
      } else {
        pageText = await page.locator('body').innerText({ timeout: 15_000 });
      }
    } catch {
      try {
        pageText = await page.innerText('body');
      } catch {
        pageText = '';
      }
    }

    // Main/overview text only here. Airport line is merged only for rows whose section label is Local Information.
    const mainPageText = pageText;
    const airportBlock = needsLocalInfoBlock ? await readLocalInformationAirportText(page) : '';

    for (const row of rows) {
      const section = row.section;
      const expected = row.byLang[lang] || '';

      if (!expected) {
        results.push({
          section,
          language: lang,
          expectedText: '',
          actualText: '',
          status: 'Skipped',
          note: 'Empty cell for this language in Excel.',
        });
        continue;
      }

      const useAirport = isLocalInformationSectionLabel(section) && Boolean(airportBlock);
      const textForCompare = useAirport ? `${mainPageText}\n\n${airportBlock}` : mainPageText;
      const bodyNorm = normalizeText(textForCompare);

      const expNorm = normalizeText(expected);
      const snippet = extractMatchingSnippet(textForCompare, expected);
      const found = snippet !== null && bodyNorm.includes(expNorm);

      if (found) {
        results.push({
          section,
          language: lang,
          expectedText: expected,
          actualText: snippet || expNorm,
          status: 'Passed',
          note: '',
        });
      } else {
        const airportHint =
          useAirport && airportBlock ? normalizeText(airportBlock) : '';
        const isLocal = isLocalInformationSectionLabel(section);
        results.push({
          section,
          language: lang,
          expectedText: expected,
          actualText: airportHint,
          status: 'Not Found',
          note: airportHint
            ? 'Expected text not found. "Actual" is the Local Information airport line (p.airport).'
            : isLocal
              ? 'Expected text not found, and the airport line (p.airport) could not be read.'
              : 'Expected text was not found in the main page text (Local Information line is only used when the Excel section label mentions Local Information / airport).',
        });
      }
    }
  } catch (err) {
    // Do not crash the server — surface a synthetic row so the UI still renders.
    results.push({
      section: '(run error)',
      language: lang,
      expectedText: '',
      actualText: '',
      status: 'Failed',
      note: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return results;
}

module.exports = {
  runComparison,
  normalizeText,
  readLocalInformationAirportText,
  waitForLocalInformationSection,
  isLocalInformationSectionLabel,
  LOCAL_INFO_AIRPORT_SELECTOR_FULL,
  LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK,
};
