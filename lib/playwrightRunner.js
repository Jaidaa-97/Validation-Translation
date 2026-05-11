const { chromium } = require('playwright');
const {
  buildUrlForLanguage,
  buildDiningServicesUrl,
  buildSpaServicesUrl,
  buildHotelOverviewUrl,
  isDiningServicesPath,
  isSpaServicesPath,
  dismissOptionalCookieBanner,
} = require('./changeLanguage');
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
 * Also normalizes common “smart” punctuation from Excel vs. the site.
 * @param {string} text
 */
function normalizeText(text) {
  let s = String(text || '');
  try {
    s = s.normalize('NFC');
  } catch {
    // ignore if environment does not support normalize
  }
  return s
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Column A labels: trim + strip invisible chars / BOM (common in pasted Excel).
 * @param {string} label
 * @returns {string}
 */
function normalizeSectionLabel(label) {
  return String(label || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

/**
 * LHW (and CDNs) sometimes serve a short “access blocked” page to headless browsers.
 * @param {string} text
 * @returns {boolean}
 */
function isLikelyBotBlockPage(text) {
  const t = normalizeText(text).toLowerCase();
  if (t.length < 20) {
    return false;
  }
  if (t.includes('you have been blocked')) {
    return true;
  }
  if (t.includes('unable to access') && t.includes('lhw')) {
    return true;
  }
  if (t.includes('access denied') && t.includes('lhw')) {
    return true;
  }
  if (t.includes('zugriff verweigert') || t.includes('zugriff nicht möglich')) {
    return true;
  }
  if (t.includes('gesperrt') && t.includes('lhw')) {
    return true;
  }
  return false;
}

/** Playwright `locale` + Accept-Language to match the LHW subdomain. */
function playwrightLocaleForLanguageCode(langCode) {
  const map = {
    ENG: 'en-US',
    GER: 'de-DE',
    ITA: 'it-IT',
    FRE: 'fr-FR',
    JAP: 'ja-JP',
    SPA: 'es-ES',
  };
  return map[String(langCode || '').toUpperCase()] || 'en-US';
}

function acceptLanguageHeaderForCode(langCode) {
  const map = {
    ENG: 'en-US,en;q=0.9',
    GER: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
    ITA: 'it-IT,it;q=0.9,en;q=0.8',
    FRE: 'fr-FR,fr;q=0.9,en;q=0.8',
    JAP: 'ja-JP,ja;q=0.9,en;q=0.8',
    SPA: 'es-ES,es;q=0.9,en;q=0.8',
  };
  return map[String(langCode || '').toUpperCase()] || 'en-US,en;q=0.9';
}

/**
 * Pull the richest text from an LHW services-amenities (dining/spa) shell.
 * Prefers tab content and long <p> blocks (restaurant blurbs) over chrome-only noise.
 */
async function extractLhwServicesPageText(page) {
  return page
    .evaluate(() => {
      const textFrom = (el) => {
        if (!el) {
          return '';
        }
        const a = el.innerText;
        if (a && String(a).trim().length > 0) {
          return String(a);
        }
        const b = el.textContent;
        return b ? String(b) : '';
      };

      const pickLongest = (a, b) => (b.replace(/\s/g, '').length > a.replace(/\s/g, '').length ? b : a);

      let best = '';
      const trySet = (t) => {
        const s = String(t || '').trim();
        if (s.length > 40) {
          best = pickLongest(best, s);
        }
      };

      const mc = document.querySelector('#main-content');
      if (mc) {
        try {
          mc.scrollIntoView({ block: 'start', behavior: 'instant' });
        } catch {
          // ignore
        }
      }

      trySet(textFrom(document.querySelector('#main-content .tab-page-content')));
      trySet(textFrom(document.querySelector('#main-content .page.hotel-detail')));
      trySet(textFrom(document.querySelector('#main-content .alt-bg-list')));
      trySet(textFrom(mc));
      trySet(textFrom(document.querySelector('main')));

      if (mc) {
        const paras = [...mc.querySelectorAll('p')]
          .map((p) => textFrom(p).trim())
          .filter((x) => x.length > 100);
        if (paras.length) {
          trySet(paras.join('\n\n'));
        }
      }

      trySet(textFrom(document.body));
      return best.trim();
    })
    .catch(() => '');
}

/**
 * LHW spa services page: main title + prose from the structured blocks (CORI-style layout).
 * Title: `#spa-list-title` inside `.section-header.pt-5`.
 * Description: `.spa-details` (e.g. under `.col-12.col-md-6`).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>} Title and body joined by blank line(s), for comparison.
 */
async function extractSpaTitleAndDetailsText(page) {
  return page
    .evaluate(() => {
      const pick = (el) => {
        if (!el) {
          return '';
        }
        const a = el.innerText;
        if (a && String(a).trim()) {
          return String(a).trim();
        }
        const b = el.textContent;
        return b ? String(b).replace(/\s+/g, ' ').trim() : '';
      };

      const titleEl =
        document.querySelector('#spa-list-title') ||
        document.querySelector('.section-header.pt-5 h3.heading-xx-large') ||
        document.querySelector('.section-header h3[id*="spa-list"]');
      const title = pick(titleEl);

      let detailsEl = document.querySelector('.spa-details');
      if (!detailsEl) {
        detailsEl =
          document.querySelector('.col-12.col-md-6 .spa-details') ||
          document.querySelector('.col-md-6 .spa-details');
      }
      let desc = pick(detailsEl);

      if (!desc) {
        const h3 = document.querySelector('#spa-list-title');
        const headerRoot = h3?.closest('.section-header') || h3?.parentElement;
        let cur = headerRoot?.nextElementSibling;
        for (let step = 0; step < 16 && cur; step++) {
          const ps = cur.querySelectorAll ? [...cur.querySelectorAll('p')] : [];
          for (const p of ps) {
            const t = pick(p);
            if (t.length > 60) {
              desc = t;
              break;
            }
          }
          if (desc) {
            break;
          }
          cur = cur.nextElementSibling;
        }
      }

      if (!desc) {
        const p = document.querySelector(
          '#main-content .col-12.col-md-6 p, #main-content .col-md-6 p, main .col-md-6 p',
        );
        desc = pick(p);
      }

      const parts = [];
      if (title) {
        parts.push(title);
      }
      if (desc) {
        parts.push(desc);
      }
      return parts.join('\n\n');
    })
    .catch(() => '');
}

/** Keep results table readable when the dining page yields a lot of body text. */
const DINING_ACTUAL_PREVIEW_MAX = 4500;

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncateForResultPreview(text, max = DINING_ACTUAL_PREVIEW_MAX) {
  const t = String(text || '');
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max)}…`;
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
  const s = normalizeSectionLabel(sectionLabel);
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
 * Excel column A labels that should resolve “actual” copy from the hotel’s
 * `/services-amenities/dining` page (restaurant descriptions), not the overview body.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isRestaurantSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  return (
    /restaurant/i.test(s) ||
    /restaurant\s*#?\s*\d+/i.test(s) ||
    /^dining\b/i.test(s) ||
    /gastronom/i.test(s) ||
    /speisen/i.test(s) ||
    /plumeria/i.test(s) ||
    /services-amenities/i.test(s) ||
    /services.*amenities.*dining/i.test(s)
  );
}

/**
 * Excel column A: spa / wellness copy should be read from `/services-amenities/spa`.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isSpaSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  return (
    /\bspa\b/i.test(s) ||
    /spa\s*#?\s*\d+/i.test(s) ||
    /wellness/i.test(s) ||
    /massage/i.test(s) ||
    /hammam/i.test(s) ||
    /thermal\s*bath/i.test(s) ||
    /sauna/i.test(s) ||
    (/services-amenities/i.test(s) && /\bspa\b/i.test(s))
  );
}

/**
 * Excel column A: “Property Highlight #1 …” / “Property Highlight #2 Description” — copy from the hotel overview
 * (highlight blocks and their lead <p> paragraphs), not dining/spa subpages.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isPropertyHighlightSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  return /property\s*highlight/i.test(s);
}

/**
 * Excel column A mentions **Property search** — run the LHW homepage search and read `p.hotel-desc`
 * on the property-search results page (first card).
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isPropertySearchSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  return /property\s*search/i.test(s);
}

/**
 * Build a human query for the LHW site search from a hotel detail URL slug or a property-search URL.
 *
 * @param {string} urlString
 * @returns {string}
 */
function deriveHotelSearchQueryFromHotelUrl(urlString) {
  try {
    const raw = String(urlString || '').trim();
    const ps = raw.match(/\/property-search\/([^/?#]+)/i);
    if (ps) {
      return decodeURIComponent(ps[1])
        .replace(/\+/g, ' ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const m = raw.match(/\/hotel\/([^/?#]+)/i);
    if (!m) {
      return '';
    }
    const slug = decodeURIComponent(m[1]);
    const parts = slug.split('-').filter(Boolean);
    const hotelIdx = parts.findIndex((p) => /^hotel$/i.test(p));
    if (hotelIdx !== -1) {
      return parts.slice(0, hotelIdx + 1).join(' ');
    }
    if (parts.length >= 5) {
      return parts.slice(0, parts.length - 2).join(' ');
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

/**
 * Open localized www/de/… homepage in a **new** tab, search for the hotel, read the first `p.hotel-desc`.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} hotelPageUrl hotel or property-search URL (used only to derive the search query)
 * @param {string} languageCode
 * @returns {Promise<{ text: string, resultUrl: string, query: string }>}
 */
async function runPropertySearchAndReadHotelDesc(context, hotelPageUrl, languageCode) {
  const empty = { text: '', resultUrl: '', query: '' };
  const query = deriveHotelSearchQueryFromHotelUrl(hotelPageUrl);
  if (!normalizeText(query)) {
    return { ...empty, query: '' };
  }

  /** @type {import('playwright').Page | null} */
  let sp = null;
  try {
    const homeUrl = buildUrlForLanguage('https://www.lhw.com/', languageCode);
    sp = await context.newPage();
    await sp.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissOptionalCookieBanner(sp);
    await sp.waitForLoadState('networkidle', { timeout: 35_000 }).catch(() => {});
    await sp.waitForTimeout(1500);

    const tryFill = async () => {
      const candidates = [
        sp.getByRole('searchbox'),
        sp.locator('input[type="search"]').first(),
        sp.locator('input[placeholder*="Search" i]').first(),
        sp.locator('input[placeholder*="Find" i]').first(),
        sp.locator('input[placeholder*="Hotel" i]').first(),
        sp.locator('header input[type="text"]').first(),
        sp.locator('nav input[type="text"]').first(),
        sp.locator('input[name="q"]').first(),
        sp.locator('.search-global input').first(),
        sp.locator('[class*="search"] input[type="text"]').first(),
      ];
      for (const loc of candidates) {
        try {
          const box = loc.first();
          await box.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
          if (await box.isVisible().catch(() => false)) {
            await box.click({ timeout: 3000 }).catch(() => {});
            await box.fill('', { timeout: 2000 }).catch(() => {});
            await box.fill(query, { timeout: 8000 });
            return true;
          }
        } catch {
          // next
        }
      }
      return false;
    };

    const filled = await tryFill();
    if (!filled) {
      return { ...empty, query };
    }

    await sp.keyboard.press('Enter').catch(() => {});

    const searchBtn = sp.getByRole('button', { name: /search|find|go|submit/i }).first();
    if (await searchBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchBtn.click({ timeout: 8000 }).catch(() => {});
    }

    await sp.waitForURL(/property-search/i, { timeout: 50_000 }).catch(() => {});
    await sp.waitForLoadState('networkidle', { timeout: 35_000 }).catch(() => {});
    await sp.waitForTimeout(2500);

    await sp.locator('p.hotel-desc').first().waitFor({ state: 'attached', timeout: 25_000 }).catch(() => {});

    let raw = await sp
      .locator('p.hotel-desc')
      .first()
      .innerText({ timeout: 20_000 })
      .catch(() => '');

    if (!normalizeText(raw)) {
      raw = await sp
        .locator('p.hotel-desc')
        .first()
        .evaluate((el) => (el && el.textContent ? el.textContent : ''))
        .catch(() => '');
    }

    const resultUrl = sp.url() || '';
    const text = String(raw || '').trim();
    if (isLikelyBotBlockPage(text)) {
      return { text: '', resultUrl, query };
    }
    return { text, resultUrl, query };
  } catch {
    return { ...empty, query };
  } finally {
    if (sp) {
      await sp.close().catch(() => {});
    }
  }
}

/**
 * 1-based index from “Property Highlight #2 …”, or 1 when no number.
 * @param {string} sectionLabel
 * @returns {number}
 */
function propertyHighlightOrdinalFromLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  const m = s.match(/property\s*highlight\s*#?\s*(\d+)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  return 1;
}

/**
 * Collect ordered highlight body paragraphs from the overview (still on hotel main URL).
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
async function readPropertyHighlightSegments(page) {
  const raw = await page
    .evaluate(() => {
      const clean = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const main = document.querySelector('#main-content');
      if (!main) {
        return [];
      }

      const segments = [];
      const pushSeg = (t) => {
        const c = clean(t);
        if (c.length > 40 && !/^cookie\b/i.test(c) && !/you have been blocked/i.test(c)) {
          segments.push(c);
        }
      };

      // Regions whose class hints at “highlight”
      main.querySelectorAll('[class*="highlight"] p, [class*="Highlight"] p').forEach((p) => {
        pushSeg(p.innerText || p.textContent);
      });

      // Headings that literally say “Property Highlight”, then look for a nearby column paragraph
      const heads = [...main.querySelectorAll('h2, h3, h4, .heading-xx-large, .heading-large')].filter(
        (h) => /property\s*highlight/i.test(h.textContent || ''),
      );
      for (const h of heads) {
        let el = h.nextElementSibling;
        for (let depth = 0; depth < 14 && el; depth++) {
          const pDirect = el.tagName === 'P' ? el : null;
          const pNested = el.querySelector && el.querySelector('p');
          const cand = pDirect || pNested;
          if (cand) {
            pushSeg(cand.innerText || cand.textContent);
            break;
          }
          el = el.nextElementSibling;
        }
      }

      // Two-column layout: long <p> inside .col-md-6 (CORI-style property blurbs)
      if (!segments.length) {
        main.querySelectorAll('.col-12.col-md-6 p, .col-md-6 p').forEach((p) => {
          pushSeg(p.innerText || p.textContent);
        });
      }

      // Dedupe while preserving order
      const seen = new Set();
      const out = [];
      for (const s of segments) {
        const key = s.slice(0, 120);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(s);
        }
      }
      return out;
    })
    .catch(() => []);

  return Array.isArray(raw) ? raw : [];
}

/**
 * True if the row has any non-empty language cell (so we only open dining/spa when the sheet has copy to check).
 * @param {{ byLang: Record<string, string> }} row
 * @returns {boolean}
 */
function rowHasAnyLanguageContent(row) {
  return Object.values(row.byLang).some((v) => String(v || '').trim());
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
 * Open a localized services-amenities subpage (dining or spa) and read visible copy.
 * Call only after the overview (and optional Local Information) has been read — each call navigates away.
 *
 * @param {import('playwright').Page} page
 * @param {string} hotelPageUrl Overview URL already localized (same host/lang as the run)
 * @param {string} languageCode ENG | GER | ...
 * @param {'dining'|'spa'} amenity
 * @returns {Promise<string>}
 */
async function readServicesAmenitiesBlock(page, hotelPageUrl, languageCode, amenity) {
  const targetUrl =
    amenity === 'spa'
      ? buildSpaServicesUrl(hotelPageUrl, languageCode)
      : buildDiningServicesUrl(hotelPageUrl, languageCode);
  if (!targetUrl) {
    return '';
  }

  async function pullOnce() {
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 90_000 });
    await dismissOptionalCookieBanner(page);
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4500);
    await page
      .locator('#main-content')
      .first()
      .waitFor({ state: 'attached', timeout: 60_000 })
      .catch(() => {});

    await page
      .evaluate(() => {
        try {
          window.scrollTo(0, document.body.scrollHeight * 0.35);
        } catch {
          // ignore
        }
      })
      .catch(() => {});
    await page.waitForTimeout(800);
    await page
      .evaluate(() => {
        try {
          window.scrollTo(0, document.body.scrollHeight);
        } catch {
          // ignore
        }
      })
      .catch(() => {});
    await page.waitForTimeout(1200);

    let pageText = '';
    if (amenity === 'spa') {
      await page
        .locator('#spa-list-title')
        .first()
        .waitFor({ state: 'attached', timeout: 35_000 })
        .catch(() => {});
      await page
        .locator('.spa-details')
        .first()
        .waitFor({ state: 'attached', timeout: 35_000 })
        .catch(() => {});
      await page.locator('#spa-list-title').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.locator('.spa-details').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      pageText = String((await extractSpaTitleAndDetailsText(page)) || '').trim();
      if (normalizeText(pageText).length < 40) {
        const generic = String((await extractLhwServicesPageText(page)) || '').trim();
        pageText = normalizeText(pageText) ? `${pageText}\n\n${generic}`.trim() : generic;
      }
    } else {
      pageText = String((await extractLhwServicesPageText(page)) || '').trim();
    }

    if (pageText.length < 80) {
      try {
        const main = page.locator('main').first();
        if (await main.count()) {
          pageText = (await main.innerText({ timeout: 20_000 })).trim();
        } else {
          const block = page.locator('#main-content').first();
          if (await block.count()) {
            pageText = (await block.innerText({ timeout: 20_000 })).trim();
          } else {
            pageText = (await page.locator('body').innerText({ timeout: 20_000 })).trim();
          }
        }
      } catch {
        try {
          pageText = (await page.innerText('body')).trim();
        } catch {
          pageText = '';
        }
      }
    }

    if (isLikelyBotBlockPage(pageText)) {
      return '';
    }
    return pageText;
  }

  try {
    let out = await pullOnce();
    if (!normalizeText(out) || isLikelyBotBlockPage(out)) {
      await page.waitForTimeout(5000);
      out = await pullOnce();
    }
    if (isLikelyBotBlockPage(out)) {
      return '';
    }
    return out;
  } catch {
    return '';
  }
}

/** @param {import('playwright').Page} page */
async function readDiningServicesBlock(page, hotelPageUrl, languageCode) {
  return readServicesAmenitiesBlock(page, hotelPageUrl, languageCode, 'dining');
}

/** @param {import('playwright').Page} page */
async function readSpaServicesBlock(page, hotelPageUrl, languageCode) {
  return readServicesAmenitiesBlock(page, hotelPageUrl, languageCode, 'spa');
}

/**
 * Run one comparison pass: open URL, switch locale, read page text, compare each row.
 *
 * @param {object} opts
 * @param {string} opts.excelPath
 * @param {string} opts.languageCode ENG | GER | ...
 * @param {string} opts.pageUrl hotel deep link; host is rewritten to match opts.languageCode
 * @param {boolean} [opts.headless]
 * @returns {Promise<{ results: object[], diningMeta: object, spaMeta: object, propertySearchMeta: object }>}
 */
async function runComparison({ excelPath, languageCode, pageUrl, headless = true }) {
  const lang = String(languageCode || '')
    .trim()
    .toUpperCase();
  const rows = readContentSheet(excelPath);
  const needsLocalInfoBlock = rows.some((r) => isLocalInformationSectionLabel(r.section));
  const diningPathPasted = isDiningServicesPath(pageUrl);
  const spaPathPasted = isSpaServicesPath(pageUrl);
  const needsRestaurantBlock =
    diningPathPasted ||
    rows.some((r) => isRestaurantSectionLabel(r.section) && rowHasAnyLanguageContent(r));
  const needsSpaBlock =
    spaPathPasted ||
    rows.some((r) => isSpaSectionLabel(r.section) && rowHasAnyLanguageContent(r));
  const needsPropertyHighlightBlock =
    rows.some((r) => isPropertyHighlightSectionLabel(r.section) && rowHasAnyLanguageContent(r));
  const needsPropertySearchBlock =
    rows.some((r) => isPropertySearchSectionLabel(r.section) && rowHasAnyLanguageContent(r));

  /** @type {import('playwright').Browser | null} */
  let browser = null;

  /** @type {object[]} */
  const results = [];

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, openedOverviewFirst: boolean }} */
  const diningMeta = {
    url: needsRestaurantBlock ? buildDiningServicesUrl(pageUrl, lang) : null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    openedOverviewFirst: false,
  };

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, openedOverviewFirst: boolean }} */
  const spaMeta = {
    url: needsSpaBlock ? buildSpaServicesUrl(pageUrl, lang) : null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    openedOverviewFirst: false,
  };

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, query: string }} */
  const propertySearchMeta = {
    url: null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    query: '',
  };

  try {
    const useHeadless = headless !== false;
    /** Use real Chrome if `PW_CHANNEL=chrome` (often gets past CDN blocks that hit bundled Chromium). */
    const launchOpts = {
      headless: useHeadless,
      args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    };
    if (String(process.env.PW_CHANNEL || '').toLowerCase() === 'chrome') {
      launchOpts.channel = 'chrome';
    }
    browser = await chromium.launch(launchOpts);

    const context = await browser.newContext({
      locale: playwrightLocaleForLanguageCode(lang),
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': acceptLanguageHeaderForCode(lang),
      },
      viewport: { width: 1440, height: 2200 },
    });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      } catch {
        // ignore
      }
    });
    const page = await context.newPage();

    const finalUrl = buildUrlForLanguage(pageUrl, lang);
    const overviewNavUrl = buildHotelOverviewUrl(pageUrl, lang);
    const firstNavUrl = overviewNavUrl || finalUrl;
    const openedOverviewFirst = Boolean(overviewNavUrl && overviewNavUrl !== finalUrl);
    diningMeta.openedOverviewFirst = openedOverviewFirst;
    spaMeta.openedOverviewFirst = openedOverviewFirst;

    let propertySearchDesc = '';
    if (needsPropertySearchBlock) {
      const psRes = await runPropertySearchAndReadHotelDesc(context, firstNavUrl, lang);
      propertySearchDesc = psRes.text;
      propertySearchMeta.query = psRes.query || '';
      propertySearchMeta.url = psRes.resultUrl || null;
      if (propertySearchDesc) {
        propertySearchMeta.fetchedText = true;
        propertySearchMeta.characterCount = propertySearchDesc.length;
        propertySearchMeta.preview = truncateForResultPreview(normalizeText(propertySearchDesc), 1200);
      }
    }

    await page.goto(firstNavUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
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

    /** @type {string[]} */
    let propertyHighlightSegments = [];
    if (needsPropertyHighlightBlock) {
      await page
        .locator('#main-content')
        .first()
        .waitFor({ state: 'attached', timeout: 35_000 })
        .catch(() => {});
      await page.waitForTimeout(800);
      await page.locator('#main-content').first().scrollIntoViewIfNeeded().catch(() => {});
      propertyHighlightSegments = await readPropertyHighlightSegments(page);
    }

    const airportBlock = needsLocalInfoBlock ? await readLocalInformationAirportText(page) : '';
    const diningBlock = needsRestaurantBlock
      ? await readDiningServicesBlock(page, firstNavUrl, lang)
      : '';
    const spaBlock = needsSpaBlock ? await readSpaServicesBlock(page, firstNavUrl, lang) : '';

    if (diningBlock) {
      diningMeta.fetchedText = true;
      diningMeta.characterCount = diningBlock.length;
      diningMeta.preview = truncateForResultPreview(normalizeText(diningBlock), 1200);
    }
    if (spaBlock) {
      spaMeta.fetchedText = true;
      spaMeta.characterCount = spaBlock.length;
      spaMeta.preview = truncateForResultPreview(normalizeText(spaBlock), 1200);
    }

    for (const row of rows) {
      const section = normalizeSectionLabel(row.section);
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

      const isRestRow = isRestaurantSectionLabel(section);
      const isSpaRow = isSpaSectionLabel(section);
      const isPHRow = isPropertyHighlightSectionLabel(section);
      const isPSRow = isPropertySearchSectionLabel(section);
      const isLocRow = isLocalInformationSectionLabel(section);
      // If a label accidentally matches both, restaurant/dining wins so “Restaurant #1 Description”
      // still reads from the dining subpage, not the airport line.
      const useAirport =
        isLocRow && !isRestRow && !isSpaRow && !isPHRow && !isPSRow && Boolean(airportBlock);
      const useDining =
        Boolean(diningBlock) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        (isRestRow || (diningPathPasted && !isSpaRow));
      const useSpa =
        Boolean(spaBlock) &&
        !useAirport &&
        !useDining &&
        !isPHRow &&
        !isPSRow &&
        (isSpaRow || (spaPathPasted && !isRestRow));

      const phOrdinal = propertyHighlightOrdinalFromLabel(section);
      const phSlice =
        isPHRow && propertyHighlightSegments.length
          ? String(propertyHighlightSegments[phOrdinal - 1] ?? '').trim()
          : '';
      const usePH =
        Boolean(propertyHighlightSegments.length) &&
        isPHRow &&
        Boolean(normalizeText(phSlice)) &&
        !useAirport &&
        !useDining &&
        !useSpa &&
        !isPSRow;

      const usePS =
        Boolean(propertySearchDesc) &&
        isPSRow &&
        !useAirport &&
        !useDining &&
        !useSpa &&
        !usePH;

      let textForCompare = mainPageText;
      if (useAirport) {
        textForCompare = `${mainPageText}\n\n${airportBlock}`;
      } else if (useDining) {
        textForCompare = diningBlock;
      } else if (useSpa) {
        textForCompare = spaBlock;
      } else if (usePH) {
        textForCompare = phSlice;
      } else if (usePS) {
        textForCompare = propertySearchDesc;
      }
      const bodyNorm = normalizeText(textForCompare);

      const expNorm = normalizeText(expected);
      const snippet = extractMatchingSnippet(textForCompare, expected);
      const found = snippet !== null && bodyNorm.includes(expNorm);

      if (found) {
        const actualPass =
          (useDining || useSpa || usePH || usePS) && (snippet || expNorm)
            ? truncateForResultPreview(snippet || expNorm, 12_000)
            : snippet || expNorm;
        let passNote = '';
        if (useDining) {
          passNote = 'Match verified on the dining subpage (/services-amenities/dining).';
        } else if (useSpa) {
          passNote = 'Match verified on the spa subpage (/services-amenities/spa).';
        } else if (usePH) {
          passNote = 'Match verified on the hotel overview (Property Highlight block / lead paragraph).';
        } else if (usePS) {
          passNote = 'Match verified from LHW homepage → property-search result (`p.hotel-desc`).';
        }
        results.push({
          section,
          language: lang,
          expectedText: expected,
          actualText: actualPass,
          status: 'Passed',
          note: passNote,
        });
      } else {
        const airportHint =
          useAirport && airportBlock ? normalizeText(airportBlock) : '';
        const diningHintRaw = useDining && diningBlock ? normalizeText(diningBlock) : '';
        const diningHint = diningHintRaw ? truncateForResultPreview(diningHintRaw) : '';
        const spaHintRaw = useSpa && spaBlock ? normalizeText(spaBlock) : '';
        const spaHint = spaHintRaw ? truncateForResultPreview(spaHintRaw) : '';
        const phHintRaw =
          isPHRow &&
          !isPSRow &&
          propertyHighlightSegments.length
            ? normalizeText(phSlice || propertyHighlightSegments.join('\n\n'))
            : '';
        const phHint = phHintRaw ? truncateForResultPreview(phHintRaw) : '';
        const isLocal = isLocalInformationSectionLabel(section);
        const wantsDining =
          isRestRow || (diningPathPasted && !isSpaRow && !useAirport && !isPHRow && !isPSRow);
        const wantsSpa =
          isSpaRow || (spaPathPasted && !isRestRow && !useAirport && !isPHRow && !isPSRow);
        const wantsPH = isPHRow && !useAirport && !isPSRow;
        const wantsPS = isPSRow && !useAirport;
        const psHintRaw = isPSRow && propertySearchDesc ? normalizeText(propertySearchDesc) : '';
        const psHint = psHintRaw ? truncateForResultPreview(psHintRaw) : '';
        const actualFallback = airportHint || diningHint || spaHint || phHint || psHint;

        let failNote =
          'Expected text was not found in the main page text (Local Information line is only used when the Excel section label mentions Local Information / airport).';
        if (airportHint) {
          failNote =
            'Expected text not found. "Actual" is the Local Information airport line (p.airport).';
        } else if (diningHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the dining page (/services-amenities/dining).';
        } else if (spaHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the spa page (/services-amenities/spa).';
        } else if (phHint) {
          failNote =
            'Expected text not found. "Actual" is text gathered from Property Highlight blocks on the overview.';
        } else if (psHint) {
          failNote =
            'Expected text not found. "Actual" is `p.hotel-desc` from the property-search results page.';
        } else if (isLocal) {
          failNote = 'Expected text not found, and the airport line (p.airport) could not be read.';
        } else if (wantsDining) {
          failNote =
            'Expected text not found, and the dining page could not be read (check the hotel URL has /hotel/{slug}…).';
        } else if (wantsSpa) {
          failNote =
            'Expected text not found, and the spa page could not be read (check the hotel URL has /hotel/{slug}…).';
        } else if (wantsPH) {
          failNote =
            'Expected text not found for this Property Highlight index, or highlight paragraphs could not be read from the overview.';
        } else if (wantsPS) {
          failNote =
            'Expected text not found, or property-search could not run (paste a /hotel/… URL so the hotel name can be derived, or a /property-search/… URL).';
        }

        results.push({
          section,
          language: lang,
          expectedText: expected,
          actualText: actualFallback,
          status: 'Not Found',
          note: failNote,
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

  return { results, diningMeta, spaMeta, propertySearchMeta };
}

module.exports = {
  runComparison,
  normalizeText,
  normalizeSectionLabel,
  readLocalInformationAirportText,
  readServicesAmenitiesBlock,
  readDiningServicesBlock,
  readSpaServicesBlock,
  extractSpaTitleAndDetailsText,
  waitForLocalInformationSection,
  isLocalInformationSectionLabel,
  isRestaurantSectionLabel,
  isSpaSectionLabel,
  isPropertyHighlightSectionLabel,
  isPropertySearchSectionLabel,
  deriveHotelSearchQueryFromHotelUrl,
  runPropertySearchAndReadHotelDesc,
  propertyHighlightOrdinalFromLabel,
  readPropertyHighlightSegments,
  LOCAL_INFO_AIRPORT_SELECTOR_FULL,
  LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK,
};
