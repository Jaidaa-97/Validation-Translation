const { chromium } = require('playwright');
const {
  buildUrlForLanguage,
  buildDiningServicesUrl,
  buildSpaServicesUrl,
  buildGolfServicesUrl,
  buildHotelOverviewUrl,
  isDiningServicesPath,
  isSpaServicesPath,
  isGolfServicesPath,
  dismissOptionalCookieBanner,
} = require('./changeLanguage');
const { readContentSheet } = require('./excel');
const {
  normalizeText: sharedNormalizeText,
  normalizeTextForCompare: sharedNormalizeTextForCompare,
  compareTextIncludes: sharedCompareTextIncludes,
  normalizeSectionLabel: sharedNormalizeSectionLabel,
  plainTextFromMaybeHtml: sharedPlainTextFromMaybeHtml,
} = require('./textNormalize');
const {
  isPropertySearchSectionLabel,
  derivePropertySearchQueryFromUrl,
  runPropertySearchAndReadHotelDesc,
} = require('./propertySearch');
const {
  isFeatureSectionLabel,
  buildExpectedFeatures,
  readActualFeaturesText,
  compareFeatures,
  FEATURE_STATUS,
} = require('./featuresComparison');
const {
  isPropertyHighlightTitleLabel,
  propertyHighlightTitleOrdinalFromLabel,
  compareHighlightTitle,
  readAllPropertyHighlightTitles,
} = require('./propertyHighlightTitles');
const {
  isGolfAmenityInfoItemLabel,
  golfAmenityInfoItemKeyFromLabel,
  compareGolfAmenityInfoItem,
  readAllGolfAmenityData,
  readGolfAmenityDataOnGolfSubpage,
  scrapeGolfAmenityDataOnPage,
  mergeGolfAmenityScrape,
  isGolfAmenityDataEmpty,
  compareGolfAmenityInfoItemForKey,
} = require('./golfAmenityInfoItems');

/** @type {import('playwright').Browser | null} */
let activeRunBrowser = null;

class RunCancelledError extends Error {
  constructor(message = 'Run cancelled by user.') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isRunCancelledError(err) {
  if (err instanceof RunCancelledError) {
    return true;
  }
  const msg = String(err instanceof Error ? err.message : err || '').toLowerCase();
  return (
    msg.includes('cancel') ||
    msg.includes('target closed') ||
    msg.includes('browser has been closed') ||
    msg.includes('connection closed')
  );
}

/**
 * @param {import('playwright').Browser | null} browser
 */
function setActiveRunBrowser(browser) {
  activeRunBrowser = browser;
}

/**
 * @param {import('playwright').Browser | null} browser
 */
function clearActiveRunBrowser(browser) {
  if (activeRunBrowser === browser) {
    activeRunBrowser = null;
  }
}

/** Close the Playwright browser for the in-flight run (e.g. user clicked Stop). */
async function closeActiveRunBrowser() {
  const browser = activeRunBrowser;
  activeRunBrowser = null;
  if (!browser) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log('[Runner] Closing active browser (run cancelled).');
  for (const context of browser.contexts()) {
    await context.close().catch(() => {});
  }
  await browser.close().catch(() => {});
}

/** @param {boolean} [headless] */
async function launchRunBrowser(headless = true) {
  const useHeadless = headless !== false;
  const launchOpts = {
    headless: useHeadless,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  };
  if (String(process.env.PW_CHANNEL || '').toLowerCase() === 'chrome') {
    launchOpts.channel = 'chrome';
  }
  return chromium.launch(launchOpts);
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} lang
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function createRunContext(browser, lang) {
  const context = await browser.newContext({
    locale: playwrightLocaleForLanguageCode(lang),
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': acceptLanguageHeaderForCode(lang),
    },
    viewport: { width: 1440, height: 2200 },
  });
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (type === 'image' || type === 'media' || type === 'font') {
      route.abort().catch(() => {});
      return;
    }
    if (
      /google-analytics|googletagmanager|facebook\.net|hotjar|doubleclick|analytics|optimizely|segment\.io/i.test(
        url,
      )
    ) {
      route.abort().catch(() => {});
      return;
    }
    route.continue().catch(() => {});
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
  return context;
}

/**
 * @param {(() => boolean) | undefined} shouldAbort
 */
function throwIfAborted(shouldAbort) {
  if (shouldAbort?.()) {
    throw new RunCancelledError();
  }
}

/** Max wait for `page.goto` — keep low; LHW usually paints on `commit` quickly. */
const PAGE_GOTO_TIMEOUT_MS = 25_000;

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 */
async function gotoPageCommit(page, url) {
  await page.goto(url, { waitUntil: 'commit', timeout: PAGE_GOTO_TIMEOUT_MS });
}

/**
 * Load dining / spa / golf subpages in parallel (separate tabs).
 * @param {import('playwright').BrowserContext} context
 * @param {object} opts
 * @returns {Promise<{ diningRes: object|null, spaRes: object|null, golfRes: object|null }>}
 */
async function loadSubpagesParallel(context, opts) {
  const {
    firstNavUrl,
    lang,
    needsRestaurantBlock,
    needsSpaBlock,
    needsGolfBlock,
    diningLoadOptions,
    shouldAbort,
    needsGolfAmenityScrape,
  } = opts;

  /** @type {Promise<{ kind: string, value: object }>[]} */
  const jobs = [];

  if (needsRestaurantBlock) {
    jobs.push(
      (async () => {
        throwIfAborted(shouldAbort);
        const sub = await context.newPage();
        try {
          return {
            kind: 'dining',
            value: await readDiningServicesBlock(sub, firstNavUrl, lang, diningLoadOptions),
          };
        } finally {
          await sub.close().catch(() => {});
        }
      })(),
    );
  }
  if (needsSpaBlock) {
    jobs.push(
      (async () => {
        throwIfAborted(shouldAbort);
        const sub = await context.newPage();
        try {
          return { kind: 'spa', value: await readSpaServicesBlock(sub, firstNavUrl, lang) };
        } finally {
          await sub.close().catch(() => {});
        }
      })(),
    );
  }
  if (needsGolfBlock) {
    jobs.push(
      (async () => {
        throwIfAborted(shouldAbort);
        const sub = await context.newPage();
        try {
          const golf = await readGolfServicesBlock(sub, firstNavUrl, lang);
          let amenityData = null;
          if (needsGolfAmenityScrape) {
            try {
              await sub
                .locator('#hotel-amenities')
                .first()
                .waitFor({ state: 'attached', timeout: 12_000 })
                .catch(() => {});
              amenityData = await scrapeGolfAmenityDataOnPage(sub);
            } catch {
              amenityData = null;
            }
          }
          return { kind: 'golf', value: { ...golf, amenityData } };
        } finally {
          await sub.close().catch(() => {});
        }
      })(),
    );
  }

  if (!jobs.length) {
    return { diningRes: null, spaRes: null, golfRes: null };
  }

  const settled = await Promise.all(jobs);
  /** @type {{ diningRes: object|null, spaRes: object|null, golfRes: object|null }} */
  const out = { diningRes: null, spaRes: null, golfRes: null };
  for (const item of settled) {
    if (item.kind === 'dining') {
      out.diningRes = item.value;
    } else if (item.kind === 'spa') {
      out.spaRes = item.value;
    } else if (item.kind === 'golf') {
      out.golfRes = item.value;
    }
  }
  return out;
}

/**
 * Airport / travel blurb under “Local Information” (from DevTools copy → selector).
 * If LHW changes wrapper divs, the shorter fallback still finds `section.local-information p.airport`.
 */
const LOCAL_INFO_AIRPORT_SELECTOR_FULL =
  '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.local-information.alt-bg.pb-5 > div > div.row > div:nth-child(2) > div > p.airport';

const LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK =
  '#main-content section.local-information p.airport';

/**
 * Re-export the shared `normalizeText` (defined in `lib/textNormalize.js`) so
 * the rest of this file (and any external consumers) can keep using the same name.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  return sharedNormalizeText(text);
}

/**
 * Re-export `normalizeSectionLabel` from `lib/textNormalize.js`.
 *
 * @param {string} label
 * @returns {string}
 */
function normalizeSectionLabel(label) {
  return sharedNormalizeSectionLabel(label);
}

/**
 * Excel cells often store CMS HTML; compare using visible text only.
 * @param {string} text
 * @returns {string}
 */
function plainTextFromMaybeHtml(text) {
  return sharedPlainTextFromMaybeHtml(text);
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeTextForCompare(text) {
  return sharedNormalizeTextForCompare(text);
}

/**
 * @param {string} haystack
 * @param {string} needle
 * @returns {boolean}
 */
function compareTextIncludes(haystack, needle) {
  return sharedCompareTextIncludes(haystack, needle);
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
          .filter(
            (p) =>
              !p.closest('.display-quote, .col-12.display-quote') &&
              !p.classList.contains('quote') &&
              !p.classList.contains('quote-name'),
          )
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
 * LHW spa list heading (site markup is typically):
 *   <h3 id="spa-list-title" class="heading-xx-large text-uppercase heading-dark-slate">CORI Spa</h3>
 * Use `h3#spa-list-title` for the name; `#spa-list-title` alone can match a wrapper that still contains `.spa-details`.
 */
const SPA_TITLE_SELECTOR = '#spa-list-title';
/** Canonical heading selector — matches the h3 above. */
const SPA_TITLE_H3_SELECTOR = 'h3#spa-list-title';

/**
 * Read spa list heading text without nested `.spa-details` / prose (some LHW templates nest the body under the same id).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readSpaListTitleText(page) {
  const tryLoc = async (sel) => {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) {
      return '';
    }
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const raw = await loc
      .evaluate((el) => {
        if (!el) {
          return '';
        }
        const c = el.cloneNode(true);
        c.querySelectorAll(
          '.spa-details, .spa-detail, [class*="spa-details"], [class*="spa-detail"]',
        ).forEach((n) => n.remove());
        const it = String(c.innerText || '')
          .replace(/\u00a0/g, ' ')
          .trim();
        const tc = String(c.textContent || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const pick = (it || tc).split(/\r?\n+/)[0].replace(/\s+/g, ' ').trim();
        return pick;
      })
      .catch(() => '');
    const maxHeading = 220;
    if (raw.length > maxHeading) {
      return `${raw.slice(0, maxHeading - 1)}…`;
    }
    return raw;
  };

  await page.waitForTimeout(200);
  const fromH3 = await tryLoc(SPA_TITLE_H3_SELECTOR);
  if (fromH3) {
    return fromH3;
  }
  return tryLoc(SPA_TITLE_SELECTOR);
}

/**
 * LHW spa services page: extract spa **title** (`#spa-list-title`) and **description** (`.spa-details` + fallbacks) separately.
 * `combined` is `title + "\n\n" + description` — same string shape as before for row validation (unchanged behavior).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ title: string, description: string, combined: string }>}
 */
async function extractSpaTitleAndDescriptionParts(page) {
  const raw = await page
    .evaluate((clockPattern) => {
      const clockRe = new RegExp(clockPattern, 'i');
      const hasClockTime = (text) => clockRe.test(String(text || ''));
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

      const readHeadingSansDetails = (el) => {
        if (!el) {
          return '';
        }
        const c = el.cloneNode(true);
        c.querySelectorAll(
          '.spa-details, .spa-detail, [class*="spa-details"], [class*="spa-detail"]',
        ).forEach((n) => n.remove());
        const it = String(c.innerText || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const tc = String(c.textContent || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return it || tc;
      };

      /** LHW list heading is a few words; never prefer the longest match (dup nodes / wrappers can include body copy). */
      const SPA_HEADING_MAX = 220;
      const clipHeading = (s) => {
        const one = String(s || '')
          .split(/\r?\n+/)[0]
          .replace(/\s+/g, ' ')
          .trim();
        if (!one) {
          return '';
        }
        if (one.length > SPA_HEADING_MAX) {
          return `${one.slice(0, SPA_HEADING_MAX - 1)}…`;
        }
        return one;
      };

      const fromH3 = [...document.querySelectorAll('h3#spa-list-title')];
      const fromNonH3Id = [...document.querySelectorAll('#spa-list-title')].filter(
        (e) => e.tagName !== 'H3' && e.tagName !== 'h3',
      );
      const titleCandidates = fromH3.length ? fromH3 : fromNonH3Id;
      const scored = [];
      for (const el of titleCandidates) {
        const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
        const visible = r.width > 0 && r.height > 0;
        const raw = readHeadingSansDetails(el);
        const t = clipHeading(raw);
        if (!t) {
          continue;
        }
        scored.push({ t, len: t.length, visible });
      }
      scored.sort((a, b) => a.len - b.len);
      const visibleOnes = scored.filter((x) => x.visible);
      const pool = visibleOnes.length ? visibleOnes : scored;
      const reasonable = pool.filter((x) => x.len <= SPA_HEADING_MAX);
      let title = (reasonable[0] || pool[0] || scored[0])?.t || '';
      if (!title) {
        const titleEl =
          document.querySelector('h3#spa-list-title') || document.querySelector('#spa-list-title');
        title = clipHeading(readHeadingSansDetails(titleEl));
      }

      let detailsEl = document.querySelector('.spa-details');
      if (!detailsEl) {
        detailsEl =
          document.querySelector('.col-12.col-md-6 .spa-details') ||
          document.querySelector('.col-md-6 .spa-details');
      }
      let desc = pick(detailsEl);

      if (!desc) {
        const h3 =
          document.querySelector('h3#spa-list-title') || document.querySelector('#spa-list-title');
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

      if (title && desc) {
        const d = String(desc).trimStart();
        if (d.startsWith(title)) {
          desc = d.slice(title.length).replace(/^[\s\n:–—-]+/, '').trim();
        }
      }

      const pickParagraphText = (el) => {
        if (!el) {
          return '';
        }
        const raw = el.innerText && String(el.innerText).trim() ? el.innerText : el.textContent;
        return String(raw || '')
          .replace(/\u00a0/g, ' ')
          .split(/\r?\n/)
          .map((line) => line.replace(/[ \t]+/g, ' ').trim())
          .filter(Boolean)
          .join('\n')
          .trim();
      };

      const looksLikeSpaHours = (text) => {
        const t = String(text || '').trim();
        if (!t || t.length < 8 || !hasClockTime(t)) {
          return false;
        }
        const lower = t.toLowerCase();
        if (/breakfast|lunch|dinner|brunch|all-day|bar\s*hours|restaurant|dining/i.test(lower)) {
          return false;
        }
        if (
          /weekday|weekend|wochentag|wochenende|feriale|finesettimana|werktags|samstag|sonntag|sabato|domenica|sábado|domingo|lunes a viernes|nei giorni feriali|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine|fitness|massage|sauna|hammam|thermal|treatment|wellness|\bspa\b|pool|gym|centre|center|bien-etre|bien-être|soins/i.test(
            lower,
          )
        ) {
          return true;
        }
        if (/^(平日|土曜日|日曜日|月曜日|火曜日|水曜日|木曜日|金曜日)/.test(t)) {
          return true;
        }
        return (
          t.length <= 64 &&
          /^[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s./-]{2,48}(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*h)/iu.test(
            t,
          )
        );
      };

      const findSpaHoursInAmenities = () => {
        const amenitySelectors = [
          '#hotel-amenities > section > div.row.extras > div > div > div',
          '#hotel-amenities section div.row.extras div > div > div',
          '#hotel-amenities section div.row.extras',
        ];
        let best = '';
        for (const sel of amenitySelectors) {
          for (const el of document.querySelectorAll(sel)) {
            const t = pickParagraphText(el);
            if (looksLikeSpaHours(t) && t.length > best.length) {
              best = t;
            }
          }
        }
        return best;
      };

      const findSpaHours = () => {
        const fromAmenities = findSpaHoursInAmenities();
        if (fromAmenities) {
          return fromAmenities;
        }
        const root =
          detailsEl?.closest('.tab-page-content') ||
          document.querySelector('#main-content .tab-page-content') ||
          document.querySelector('#main-content') ||
          document.body;
        /** @type {string[]} */
        const lines = [];
        for (const p of root.querySelectorAll('p')) {
          const t = pickParagraphText(p);
          if (looksLikeSpaHours(t)) {
            lines.push(t);
          }
        }
        if (lines.length >= 2) {
          return lines.join('\n');
        }
        if (lines.length === 1) {
          return lines[0];
        }
        return '';
      };

      let hours = findSpaHours();
      if (hours && desc) {
        const descFlat = desc.replace(/\s+/g, ' ').trim();
        const hoursFlat = hours.replace(/\s+/g, ' ').trim();
        if (hoursFlat && descFlat.includes(hoursFlat)) {
          desc = desc
            .replace(hours, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }
      }

      const parts = [];
      if (title) {
        parts.push(title);
      }
      if (desc) {
        parts.push(desc);
      }
      return { title, description: desc, hours, combined: parts.join('\n\n') };
    }, LOCALIZED_CLOCK_TIME_PATTERN)
    .catch(() => ({ title: '', description: '', combined: '' }));

  const title = String(raw?.title || '').trim();
  const description = String(raw?.description || '').trim();
  const hours = normalizeSpaHoursText(raw?.hours || '');
  const combined = String(raw?.combined || '').trim();
  return { title, description, hours, combined };
}

/**
 * Back-compat: returns only the combined title + description string used for substring checks.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function extractSpaTitleAndDetailsText(page) {
  const p = await extractSpaTitleAndDescriptionParts(page);
  return p.combined;
}

/** Keep results table readable when the dining page yields a lot of body text. */
const DINING_ACTUAL_PREVIEW_MAX = 12_000;

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
 * Detect repeated copy (e.g. the same restaurant blurb stitched twice on the page).
 * @param {string} body normalized compare text
 * @param {string} needle normalized compare text
 * @returns {boolean}
 */
function containsDuplicatedSubstring(body, needle) {
  if (needle.length < 24) {
    return false;
  }
  const first = body.indexOf(needle);
  if (first === -1) {
    return false;
  }
  const step = Math.max(12, Math.floor(needle.length * 0.4));
  return body.indexOf(needle, first + step) !== -1;
}

/**
 * When actual contains expected, allow modest trailing CMS lines (chef, phone) but not extra paragraphs.
 * @param {string} body normalized compare text
 * @param {string} exp normalized compare text
 * @returns {boolean}
 */
function actualLengthAcceptableWhenExpectedInActual(body, exp) {
  const maxLen = exp.length + Math.max(48, Math.floor(exp.length * 0.18));
  return body.length <= maxLen;
}

/**
 * When expected contains actual, actual may omit a trailing line from Excel.
 * @param {string} body normalized compare text
 * @param {string} exp normalized compare text
 * @returns {boolean}
 */
function actualLengthAcceptableWhenActualShorter(body, exp) {
  return body.length >= Math.floor(exp.length * 0.88);
}

/**
 * Try to pull the slice of page text that corresponds to the expected string.
 * @param {string} pageText raw innerText from the page
 * @param {string} expected expected copy from Excel
 * @returns {string|null}
 */
function extractMatchingSnippet(pageText, expected) {
  const body = normalizeText(pageText);
  const exp = normalizeText(plainTextFromMaybeHtml(expected));
  if (!exp) {
    return null;
  }
  const bodyCmp = normalizeTextForCompare(body);
  const expCmp = normalizeTextForCompare(exp);
  const idx = bodyCmp.indexOf(expCmp);
  if (idx === -1) {
    return null;
  }
  if (
    containsDuplicatedSubstring(bodyCmp, expCmp) ||
    !actualLengthAcceptableWhenExpectedInActual(bodyCmp, expCmp)
  ) {
    return null;
  }
  return body.slice(idx, idx + exp.length);
}

function textsMatchExpectedStrict(actual, expected) {
  const body = normalizeTextForCompare(actual);
  const exp = normalizeTextForCompare(plainTextFromMaybeHtml(expected));
  if (!body || !exp) {
    return false;
  }
  if (body === exp) {
    return true;
  }
  if (containsDuplicatedSubstring(body, exp)) {
    return false;
  }
  const maxLen = Math.max(body.length, exp.length);
  const diff = Math.abs(body.length - exp.length);
  const tolerance = Math.max(24, Math.floor(maxLen * 0.03));
  if (diff > tolerance) {
    return false;
  }
  return body.includes(exp) || exp.includes(body);
}

/**
 * Match CMS / locale copy without treating duplicated or heavily padded actual text as equal.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function textsMatchExpected(actual, expected) {
  const body = normalizeTextForCompare(actual);
  const exp = normalizeTextForCompare(plainTextFromMaybeHtml(expected));
  if (!body || !exp) {
    return false;
  }
  if (body === exp) {
    return true;
  }

  if (body.includes(exp)) {
    if (containsDuplicatedSubstring(body, exp)) {
      return false;
    }
    return actualLengthAcceptableWhenExpectedInActual(body, exp);
  }

  if (exp.includes(body)) {
    if (exp.indexOf(body) !== 0) {
      return false;
    }
    return actualLengthAcceptableWhenActualShorter(body, exp);
  }

  if (exp.length >= 100) {
    const cjkCount = (s) => (String(s).match(/[\u3040-\u30ff\u4e00-\u9fff]/g) || []).length;
    if (cjkCount(body) >= 40 || cjkCount(exp) >= 40) {
      return textsMatchExpectedStrict(actual, expected);
    }
    return false;
  }

  const anchorLen = Math.min(60, exp.length);
  if (anchorLen >= 12) {
    const anchor = exp.slice(0, anchorLen);
    if (body.includes(anchor)) {
      if (containsDuplicatedSubstring(body, anchor)) {
        return false;
      }
      return actualLengthAcceptableWhenExpectedInActual(body, exp);
    }
  }
  return false;
}

/**
 * Which special-notice block (0-based) contains the expected copy, if any.
 * @param {string[]} messages
 * @param {string} expectedText
 * @returns {number}
 */
function specialNoticeBlockIndexForExpected(messages, expectedText) {
  if (!messages?.length) {
    return -1;
  }
  const exp = normalizeText(plainTextFromMaybeHtml(expectedText));
  if (exp.length < 6) {
    return -1;
  }
  for (let i = 0; i < messages.length; i++) {
    if (textsMatchExpected(messages[i], expectedText)) {
      return i;
    }
  }
  return -1;
}

/**
 * @param {string[]} messages
 * @param {object} opts
 * @param {number} opts.ordinal 1-based label index (Special Notice #N)
 * @param {string} opts.expected
 * @param {Set<number>} opts.usedIndices
 * @param {number} opts.contentIndex block index from expected-text match, if any
 * @param {boolean} [opts.labelHasNumber] true when column A includes #N (Special Notice #2)
 * @returns {{ text: string, index: number }}
 */
function resolveSpecialNoticeBlock(
  messages,
  { ordinal = 0, expected = '', usedIndices = null, contentIndex = -1, labelHasNumber = false },
) {
  if (!messages?.length) {
    return { text: '', index: -1 };
  }
  const used = usedIndices || null;
  const isUsed = (index) => Boolean(used && used.has(index));

  if (labelHasNumber && ordinal > 0 && messages[ordinal - 1]) {
    return { text: messages[ordinal - 1], index: ordinal - 1 };
  }

  if (contentIndex >= 0 && messages[contentIndex] && !isUsed(contentIndex)) {
    return { text: messages[contentIndex], index: contentIndex };
  }

  if (ordinal > 0 && messages[ordinal - 1] && !isUsed(ordinal - 1)) {
    return { text: messages[ordinal - 1], index: ordinal - 1 };
  }

  const expectedNorm = normalizeText(plainTextFromMaybeHtml(expected));
  if (expectedNorm.length >= 6) {
    for (let i = 0; i < messages.length; i++) {
      if (isUsed(i)) {
        continue;
      }
      if (textsMatchExpected(messages[i], expected)) {
        return { text: messages[i], index: i };
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (!isUsed(i)) {
      return { text: messages[i], index: i };
    }
  }

  return { text: messages[0] || '', index: 0 };
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
 * Spa hours row labels (no cross-calls to dining/restaurant helpers — avoids recursion).
 * @param {string} s normalized section label
 * @returns {boolean}
 */
function spaHoursLabelMatches(s) {
  if (!s) {
    return false;
  }
  const hasHours =
    /\bhours\b/i.test(s) ||
    /\bhours\s+of\s+operation\b/i.test(s) ||
    /\boperation\s+hours\b/i.test(s) ||
    /\bopening\s+hours\b/i.test(s);
  if (!hasHours) {
    return false;
  }
  return (
    /\bspa\b/i.test(s) ||
    /\bwellness\b/i.test(s) ||
    /\bfitness\s+center\b/i.test(s) ||
    /\b(?:massage|sauna|hammam|thermal)\b/i.test(s)
  );
}

/**
 * Dining hours row labels (uses `spaHoursLabelMatches` only — no `isSpaHoursSectionLabel`).
 * @param {string} s normalized section label
 * @returns {boolean}
 */
function diningOperationHoursLabelMatches(s) {
  if (!s) {
    return false;
  }
  if (/property\s*highlight/i.test(s) || /property\s*search/i.test(s) || /local\s*information/i.test(s)) {
    return false;
  }
  if (spaHoursLabelMatches(s)) {
    return false;
  }
  return (
    /^hours\s+of\s+operation$/i.test(s) ||
    /^operation\s+hours$/i.test(s) ||
    /^opening\s+hours$/i.test(s) ||
    /^dining\s+hours$/i.test(s) ||
    /\bhours\s+of\s+operation\b/i.test(s) ||
    /\boperation\s+hours\b/i.test(s) ||
    /restaurant\s*#?\s*\d+.*\bhours\b/i.test(s) ||
    /\bhours\b.*restaurant\s*#?\s*\d+/i.test(s)
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
  if (diningOperationHoursLabelMatches(s)) {
    return false;
  }
  if (isDiningOverviewSectionLabel(s)) {
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
 * Excel column A: operation hours from `motion.div.hours` on the dining subpage.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isDiningOperationHoursSectionLabel(sectionLabel) {
  return diningOperationHoursLabelMatches(normalizeSectionLabel(sectionLabel));
}

/**
 * Excel column A: hotel property overview description (`section.property-overview`).
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isHotelPropertyOverviewSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  return (
    /^overview$/i.test(s) ||
    /^property\s*overview$/i.test(s) ||
    /^hotel\s*overview$/i.test(s)
  );
}

/**
 * Excel column A: subheader quote (`.subheader.font-amiri`) on the hotel overview tab.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isHotelPropertyQuoteSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  return (
    /^quot(e)?$/i.test(s) ||
    /^subheader$/i.test(s) ||
    /^tagline$/i.test(s) ||
    /^property\s*quote$/i.test(s)
  );
}

/**
 * Excel column A: dining page intro / overview (above individual restaurant cards).
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isDiningOverviewSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (isHotelPropertyOverviewSectionLabel(s)) {
    return false;
  }
  if (diningOperationHoursLabelMatches(s)) {
    return false;
  }
  if (/restaurant\s*#?\s*\d+/i.test(s)) {
    return false;
  }
  if (/\bname\b/i.test(s) && !/\bdescription\b/i.test(s)) {
    return false;
  }
  if (/\bdescription\b/i.test(s)) {
    return false;
  }
  return (
    /^dining\s*overview$/i.test(s) ||
    /^dining\s*introduction$/i.test(s) ||
    /^dining\s*intro$/i.test(s) ||
    /^gastronom\w*\s*overview$/i.test(s) ||
    /^dining\s*description$/i.test(s) ||
    /^dining$/i.test(s)
  );
}

/**
 * 1-based restaurant index from “Restaurant #2 Hours of Operation”, etc.
 * @param {string} sectionLabel
 * @returns {number}
 */
function diningHoursOrdinalFromLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  const patterns = [
    /restaurant\s*#?\s*(\d+)/i,
    /\boutlet\s*#?\s*(\d+)/i,
    /#\s*(\d+)\s*[-–—]?\s*(?:hours|operation)/i,
    /(?:hours|operation).*#\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }
  }
  return 0;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isHoursSectionLabelText(text) {
  const t = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
  return (
    t === 'hours of operation' ||
    t === 'operation hours' ||
    t === 'opening hours' ||
    t === 'dining hours' ||
    t === 'restaurant hours' ||
    t === 'hours' ||
    t === 'horario de atencion' ||
    t === 'horarios de atencion' ||
    t === 'offnungszeiten' ||
    t === 'oeffnungszeiten' ||
    t === 'offnungszeit' ||
    t === 'oeffnungszeit' ||
    t === 'orario di apertura' ||
    t === 'orari di apertura' ||
    t === 'horaire d ouverture' ||
    t === 'horaire d\'ouverture' ||
    t === 'horaires d ouverture' ||
    t === 'horaires d\'ouverture' ||
    t === '営業時間'
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeOutletNameForMatch(text) {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const GENERIC_OUTLET_NAME_WORDS = new Set([
  'all',
  'and',
  'au',
  'bar',
  'cafe',
  'café',
  'caffe',
  'caffè',
  'day',
  'de',
  'del',
  'dining',
  'du',
  'fine',
  'la',
  'le',
  'les',
  'palace',
  'palacio',
  'palast',
  'restaurant',
  'restaurante',
  'ristorante',
  'spa',
  'terrace',
  'terrasse',
  'the',
  'to',
]);

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function outletNameTokenSet(text) {
  return new Set(
    normalizeOutletNameForMatch(text)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !GENERIC_OUTLET_NAME_WORDS.has(token)),
  );
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function distinctiveOutletNameTokens(text) {
  return outletNameTokenSet(text);
}

/**
 * @param {string} actualName
 * @param {string} wantedName
 * @returns {boolean}
 */
function outletNamesLikelyMatch(actualName, wantedName) {
  const actual = normalizeOutletNameForMatch(actualName);
  const wanted = normalizeOutletNameForMatch(wantedName);
  if (actual.length < 2 || wanted.length < 2) {
    return false;
  }
  if (actual === wanted || actual.includes(wanted) || wanted.includes(actual)) {
    return true;
  }

  const actualTokens = distinctiveOutletNameTokens(actualName);
  const wantedTokens = distinctiveOutletNameTokens(wantedName);
  if (!actualTokens.size || !wantedTokens.size) {
    return false;
  }

  let wantedInActual = true;
  for (const token of wantedTokens) {
    if (!actualTokens.has(token)) {
      wantedInActual = false;
      break;
    }
  }
  let actualInWanted = true;
  for (const token of actualTokens) {
    if (!wantedTokens.has(token)) {
      actualInWanted = false;
      break;
    }
  }
  if (wantedInActual || actualInWanted) {
    return true;
  }

  let shared = 0;
  for (const token of wantedTokens) {
    if (actualTokens.has(token)) {
      shared += 1;
    }
  }
  if (!shared) {
    return false;
  }
  const minDistinct = Math.min(actualTokens.size, wantedTokens.size);
  if (shared >= minDistinct) {
    return true;
  }
  return false;
}

/**
 * Strip Excel dining labels down to a probable outlet name (not sheet position).
 * @param {string} sectionLabel
 * @returns {string}
 */
function diningOutletNameHintsFromSectionLabel(sectionLabel) {
  let s = normalizeSectionLabel(sectionLabel);
  s = s.replace(/restaurant\s*#?\s*\d+/gi, ' ');
  s = s.replace(/\boutlet\s*#?\s*\d+/gi, ' ');
  s = s.replace(/#\s*\d+/g, ' ');
  const stripPatterns = [
    /\bhours\s+of\s+operation\b/gi,
    /\boperation\s+hours\b/gi,
    /\bopening\s+hours\b/gi,
    /\bdining\s+hours\b/gi,
    /\brestaurant\s+hours\b/gi,
    /\bdescription\b/gi,
    /\brestaurant\s+name\b/gi,
    /\bname\b/gi,
    /\brestaurant\b/gi,
    /\brestaurante\b/gi,
    /\bristorante\b/gi,
    /\bdining\b/gi,
    /\bgastronom\w*\b/gi,
  ];
  for (const re of stripPatterns) {
    s = s.replace(re, ' ');
  }
  return normalizeText(s);
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
function uniqueNormalizedNames(names) {
  /** @type {string[]} */
  const out = [];
  for (const raw of names || []) {
    const text = String(raw || '').trim();
    if (!normalizeText(text)) {
      continue;
    }
    if (!out.some((existing) => normalizeText(existing) === normalizeText(text))) {
      out.push(text);
    }
  }
  return out;
}

/**
 * Build title candidates for the active language — localized names before English fallbacks.
 * @param {object} opts
 * @param {string} opts.lang
 * @param {boolean} opts.isNameRow
 * @param {string} opts.expected
 * @param {{ localizedNames?: string[], englishNames?: string[] }} opts.context
 * @param {string} opts.currentDiningOutletName
 * @param {string} opts.labelHint
 * @returns {{ localizedNames: string[], englishNames: string[] }}
 */
function buildDiningTitleCandidates(opts) {
  const context = opts.context || {};
  const localized = uniqueNormalizedNames([
    ...(opts.isNameRow ? [opts.expected] : []),
    ...(context.localizedNames || []),
    ...(opts.isNameRow ? [] : [opts.currentDiningOutletName]),
    opts.labelHint,
  ]);
  const english = uniqueNormalizedNames([...(context.englishNames || [])]);
  if (String(opts.lang || '').toUpperCase() === 'ENG') {
    return {
      localizedNames: uniqueNormalizedNames([...english, ...localized]),
      englishNames: [],
    };
  }
  return { localizedNames: localized, englishNames: english };
}

/**
 * @param {{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null} diningOutlets
 * @param {number} index
 * @returns {{ name: string, text: string, description?: string, hours?: string } | null}
 */
function diningOutletAtIndex(diningOutlets, index) {
  if (!diningOutlets?.outlets?.length || index < 0) {
    return null;
  }
  return diningOutlets.outlets[index] || null;
}

/**
 * @param {{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null} diningOutlets
 * @param {Map<number, number>} indexByOrdinal
 * @param {number} ordinal
 * @returns {{ name: string, text: string, description?: string, hours?: string } | null}
 */
function diningOutletBoundToOrdinal(diningOutlets, indexByOrdinal, ordinal) {
  if (!ordinal || !indexByOrdinal.has(ordinal)) {
    return null;
  }
  return diningOutletAtIndex(diningOutlets, indexByOrdinal.get(ordinal));
}

/**
 * Remember which scraped outlet belongs to Restaurant #N for this language run.
 * @param {{ outlets: object[] } | null} diningOutlets
 * @param {Map<number, number>} indexByOrdinal
 * @param {number} ordinal
 * @param {{ name?: string } | null} outlet
 */
function bindDiningOutletOrdinal(diningOutlets, indexByOrdinal, ordinal, outlet) {
  if (!outlet || !ordinal || !diningOutlets?.outlets?.length) {
    return;
  }
  let idx = diningOutlets.outlets.indexOf(outlet);
  if (idx < 0 && outlet.name) {
    idx = diningOutlets.outlets.findIndex((candidate) =>
      outletNamesLikelyMatch(candidate.name, outlet.name),
    );
  }
  if (idx >= 0) {
    indexByOrdinal.set(ordinal, idx);
  }
}

/**
 * @param {{ outlets: { name: string, hours: string }[] } | null} operationHours
 * @param {string} outletName
 * @returns {string}
 */
function pickOperationHoursByOutletName(operationHours, outletName) {
  if (!operationHours?.outlets?.length) {
    return '';
  }
  const wanted = normalizeOutletNameForMatch(outletName);
  if (wanted.length < 3) {
    return '';
  }
  for (const o of operationHours.outlets) {
    if (outletNamesLikelyMatch(o.name, outletName)) {
      return o.hours;
    }
  }
  return '';
}

/**
 * @param {{ name?: string, description?: string, text?: string }} [outlet]
 * @param {string} [expected]
 * @returns {string}
 */
function pickDiningOutletDisplayName(outlet, expected = '') {
  if (!outlet) {
    return '';
  }
  const name = String(outlet.name || '').trim();
  if (name) {
    return name;
  }
  return String(outlet.text || '').trim().split(/\r?\n/)[0] || '';
}

/**
 * @param {{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null} diningOutlets
 * @param {object} signals
 * @param {number} [signals.ordinal]
 * @param {string} [signals.sectionLabel]
 * @param {string[]} [signals.names]
 * @param {string[]} [signals.descriptions]
 * @param {string} [signals.expectedHours]
 * @param {string} [signals.expectedText]
 * @param {boolean} [signals.allowOrdinalFallback] When true, fall back to scraped list position for sheet #N (dining rows keep this false — match by name/hours/description instead of site order)
 * @param {boolean} [signals.matchOutletNameOnly] Restaurant name row — match by name/ordinal, not prior outlet or description bleed
 * @returns {{ name: string, text: string, description?: string, hours?: string } | null}
 */
function pickDiningOutletBySignals(diningOutlets, signals = {}) {
  if (!diningOutlets?.outlets?.length) {
    return null;
  }

  const outlets = diningOutlets.outlets;
  if (outlets.length === 1) {
    return outlets[0];
  }

  const matchByTitle = Boolean(signals.matchOutletNameOnly || signals.matchByTitle);
  if (matchByTitle) {
    const localizedNames = uniqueNormalizedNames(
      signals.localizedNames || (Array.isArray(signals.names) ? signals.names : []),
    );
    const englishNames = uniqueNormalizedNames(signals.englishNames || []);
    const labelHint = diningOutletNameHintsFromSectionLabel(signals.sectionLabel || '');
    const expectedName = plainTextFromMaybeHtml(signals.expectedText || '');

    for (const wantedRaw of englishNames) {
      for (const outlet of outlets) {
        if (
          textsMatchOutletTitle(outlet.name, wantedRaw) ||
          outletNamesLikelyMatch(outlet.name, wantedRaw)
        ) {
          return outlet;
        }
      }
    }

    for (const wantedRaw of localizedNames) {
      for (const outlet of outlets) {
        if (
          textsMatchOutletTitle(outlet.name, wantedRaw) ||
          outletNamesLikelyMatch(outlet.name, wantedRaw)
        ) {
          return outlet;
        }
      }
    }

    if (labelHint) {
      for (const outlet of outlets) {
        if (
          textsMatchOutletTitle(outlet.name, labelHint) ||
          outletNamesLikelyMatch(outlet.name, labelHint)
        ) {
          return outlet;
        }
      }
    }

    if (normalizeText(expectedName)) {
      for (const outlet of outlets) {
        if (
          textsMatchOutletTitle(outlet.name, expectedName) ||
          outletNamesLikelyMatch(outlet.name, expectedName)
        ) {
          return outlet;
        }
      }
    }

    const ordinal = Number(signals.ordinal || 0);
    const sheetRestaurantCount = Number(signals.sheetRestaurantCount || 0);
    const outletCountMatchesSheet =
      !sheetRestaurantCount || sheetRestaurantCount === outlets.length;
    if (
      signals.allowOrdinalFallback &&
      ordinal > 0 &&
      outletCountMatchesSheet &&
      outlets[ordinal - 1]
    ) {
      return outlets[ordinal - 1];
    }

    return null;
  }

  const expectedHours = normalizeText(signals.expectedHours || '');
  const labelHint = diningOutletNameHintsFromSectionLabel(signals.sectionLabel || '');
  const rawNames = [
    ...(Array.isArray(signals.names) ? signals.names : []),
    labelHint,
  ].filter((name) => normalizeText(name));

  // Hours rows: match schedule content before any name hint — otherwise the first
  // restaurant name in the sheet catalog wins (e.g. Long Bar expected vs outlet #1 actual).
  if (expectedHours.length >= 4) {
    for (const outlet of outlets) {
      if (
        textsMatchOperationHours(outlet.hours, expectedHours) ||
        compareTextIncludes(outlet.hours, expectedHours)
      ) {
        return outlet;
      }
    }
  }

  for (const wantedRaw of rawNames) {
    for (const outlet of outlets) {
      if (outletNamesLikelyMatch(outlet.name, wantedRaw)) {
        return outlet;
      }
    }
  }

  const expectedBody = normalizeText(
    plainTextFromMaybeHtml(signals.expectedText || signals.expectedHours || ''),
  );
  if (expectedBody.length >= 8) {
    if (expectedHours.length >= 4) {
      for (const outlet of outlets) {
        if (
          textsMatchOperationHours(outlet.hours, expectedHours) ||
          compareTextIncludes(outlet.hours, expectedBody)
        ) {
          return outlet;
        }
      }
    } else {
      for (const outlet of outlets) {
        const chunks = [outlet.description, outlet.text, outlet.hours, outlet.name].filter(Boolean);
        for (const chunk of chunks) {
          if (textsMatchExpected(chunk, expectedBody)) {
            return outlet;
          }
        }
      }
      for (const outlet of outlets) {
        if (
          compareTextIncludes(outlet.hours, expectedBody) ||
          compareTextIncludes(outlet.description, expectedBody) ||
          compareTextIncludes(outlet.text, expectedBody)
        ) {
          return outlet;
        }
      }
    }
  }

  const descriptions = Array.isArray(signals.descriptions) ? signals.descriptions : [];
  if (!expectedHours.length) {
    for (const description of descriptions) {
      const wanted = normalizeText(description);
      if (wanted.length < 20) {
        continue;
      }
      for (const outlet of outlets) {
        if (
          textsMatchExpected(outlet.description || outlet.text, wanted) ||
          compareTextIncludes(outlet.description, wanted) ||
          compareTextIncludes(outlet.text, wanted)
        ) {
          return outlet;
        }
      }
    }
  }

  const ordinal = Number(signals.ordinal || 0);
  if (signals.allowOrdinalFallback && ordinal > 0 && outlets[ordinal - 1]) {
    return outlets[ordinal - 1];
  }

  return null;
}

/**
 * @param {{ outlets: { name: string, hours: string }[] } | null} operationHours
 * @param {number} [ordinal] 1-based outlet index from Excel label
 * @param {string} [sectionLabel] Column A label (outlet name / restaurant #)
 * @param {string} [preferredOutletName] Nearby Excel restaurant name row.
 * @returns {string}
 */
function pickOperationHoursText(
  operationHours,
  ordinal = 0,
  sectionLabel = '',
  preferredOutletName = '',
  expectedHours = '',
) {
  if (!operationHours?.outlets?.length) {
    return '';
  }
  const outlets = operationHours.outlets;

  if (outlets.length === 1) {
    return outlets[0].hours;
  }

  const expectedNorm = normalizeTextForCompare(plainTextFromMaybeHtml(expectedHours));
  if (expectedNorm.length >= 4) {
    for (const outlet of outlets) {
      if (textsMatchOperationHours(outlet.hours, expectedHours) || compareTextIncludes(outlet.hours, expectedHours)) {
        return outlet.hours;
      }
    }
  }

  const labelHint = diningOutletNameHintsFromSectionLabel(sectionLabel);
  for (const wanted of [preferredOutletName, labelHint, sectionLabel]) {
    const byName = pickOperationHoursByOutletName(operationHours, wanted);
    if (byName) {
      return byName;
    }
  }

  return '';
}

/**
 * @param {{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null} diningOutlets
 * @param {number} [ordinal] 1-based outlet index from Excel label
 * @param {string} [sectionLabel] Column A label (outlet name / restaurant #)
 * @param {string} [preferredOutletName] Nearby Excel restaurant name row.
 * @returns {string}
 */
function pickDiningOutletText(
  diningOutlets,
  ordinal = 0,
  sectionLabel = '',
  preferredOutletName = '',
  extraSignals = {},
) {
  const outlet = pickDiningOutletBySignals(diningOutlets, {
    ordinal,
    sectionLabel,
    names: [preferredOutletName, ...(extraSignals.names || [])],
    localizedNames: extraSignals.localizedNames,
    englishNames: extraSignals.englishNames,
    descriptions: extraSignals.descriptions,
    expectedText: extraSignals.expectedText,
    expectedHours: extraSignals.expectedHours,
    allowOrdinalFallback: extraSignals.allowOrdinalFallback,
    matchByTitle: extraSignals.matchByTitle,
    matchOutletNameOnly: extraSignals.matchByTitle,
  });
  return outlet?.text || '';
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
  if (isDiningOperationHoursSectionLabel(s)) {
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

/** @param {string} sectionLabel */
function isSpaDescriptionSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  return /\bspa\b/i.test(s) && /\bdescription\b/i.test(s) && !/\b(?:title|name)\b/i.test(s);
}

/**
 * Excel column A: spa / wellness hours on `/services-amenities/spa` (e.g. Weekdays + Fitness Center times in a `<p>`).
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isSpaHoursSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (/restaurant/i.test(s) && !/\bspa\b/i.test(s) && !/\bwellness\b/i.test(s)) {
    return false;
  }
  return spaHoursLabelMatches(s);
}

/**
 * Generic “Hours of Operation” (no spa/restaurant qualifier) — often spa/fitness on `#hotel-amenities`.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isGenericOperationHoursSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (/restaurant|outlet\s*#|\boutlet\b.*\bhours\b/i.test(s)) {
    return false;
  }
  if (spaHoursLabelMatches(s)) {
    return false;
  }
  return isHoursSectionLabelText(s);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeDiningHoursContent(text) {
  const t = normalizeText(text);
  if (!t || !hasLocalizedClockTime(t)) {
    return false;
  }
  const lower = t.toLowerCase();
  return (
    /breakfast|lunch|dinner|brunch|all-day|bar\s*hours|restaurant|dining|gastronom|abendessen|mittagessen|frühstück/i.test(
      lower,
    )
  );
}

/**
 * One spa schedule line (weekday label + clock times), not a dining meal block.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeSpaScheduleLine(text) {
  const t = normalizeText(text);
  if (!t || t.length < 8 || !hasLocalizedClockTime(t)) {
    return false;
  }
  if (looksLikeDiningHoursContent(t)) {
    return false;
  }
  const lower = t.toLowerCase();
  if (
    /weekday|weekend|wochentag|wochenende|feriale|finesettimana|werktags|samstag|sonntag|sabato|domenica|sábado|domingo|lunes a viernes|nei giorni feriali|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|ferie|férié|semaine|jours ouvrables|fitness|massage|sauna|hammam|thermal|treatment|wellness|\bspa\b|pool|gym|centre|center|sanitas|bien-etre|bien-être|soins/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (/^(平日|土曜日|日曜日|月曜日|火曜日|水曜日|木曜日|金曜日)/.test(t)) {
    return true;
  }
  if (
    t.length <= 64 &&
    /^[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s./-]{2,48}(\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*h)/iu.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Wellness / spa schedule (not restaurant meal times).
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeSpaHoursContent(text) {
  const raw = normalizeText(text);
  if (!raw) {
    return false;
  }
  const lines = raw.split(/\r?\n/).map((line) => normalizeText(line)).filter(Boolean);
  if (lines.length > 1) {
    const scheduleLines = lines.filter(looksLikeSpaScheduleLine);
    return scheduleLines.length >= 2 || (scheduleLines.length === 1 && lines.length <= 3);
  }
  return looksLikeSpaScheduleLine(raw);
}

/**
 * @param {string} actual
 * @param {string} expected
 * @param {string} [englishExpected]
 * @returns {boolean}
 */
function compactSpaTitleForCompare(text) {
  return normalizeText(plainTextFromMaybeHtml(text))
    .replace(/[\s・·\u30fb\-–—:：]/g, '')
    .toLowerCase();
}

/**
 * Case- and accent-insensitive title match (golf course, restaurant, spa names).
 * @param {string} text
 * @returns {string}
 */
function compactOutletTitleForCompare(text) {
  return normalizeText(plainTextFromMaybeHtml(text))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s・·\u30fb\-–—:：'’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Title rows — same words pass regardless of capitalization / accents.
 * @param {string} actual
 * @param {string} expected
 * @param {string} [englishExpected]
 * @returns {boolean}
 */
function textsMatchOutletTitle(actual, expected, englishExpected = '') {
  if (textsMatchExpected(actual, expected) || textsMatchExpectedStrict(actual, expected)) {
    return true;
  }
  const compactActual = compactOutletTitleForCompare(actual);
  const compactExpected = compactOutletTitleForCompare(expected);
  if (
    compactActual &&
    compactExpected &&
    (compactActual === compactExpected ||
      compactActual.includes(compactExpected) ||
      compactExpected.includes(compactActual))
  ) {
    return true;
  }
  if (outletNamesLikelyMatch(actual, expected)) {
    return true;
  }
  const eng = compactOutletTitleForCompare(englishExpected);
  if (eng && (compactActual === eng || compactActual.includes(eng) || eng.includes(compactActual))) {
    return true;
  }
  return false;
}

/**
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function katakanaSpaNamesLikelyMatch(actual, expected) {
  const kata = (s) => (normalizeText(s).match(/[\u30a0-\u30ff]+/g) || []).join('');
  const a = kata(actual);
  const b = kata(expected);
  if (!a || !b || (!a.includes('スパ') && !b.includes('スパ'))) {
    return false;
  }
  const rootA = a.replace(/スパ/g, '');
  const rootB = b.replace(/スパ/g, '');
  if (rootA.length >= 2 && rootB.length >= 2) {
    const shorter = rootA.length <= rootB.length ? rootA : rootB;
    const longer = rootA.length <= rootB.length ? rootB : rootA;
    return longer.includes(shorter) || shorter.slice(0, 2) === longer.slice(0, 2);
  }
  return false;
}

/**
 * Spa title rows — allow katakana spacing variants (ゲランスパ vs ゲラン・スパ) and English fallback.
 * @param {string} actual
 * @param {string} expected
 * @param {string} [englishExpected]
 * @returns {boolean}
 */
function textsMatchSpaTitle(actual, expected, englishExpected = '') {
  if (textsMatchExpected(actual, expected) || textsMatchExpectedStrict(actual, expected)) {
    return true;
  }
  const compactActual = compactSpaTitleForCompare(actual);
  const compactExpected = compactSpaTitleForCompare(expected);
  if (
    compactActual &&
    compactExpected &&
    (compactActual === compactExpected ||
      compactActual.includes(compactExpected) ||
      compactExpected.includes(compactActual))
  ) {
    return true;
  }
  if (katakanaSpaNamesLikelyMatch(actual, expected)) {
    return true;
  }
  const eng = normalizeText(plainTextFromMaybeHtml(englishExpected)).toLowerCase();
  const act = normalizeText(actual).toLowerCase();
  if (eng && (act === eng || act.includes(eng) || eng.includes(act))) {
    return true;
  }
  if (englishExpected && katakanaSpaNamesLikelyMatch(actual, englishExpected)) {
    return true;
  }
  return false;
}

/**
 * @param {{ outlets: { name: string, hours: string }[] } | null} operationHours
 * @param {string} expected
 * @returns {boolean}
 */
function expectedMatchesDiningOutlet(operationHours, expected) {
  const exp = plainTextFromMaybeHtml(expected);
  if (!normalizeText(exp) || !operationHours?.outlets?.length) {
    return false;
  }
  for (const outlet of operationHours.outlets) {
    const chunks = [outlet.hours, outlet.name ? `${outlet.name}\n${outlet.hours}` : ''].filter(
      Boolean,
    );
    for (const chunk of chunks) {
      if (textsMatchOperationHours(chunk, exp) || compareTextIncludes(chunk, exp)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Spa hours row when label says spa/wellness, or generic “Hours of Operation” whose expected
 * copy matches spa/wellness (not restaurant meal times).
 * @param {string} sectionLabel
 * @param {string} [hotelAmenitiesHours]
 * @param {string} [expected]
 * @param {string} [spaHoursFromPage]
 * @param {{ outlets: { name: string, hours: string }[] } | null} [operationHours]
 * @returns {boolean}
 */
function isSpaHoursRowLabel(
  sectionLabel,
  hotelAmenitiesHours = '',
  expected = '',
  spaHoursFromPage = '',
  operationHours = null,
) {
  const label = normalizeSectionLabel(sectionLabel);
  if (isSpaHoursSectionLabel(sectionLabel)) {
    return true;
  }
  if (/\bspa\b/i.test(label) && /\bhours\b/i.test(label)) {
    return true;
  }
  if (diningHoursOrdinalFromLabel(sectionLabel) > 0) {
    return false;
  }
  if (/restaurant/i.test(label) && !/\bspa\b/i.test(label)) {
    return false;
  }

  const exp = plainTextFromMaybeHtml(expected);
  const spaHours = pickBestSpaHoursText(spaHoursFromPage, hotelAmenitiesHours);

  if (expectedMatchesDiningOutlet(operationHours, exp)) {
    return false;
  }
  if (looksLikeDiningHoursContent(exp) && !looksLikeSpaHoursContent(exp)) {
    return false;
  }

  if (
    (looksLikeSpaHoursContent(exp) && !looksLikeGolfHoursContent(exp)) ||
    (looksLikeSpaHoursContent(hotelAmenitiesHours) && !looksLikeGolfHoursContent(exp))
  ) {
    return true;
  }

  if (normalizeText(spaHours) && normalizeText(exp)) {
    if (textsMatchOperationHours(spaHours, exp) || compareTextIncludes(spaHours, exp)) {
      return true;
    }
  }

  if (
    isGenericOperationHoursSectionLabel(sectionLabel) &&
    normalizeText(spaHours) &&
    !expectedMatchesDiningOutlet(operationHours, exp) &&
    !looksLikeGolfHoursContent(exp)
  ) {
    return true;
  }

  return false;
}

/**
 * @param {...string} candidates
 * @returns {string}
 */
function pickBestSpaHoursText(...candidates) {
  const scored = candidates
    .map((c) => normalizeSpaHoursText(String(c || '')))
    .filter((t) => normalizeText(t));
  if (!scored.length) {
    return '';
  }
  scored.sort((a, b) => b.length - a.length);
  const spaLike = scored.filter((t) => looksLikeSpaHoursContent(t));
  if (spaLike.length) {
    return spaLike[0];
  }
  const timedNonDining = scored.filter(
    (t) => hasLocalizedClockTime(t) && !looksLikeDiningHoursContent(t),
  );
  return timedNonDining[0] || scored[0];
}

/**
 * @param {{ byLang: Record<string, string> }} row
 * @param {string} lang
 * @returns {string}
 */
function expectedTextForRow(row, lang) {
  return String(row.byLang?.[lang] || row.byLang?.ENG || '').trim();
}

/**
 * @param {{ section: string, byLang: Record<string, string> }} row
 * @param {string} lang
 * @param {string} [hotelAmenitiesHours]
 * @returns {boolean}
 */
function searchableRowNeedsDiningSubpage(row, lang, hotelAmenitiesHours = '') {
  const section = row.section;
  const expected = expectedTextForRow(row, lang);
  if (isDiningOverviewSectionLabel(section)) {
    return true;
  }
  if (isRestaurantSectionLabel(section)) {
    return true;
  }
  if (!isDiningOperationHoursSectionLabel(section)) {
    return false;
  }
  return !isSpaHoursRowLabel(section, hotelAmenitiesHours, expected, '', null);
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readSpaHoursOnCurrentPage(page) {
  const parts = await extractSpaTitleAndDescriptionParts(page);
  let hours = normalizeSpaHoursText(parts.hours || '');
  if (normalizeText(hours)) {
    return hours;
  }
  return page
    .evaluate((clockPattern) => {
      const pick = (el) => {
        if (!el) {
          return '';
        }
        const raw = el.innerText && String(el.innerText).trim() ? el.innerText : el.textContent;
        return String(raw || '')
          .replace(/\u00a0/g, ' ')
          .split(/\r?\n/)
          .map((line) => line.replace(/[ \t]+/g, ' ').trim())
          .filter(Boolean)
          .join('\n')
          .trim();
      };
      const clockRe = new RegExp(clockPattern, 'i');
      const hasTime = (t) => clockRe.test(t);
      const isDining = (t) => /breakfast|lunch|dinner|brunch|bar\s*hours|restaurant/i.test(t);
      const isSpaish = (t) =>
        /weekday|weekend|wochentag|fitness|massage|sauna|hammam|wellness|\bspa\b|pool|gym|werktags|samstag|sonntag|sabato|domenica|sábado|domingo|lunes a viernes|nei giorni feriali|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine|bien-etre|bien-être|soins|平日|土曜日|日曜日|月曜日|火曜日|水曜日|木曜日|金曜日/i.test(
          t,
        );
      let best = '';
      /** @type {string[]} */
      const scheduleLines = [];
      const root =
        document.querySelector('#main-content .tab-page-content') ||
        document.querySelector('#main-content') ||
        document.body;
      for (const p of root.querySelectorAll('p, div.hours, .spa-details')) {
        const t = pick(p);
        if (!hasTime(t) || isDining(t)) {
          continue;
        }
        if (isSpaish(t)) {
          scheduleLines.push(t);
        } else if (t.length > best.length) {
          best = t;
        }
      }
      if (scheduleLines.length >= 2) {
        return scheduleLines.join('\n');
      }
      if (scheduleLines.length === 1) {
        return scheduleLines[0];
      }
      return best;
    }, LOCALIZED_CLOCK_TIME_PATTERN)
    .catch(() => '');
}

/**
 * @param {{ section: string, byLang: Record<string, string> }} row
 * @param {string} lang
 * @param {string} [hotelAmenitiesHours]
 * @param {boolean} [spaPathPasted]
 * @returns {boolean}
 */
function searchableRowNeedsSpaSubpage(row, lang, hotelAmenitiesHours = '', spaPathPasted = false) {
  if (spaPathPasted) {
    return true;
  }
  const section = row.section;
  const expected = expectedTextForRow(row, lang);
  if (isSpaTitleSectionLabel(section) || isSpaDescriptionSectionLabel(section)) {
    return true;
  }
  if (
    isSpaSectionLabel(section) &&
    !isSpaHoursSectionLabel(section) &&
    !isGenericOperationHoursSectionLabel(section)
  ) {
    return true;
  }
  if (!isSpaHoursRowLabel(section, hotelAmenitiesHours, expected)) {
    return false;
  }
  return !looksLikeSpaHoursContent(hotelAmenitiesHours);
}

/** @param {string} text */
function normalizeSpaHoursText(text) {
  return normalizeOperationHours(text);
}

/**
 * Spa title / name only (e.g. “Spa Name”, “Spa Title”) — not description or combined body.
 * @param {string} sectionLabel
 */
function isSpaTitleSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!/\bspa\b/i.test(s)) {
    return false;
  }
  if (/\bdescription\b/i.test(s)) {
    return false;
  }
  return /\b(?:title|name)\b/i.test(s) || /^spa$/i.test(s);
}

/**
 * Pick spa copy for a row: description-only, title-only, or combined block.
 * @param {string} sectionLabel
 * @param {string} spaBlock
 * @param {string} spaTitle
 * @param {string} spaDescription
 * @param {string} [spaHours]
 * @returns {string}
 */
function pickSpaTextForRow(sectionLabel, spaBlock, spaTitle, spaDescription, spaHours = '') {
  if (
    (isSpaHoursSectionLabel(sectionLabel) ||
      isGenericOperationHoursSectionLabel(sectionLabel)) &&
    normalizeText(spaHours)
  ) {
    return normalizeSpaHoursText(spaHours);
  }
  if (isSpaDescriptionSectionLabel(sectionLabel) && normalizeText(spaDescription)) {
    return spaDescription;
  }
  if (isSpaTitleSectionLabel(sectionLabel) && normalizeText(spaTitle)) {
    return spaTitle;
  }
  if (normalizeText(spaBlock)) {
    return spaBlock;
  }
  if (normalizeText(spaDescription)) {
    return spaDescription;
  }
  return String(spaTitle || '').trim();
}

/** Golf course title on `/services-amenities/golf`. */
const GOLF_COURSE_TITLE_SELECTOR = 'h3.golf-course-title';

/**
 * Excel column A: golf copy from `/services-amenities/golf`.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isGolfSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (isGolfAmenityInfoItemLabel(s)) {
    return false;
  }
  if (isDiningOperationHoursSectionLabel(s) && !/\bgolf\b/i.test(s)) {
    return false;
  }
  return (
    /\bgolf\b/i.test(s) ||
    /golf\s*(?:course\s*)?#?\s*\d+/i.test(s) ||
    (/services-amenities/i.test(s) && /\bgolf\b/i.test(s))
  );
}

/** @param {string} sectionLabel */
function isGolfDescriptionSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  return /\bgolf\b/i.test(s) && /\bdescription\b/i.test(s) && !/\b(?:title|name)\b/i.test(s);
}

/** @param {string} sectionLabel */
function isGolfTitleSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!/\bgolf\b/i.test(s)) {
    return false;
  }
  if (/\bdescription\b/i.test(s)) {
    return false;
  }
  return (
    /\b(?:title|name)\b/i.test(s) ||
    /^golf$/i.test(s) ||
    /golf\s*(?:course\s*)?#?\s*\d+$/i.test(s)
  );
}

/**
 * Excel column A: golf course hours on `/services-amenities/golf`.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isGolfHoursSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (/restaurant/i.test(s) && !/\bgolf\b/i.test(s)) {
    return false;
  }
  if (/\bgolf\b/i.test(s) && /\bhours\b/i.test(s)) {
    return true;
  }
  return golfOrdinalFromLabel(s) > 0 && /\bhours\b/i.test(s);
}

/**
 * 1-based golf course index from “Golf #2 Description”, “Golf Course #1 Name”, etc.
 * @param {string} sectionLabel
 * @returns {number}
 */
function golfOrdinalFromLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  const patterns = [/golf\s*(?:course\s*)?#?\s*(\d+)/i, /course\s*#?\s*(\d+)/i];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }
  }
  return 0;
}

/**
 * @param {string} sectionLabel
 * @returns {string}
 */
function golfCourseNameHintsFromSectionLabel(sectionLabel) {
  let s = normalizeSectionLabel(sectionLabel);
  s = s.replace(/golf\s*(?:course\s*)?#?\s*\d+/gi, ' ');
  s = s.replace(/course\s*#?\s*\d+/gi, ' ');
  s = s.replace(/#\s*\d+/g, ' ');
  const stripPatterns = [
    /\bhours\s+of\s+operation\b/gi,
    /\boperation\s+hours\b/gi,
    /\bopening\s+hours\b/gi,
    /\bdescription\b/gi,
    /\b(?:title|name)\b/gi,
    /\bgolf\b/gi,
    /\bcourse\b/gi,
  ];
  for (const re of stripPatterns) {
    s = s.replace(re, ' ');
  }
  return normalizeText(s);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
/**
 * @param {string} text
 * @returns {string}
 */
function normalizeHoursLanguageText(text) {
  return normalizeText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Spa/fitness schedule (not golf tee-time blocks).
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeSpaFitnessOnlyHoursContent(text) {
  const lower = normalizeHoursLanguageText(text);
  return /fitness\s*cent|massage|sauna|hammam|thermal|wellness\s*cent|piscine|bien-etre|bien etre|soins\s*de\s*spa/i.test(
    lower,
  );
}

function looksLikeGolfHoursContent(text) {
  const t = normalizeText(text);
  if (!t || t.length < 8 || !hasLocalizedClockTime(t)) {
    return false;
  }
  if (looksLikeDiningHoursContent(t)) {
    return false;
  }
  if (looksLikeSpaFitnessOnlyHoursContent(t)) {
    return false;
  }
  const lower = normalizeHoursLanguageText(t);
  const compact = lower.replace(/\s+/g, ' ');

  if (/tee\s*time|horaire\s*de\s*depart|parcours|golf\s*course|\bgolf\b/i.test(lower)) {
    return true;
  }

  // Property golf hours: one Mon–Sun band (e.g. “Du lundi au dimanche : 08:00 - 19:30”).
  if (
    /(lundi|monday|lunedi|mercoledi).*(dimanche|sunday|domenica)/i.test(compact) &&
    (compact.match(/\d{1,2}\s*:\s*\d{2}/g) || []).length <= 3
  ) {
    return true;
  }

  return false;
}

/**
 * @param {string} expected
 * @param {{ golfAmenityHours?: string, golfPropertyHours?: string, golfCourses?: { outlets: { hours: string }[] } | null, spaHours?: string, hotelAmenitiesHours?: string }} ctx
 * @returns {boolean}
 */
function shouldUseGolfOperationHours(expected, ctx) {
  const exp = plainTextFromMaybeHtml(expected);
  if (!normalizeText(exp)) {
    return false;
  }
  /** @type {string[]} */
  const golfCandidates = [
    ctx.golfAmenityHours,
    ctx.golfPropertyHours,
    ...(ctx.golfCourses?.outlets?.map((o) => o.hours) || []),
  ].filter((h) => normalizeText(h));
  for (const hours of golfCandidates) {
    if (textsMatchOperationHours(hours, exp) || compareTextIncludes(hours, exp)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} golfAmenityHours
 * @param {string} golfPropertyHours
 * @param {{ outlets: { hours: string }[] } | null} golfCourses
 * @param {string} [expected]
 * @returns {string}
 */
function pickGolfOperationHoursText(golfAmenityHours, golfPropertyHours, golfCourses, expected = '') {
  const exp = plainTextFromMaybeHtml(expected);
  /** @type {string[]} */
  const candidates = [
    golfAmenityHours,
    golfPropertyHours,
    ...(golfCourses?.outlets?.map((o) => String(o.hours || '').trim()) || []),
  ].filter((h) => normalizeText(h));
  if (normalizeText(exp)) {
    for (const hours of candidates) {
      if (textsMatchOperationHours(hours, exp) || compareTextIncludes(hours, exp)) {
        return hours;
      }
    }
  }
  return candidates[0] || '';
}

/**
 * @param {{ outlets: { name: string, hours: string }[] } | null} golfCourses
 * @param {string} expected
 * @returns {boolean}
 */
function expectedMatchesGolfCourse(golfCourses, expected) {
  const exp = plainTextFromMaybeHtml(expected);
  if (!normalizeText(exp) || !golfCourses?.outlets?.length) {
    return false;
  }
  for (const course of golfCourses.outlets) {
    const hours = String(course.hours || '').trim();
    if (!hours) {
      continue;
    }
    if (textsMatchOperationHours(hours, exp) || compareTextIncludes(hours, exp)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} sectionLabel
 * @param {string} [expected]
 * @param {{ outlets: { name: string, hours: string, description?: string, text?: string }[] } | null} [golfCourses]
 * @returns {boolean}
 */
function isGolfHoursRowLabel(sectionLabel, expected = '', golfCourses = null) {
  if (isGolfTitleSectionLabel(sectionLabel) || isGolfDescriptionSectionLabel(sectionLabel)) {
    return false;
  }
  if (isGolfHoursSectionLabel(sectionLabel)) {
    return true;
  }
  const label = normalizeSectionLabel(sectionLabel);
  if (/\bgolf\b/i.test(label) && /\bhours\b/i.test(label)) {
    return true;
  }
  if (golfOrdinalFromLabel(label) > 0 && /\bhours\b/i.test(label)) {
    return true;
  }
  const exp = plainTextFromMaybeHtml(expected);
  if (expectedMatchesGolfCourse(golfCourses, exp)) {
    return true;
  }
  if (looksLikeGolfHoursContent(exp)) {
    if (/\bgolf\b/i.test(label)) {
      return !expectedMatchesDiningOutlet(null, exp);
    }
  }
  return false;
}

/**
 * @param {{ name?: string, description?: string, hours?: string, text?: string } | null | undefined} course
 * @param {string} expected
 * @returns {string}
 */
function deriveGolfCourseDescription(course, expected) {
  const description = String(course?.description || '').trim();
  if (normalizeText(description)) {
    return description;
  }
  const body = String(course?.text || '').trim();
  const name = String(course?.name || '').trim();
  const hours = String(course?.hours || '').trim();
  let out = body;
  if (name && out.toLowerCase().startsWith(name.toLowerCase())) {
    out = out.slice(name.length).replace(/^[\s\n:–—-]+/, '').trim();
  }
  if (hours && out.includes(hours)) {
    out = out.replace(hours, '').trim();
  }
  return out.trim();
}

/**
 * @param {string} sectionLabel
 * @param {string} golfBlock
 * @param {{ name?: string, description?: string, hours?: string, text?: string } | null | undefined} course
 * @returns {string}
 */
function pickGolfTextForRow(sectionLabel, golfBlock, course) {
  if (isGolfHoursSectionLabel(sectionLabel) && normalizeText(course?.hours)) {
    return normalizeOperationHours(course.hours);
  }
  if (isGolfDescriptionSectionLabel(sectionLabel) && normalizeText(course?.description)) {
    return course.description;
  }
  if (isGolfTitleSectionLabel(sectionLabel) && normalizeText(course?.name)) {
    return course.name;
  }
  if (normalizeText(course?.text)) {
    return course.text;
  }
  return String(golfBlock || '').trim();
}

/**
 * @param {{ section: string, byLang: Record<string, string> }} row
 * @param {string} lang
 * @returns {boolean}
 */
function searchableRowNeedsGolfSubpage(row, lang) {
  const section = row.section;
  if (isGolfAmenityInfoItemLabel(section)) {
    return true;
  }
  if (isGolfSectionLabel(section)) {
    return true;
  }
  const expected = expectedTextForRow(row, lang);
  if (isGolfHoursRowLabel(section, expected, null)) {
    return true;
  }
  return false;
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ name: string, description: string, hours: string, text: string }[]>}
 */
async function scrapeGolfCoursesFromPage(page) {
  await page
    .locator(GOLF_COURSE_TITLE_SELECTOR)
    .first()
    .waitFor({ state: 'attached', timeout: 8_000 })
    .catch(() => {});

  return page
    .evaluate((clockPattern) => {
      const clockRe = new RegExp(clockPattern, 'i');
      const clean = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
      const textFrom = (el) => {
        if (!el) {
          return '';
        }
        const raw = el.innerText && String(el.innerText).trim() ? el.innerText : el.textContent;
        return String(raw || '')
          .replace(/\u00a0/g, ' ')
          .split(/\r?\n/)
          .map(clean)
          .filter(Boolean)
          .join('\n')
          .trim();
      };
      const isMetaLine = (line) => {
        const t = clean(line);
        if (!t) {
          return true;
        }
        return (
          /^course designer\b/i.test(t) ||
          /^\d+\s+for (men|women)$/i.test(t) ||
          /^\d+\s*meters for (men|women)$/i.test(t) ||
          /^no restriction for (men|women)$/i.test(t) ||
          /^correct dress is required/i.test(t) ||
          /^for a tee time call:/i.test(t) ||
          /^free of charge$/i.test(t) ||
          /€/.test(t)
        );
      };
      const isDescriptionParagraph = (p) => {
        const t = textFrom(p);
        return t.length >= 80 && !isMetaLine(t);
      };
      const extractHours = (root) => {
        const hoursRoot = root.querySelector('.course-hours') || root;
        const h2 = [...hoursRoot.querySelectorAll('h2')].find((el) =>
          /hours of operation|horaires|horaire|offnungszeiten|orari|horario/i.test(clean(textFrom(el))),
        );
        const scope = h2?.closest('section') || hoursRoot;
        const lines = [];
        for (const node of scope.querySelectorAll('p, div.hours, li')) {
          const t = textFrom(node);
          if (!t || isMetaLine(t)) {
            continue;
          }
          if (
            clockRe.test(t) ||
            /monday|sunday|weekday|daily|every|lunes|domingo|werktag|feriale|sabato|domenica|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|月曜|日曜|平日|土曜|日曜/i.test(
              t,
            )
          ) {
            lines.push(t);
          }
        }
        if (!lines.length) {
          const block = textFrom(scope);
          return block
            .split(/\n/)
            .map(clean)
            .filter((t) => t && clockRe.test(t))
            .join('\n');
        }
        return lines.join('\n');
      };

      const titles = [...document.querySelectorAll('h3.golf-course-title')];
      /** @type {{ name: string, description: string, hours: string, text: string }[]} */
      const outlets = [];
      for (let i = 0; i < titles.length; i++) {
        const titleEl = titles[i];
        const name = clean(textFrom(titleEl));
        if (!name) {
          continue;
        }
        const nextTitle = titles[i + 1] || null;
        let description = '';
        let hours = '';
        const start = titleEl.closest('section') || titleEl.parentElement;
        let node = start;
        while (node) {
          const sibling = node.nextElementSibling;
          if (!sibling) {
            break;
          }
          if (nextTitle && sibling.contains(nextTitle)) {
            break;
          }
          if (
            sibling.querySelector('h3.golf-course-title') &&
            sibling.querySelector('h3.golf-course-title') !== titleEl
          ) {
            break;
          }
          node = sibling;
          if (sibling.classList.contains('modal')) {
            continue;
          }
          for (const p of sibling.querySelectorAll('p')) {
            if (!description && isDescriptionParagraph(p)) {
              description = textFrom(p);
            }
          }
          const h = extractHours(sibling);
          if (h) {
            hours = h;
          }
        }
        const text = [name, description, hours].filter(Boolean).join('\n\n');
        outlets.push({ name, description, hours, text });
      }
      return outlets;
    }, LOCALIZED_CLOCK_TIME_PATTERN)
    .catch(() => []);
}

/**
 * Property-wide golf hours (e.g. “Du lundi au dimanche : 08:00 - 19:30”) on /services-amenities/golf.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function scrapeGolfPropertyOperationHours(page) {
  return page
    .evaluate((clockPattern) => {
      const clockRe = new RegExp(clockPattern, 'i');
      const clean = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
      const pick = (el) => {
        if (!el) {
          return '';
        }
        const raw = el.innerText && String(el.innerText).trim() ? el.innerText : el.textContent;
        return clean(
          String(raw || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join('\n'),
        );
      };
      const isInsideCourseCard = (el) =>
        Boolean(el?.closest?.('h3.golf-course-title') || el?.closest?.('.golf-course'));
      /** @type {string[]} */
      const matches = [];
      for (const el of document.querySelectorAll(
        'section.course-hours div.hours, section.course-hours .hours, .course-hours .hours, #main-content div.hours',
      )) {
        if (isInsideCourseCard(el)) {
          continue;
        }
        const t = pick(el);
        if (!t || !clockRe.test(t)) {
          continue;
        }
        const lower = t.toLowerCase();
        if (/breakfast|lunch|dinner|brunch|restaurant/i.test(lower)) {
          continue;
        }
        matches.push(t);
      }
      if (!matches.length) {
        for (const el of document.querySelectorAll('#main-content p, #main-content div.hours')) {
          const t = pick(el);
          if (!t || !clockRe.test(t) || t.length > 220) {
            continue;
          }
          if (
            /lundi|monday|lunedi|dimanche|sunday|domenica|tee time|horaire de depart|horaires/i.test(
              t,
            )
          ) {
            matches.push(t);
          }
        }
      }
      matches.sort((a, b) => b.length - a.length);
      return matches[0] || '';
    }, LOCALIZED_CLOCK_TIME_PATTERN)
    .catch(() => '');
}

/**
 * @param {import('playwright').Page} page
 * @param {string} hotelPageUrl
 * @param {string} languageCode
 * @returns {Promise<{ block: string, courses: { outlets: { name: string, description: string, hours: string, text: string }[] } | null, propertyOperationHours: string }>}
 */
async function readGolfServicesBlock(page, hotelPageUrl, languageCode) {
  const targetUrl = buildGolfServicesUrl(hotelPageUrl, languageCode);
  if (!targetUrl) {
    return { block: '', courses: null, propertyOperationHours: '' };
  }

  try {
    await gotoPageCommit(page, targetUrl);
    await dismissOptionalCookieBanner(page);
    await page
      .locator(`${GOLF_COURSE_TITLE_SELECTOR}, #golf-hero-title`)
      .first()
      .waitFor({ state: 'attached', timeout: 8_000 })
      .catch(() => {});

    const propertyOperationHours = await scrapeGolfPropertyOperationHours(page);
    const outlets = await scrapeGolfCoursesFromPage(page);
    if (!outlets.length) {
      const generic = String((await extractLhwServicesPageText(page)) || '').trim();
      return { block: generic, courses: null, propertyOperationHours };
    }
    const block = outlets.map((o) => o.text).join('\n\n---\n\n');
    return { block, courses: { outlets }, propertyOperationHours };
  } catch {
    return { block: '', courses: null, propertyOperationHours: '' };
  }
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
 * Excel column A: optional row for the hotel overview announcement inside {@link HOTEL_MESSAGE_BANNER_SELECTOR}.
 * Use labels like “Message banner” or “Hotel message” (not Property Highlight / Property search).
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isHotelMessageBannerSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (
    /property\s*highlight/i.test(s) ||
    /property\s*search/i.test(s) ||
    /local\s*information/i.test(s) ||
    isSpecialNoticeSectionLabel(s)
  ) {
    return false;
  }
  return (
    /^message\s*banner$/i.test(s) ||
    /^hotel\s*message$/i.test(s) ||
    /^site\s*message$/i.test(s) ||
    /^overview\s*message$/i.test(s) ||
    /\bmessage\s*banner\b/i.test(s)
  );
}

/**
 * Excel column A: Summer 2026 / renovation strip inside `.alert.alert-info.special-notice`.
 * @param {string} sectionLabel
 * @returns {boolean}
 */
function isSpecialNoticeSectionLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (/property\s*highlight/i.test(s) || /property\s*search/i.test(s) || /local\s*information/i.test(s)) {
    return false;
  }
  return (
    /^renovation\s*notice$/i.test(s) ||
    /^special\s*notice$/i.test(s) ||
    /^summer\s*20\d{2}\s*(info|information)?$/i.test(s) ||
    /\brenovation\s*notice\b/i.test(s) ||
    /\bspecial\s*notice\b/i.test(s) ||
    /\bsummer\s*20\d{2}\s*information\b/i.test(s)
  );
}

/** Prefer hotel shell so we do not grab a generic site-wide toast. */
const HOTEL_MESSAGE_BANNER_SELECTOR = '#main-content div.message';

/** Spa / fitness schedule on hotel overview (`#hotel-amenities` extras row). */
const HOTEL_AMENITIES_EXTRAS_HOURS_SELECTORS = [
  '#hotel-amenities > section > div.row.extras > div > div > div',
  '#hotel-amenities section div.row.extras div > div > div',
  '#hotel-amenities section div.row.extras',
  '#hotel-amenities .row.extras',
];

/**
 * Open / scroll to the hotel amenities block on the overview (often tabbed).
 * @param {import('playwright').Page} page
 */
async function ensureHotelAmenitiesVisible(page) {
  await page
    .evaluate(() => {
      if (!location.hash || !location.hash.toLowerCase().includes('amenities')) {
        location.hash = 'hotel-amenities';
      }
    })
    .catch(() => {});
  await page.waitForTimeout(150);
  const tab = page.getByRole('tab', { name: /hotel\s*amenities|amenities/i }).first();
  if (await tab.isVisible({ timeout: 400 }).catch(() => false)) {
    await tab.click({ timeout: 4000, force: true }).catch(() => {});
    await page.waitForTimeout(150);
  }
}

/**
 * Hours block from hotel overview amenities (e.g. Weekdays / Fitness Center times).
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
/**
 * @param {import('playwright').Page} page
 * @param {{ amenitiesTabReady?: boolean }} [options]
 */
async function readHotelAmenitiesExtrasHours(page, options = {}) {
  if (!options.amenitiesTabReady) {
    await ensureHotelAmenitiesVisible(page);
    const root = page.locator('#hotel-amenities').first();
    await root.waitFor({ state: 'attached', timeout: 12_000 }).catch(() => {});
    await root.scrollIntoViewIfNeeded().catch(() => {});
  }

  return page
    .evaluate((selectors, clockPattern) => {
      const pick = (el) => {
        if (!el) {
          return '';
        }
        const raw = el.innerText && String(el.innerText).trim() ? el.innerText : el.textContent;
        return String(raw || '')
          .replace(/\u00a0/g, ' ')
          .split(/\r?\n/)
          .map((line) => line.replace(/[ \t]+/g, ' ').trim())
          .filter(Boolean)
          .join('\n')
          .trim();
      };
      const clockRe = new RegExp(clockPattern, 'i');
      const looksLike = (text) => {
        const t = String(text || '').trim();
        if (!t || t.length < 8 || !clockRe.test(t)) {
          return false;
        }
        const lower = t.toLowerCase();
        if (/breakfast|lunch|dinner|brunch|all-day|bar\s*hours|restaurant|dining/i.test(lower)) {
          return false;
        }
        return /weekday|weekend|fitness|massage|sauna|hammam|thermal|wellness|\bspa\b|pool|gym|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine|bien-etre|bien-être|soins/i.test(
          lower,
        );
      };
      let best = '';
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = pick(el);
          if (!looksLike(t)) {
            continue;
          }
          if (t.length > best.length) {
            best = t;
          }
        }
        if (best.length > 40) {
          break;
        }
      }
      if (!best) {
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            const t = pick(el);
            if (t.length > best.length && clockRe.test(t)) {
              best = t;
            }
          }
        }
      }
      if (!best) {
        const amenityRoot = document.querySelector('#hotel-amenities');
        if (amenityRoot) {
          const t = pick(amenityRoot);
          if (t.length > best.length && clockRe.test(t)) {
            best = t;
          }
        }
      }
      return best;
    }, HOTEL_AMENITIES_EXTRAS_HOURS_SELECTORS, LOCALIZED_CLOCK_TIME_PATTERN)
    .catch(() => '');
}

async function readHotelMessageBannerBlock(page) {
  const primary = page.locator(HOTEL_MESSAGE_BANNER_SELECTOR).first();
  await primary.waitFor({ state: 'attached', timeout: 25_000 }).catch(() => {});
  await primary.scrollIntoViewIfNeeded().catch(() => {});

  const raw = await page
    .evaluate(() => {
      const richer = (a, b) => {
        const x = String(a || '').replace(/\u00a0/g, ' ').trim();
        const y = String(b || '').replace(/\u00a0/g, ' ').trim();
        return x.length >= y.length ? x : y;
      };
      const selectors = [
        '#main-content div.message',
        '.hotel-detail div.message',
        'div.page.hotel-detail div.message',
      ];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        for (const el of nodes) {
          if (el.closest('.alert.alert-info.special-notice')) {
            continue;
          }
          const t = richer(el.innerText, el.textContent);
          if (t.length > 12) {
            return t;
          }
        }
      }
      return '';
    })
    .catch(() => '');

  return String(raw || '').trim();
}

/** Primary selector for the Summer 2026 / special-notice strip on the hotel overview. */
const SPECIAL_NOTICE_SELECTOR = 'div.alert.alert-info.special-notice div.message';

const SPECIAL_NOTICE_SELECTORS = [
  SPECIAL_NOTICE_SELECTOR,
  '.alert.alert-info.special-notice .message',
  'div.alert.alert-info.special-notice',
  '.alert.alert-info.special-notice',
];

/**
 * Normalize special-notice copy for readable output (preserve paragraph breaks).
 * @param {string} text
 * @returns {string}
 */
function normalizeSpecialNoticeMessage(text) {
  const lines = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    if (!line && out.length > 0 && out[out.length - 1] === '') {
      continue;
    }
    out.push(line);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 1-based index from “Special Notice #2”, “Renovation Notice #3”, etc.
 * @param {string} sectionLabel
 * @returns {number}
 */
function specialNoticeOrdinalFromLabel(sectionLabel) {
  const s = normalizeSectionLabel(sectionLabel);
  const patterns = [
    /special\s*notice\s*#?\s*(\d+)/i,
    /renovation\s*notice\s*#?\s*(\d+)/i,
    /summer\s*20\d{2}.*#?\s*(\d+)/i,
    /\bnotice\s*#?\s*(\d+)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }
  }
  return 0;
}

/**
 * Read every overview special-notice block (`div.alert.alert-info.special-notice div.message`).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>}
 */
async function readAllSpecialNoticeMessages(page) {
  const scopedSelector = `#main-content ${SPECIAL_NOTICE_SELECTOR}`;
  const alertSelector = '#main-content div.alert.alert-info.special-notice';
  const loc = page.locator(scopedSelector).first();
  await loc.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});

  let lastCount = 0;
  let stableRounds = 0;
  for (let attempt = 0; attempt < 24; attempt++) {
    const count = await page.locator(scopedSelector).count();
    if (count === lastCount && count > 0) {
      stableRounds += 1;
      if (stableRounds >= 2) {
        break;
      }
    } else {
      stableRounds = 0;
      lastCount = count;
    }
    await page.waitForTimeout(300);
  }

  const alertCount = await page.locator(alertSelector).count();
  for (let i = 0; i < alertCount; i++) {
    await page.locator(alertSelector).nth(i).scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);

  /** @type {string[]} */
  const messages = [];
  const seen = new Set();
  const count = await page.locator(scopedSelector).count();
  for (let i = 0; i < count; i++) {
    const inner = await page
      .locator(scopedSelector)
      .nth(i)
      .innerText({ timeout: 10_000 })
      .catch(() => '');
    if (!normalizeText(inner)) {
      continue;
    }
    const key = normalizeText(inner);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    messages.push(inner);
  }

  if (!messages.length) {
    for (const sel of SPECIAL_NOTICE_SELECTORS) {
      try {
        const fallbackCount = await page.locator(sel).count();
        for (let i = 0; i < fallbackCount; i++) {
          const inner = await page.locator(sel).nth(i).innerText({ timeout: 10_000 }).catch(() => '');
          if (!normalizeText(inner)) {
            continue;
          }
          const key = normalizeText(inner);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          messages.push(inner);
        }
        if (messages.length) {
          break;
        }
      } catch {
        // try next selector
      }
    }
  }

  return messages
    .map((text) => normalizeSpecialNoticeMessage(text))
    .filter((text) => normalizeText(text));
}

/**
 * Pick the special-notice block that belongs to this Excel row.
 *
 * @param {string[]} messages
 * @param {number} [ordinal]
 * @param {string} [expectedText]
 * @param {Set<number>} [usedIndices] Already-assigned block indexes (0-based)
 * @returns {string}
 */
/** @returns {string} */
function pickSpecialNoticeText(messages, ordinal = 0, expectedText = '', usedIndices = null) {
  const { text } = resolveSpecialNoticeBlock(messages, {
    ordinal,
    expected: expectedText,
    usedIndices,
    contentIndex: specialNoticeBlockIndexForExpected(messages, expectedText),
  });
  return text;
}

/**
 * Read the first overview special-notice block (legacy helper).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readSpecialNoticeMessage(page) {
  const messages = await readAllSpecialNoticeMessages(page);
  return messages[0] || '';
}

/**
 * Format captured special notices for logs / UI previews.
 * @param {string[]} messages
 * @returns {string}
 */
function formatSpecialNoticesForPreview(messages) {
  if (!messages?.length) {
    return '';
  }
  return messages
    .map((text, i) => {
      const preview = truncateForResultPreview(text, 4000);
      return `Special notice ${i + 1}\n${preview}`;
    })
    .join('\n\n---\n\n');
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
 *
 * Preferred layout (LHW / CORI-style): three tiles
 *   `section.property-highlights .highlight-item` → each has `h3` + lead `p` (Fine Dining, Location, Spa).
 * Falls back to older heuristics if those nodes are missing.
 *
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
      const region = main || document.body;
      if (!region) {
        return [];
      }

      const pushSeg = (arr, t, minLen = 40) => {
        const c = clean(t);
        if (
          c.length >= minLen &&
          !/^cookie\b/i.test(c) &&
          !/you have been blocked/i.test(c)
        ) {
          arr.push(c);
        }
      };

      /** CORI-style three-column highlight tiles (Property Highlight #1 / #2 / #3 body copy). */
      const fromHighlightItems = () => {
        const phSec =
          document.querySelector('section.property-highlights') ||
          document.querySelector('[class*="property-highlights"]') ||
          (main && main.querySelector('section.property-highlights'));
        let items = [];
        if (phSec) {
          items = [...phSec.querySelectorAll('.highlight-item, [class*="highlight-item"]')].filter(
            (el) => el.querySelector && el.querySelector('p'),
          );
        }
        if (!items.length && main) {
          items = [...main.querySelectorAll('.highlight-item, [class*="highlight-item"]')].filter(
            (el) => el.querySelector && el.querySelector('p'),
          );
        }
        if (!items.length) {
          return [];
        }
        const ordered = [];
        for (const item of items) {
          const p = item.querySelector(':scope > p') || item.querySelector('p');
          if (!p) {
            continue;
          }
          // Hotel blurbs are usually one short paragraph per tile; allow slightly shorter than generic body noise filter.
          pushSeg(ordered, p.innerText || p.textContent, 25);
        }
        return ordered;
      };

      const tileSegments = fromHighlightItems();
      if (tileSegments.length) {
        const seen = new Set();
        const out = [];
        for (const s of tileSegments) {
          const key = s.slice(0, 120);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(s);
          }
        }
        if (out.length) {
          return out;
        }
      }

      const segments = [];

      // Regions whose class hints at “highlight”
      region
        .querySelectorAll('[class*="highlight"] p, [class*="Highlight"] p')
        .forEach((p) => {
          pushSeg(segments, p.innerText || p.textContent);
        });

      // Headings that literally say “Property Highlight”, then look for a nearby column paragraph
      const heads = [...region.querySelectorAll('h2, h3, h4, .heading-xx-large, .heading-large')].filter(
        (h) => /property\s*highlight/i.test(h.textContent || ''),
      );
      for (const h of heads) {
        let el = h.nextElementSibling;
        for (let depth = 0; depth < 14 && el; depth++) {
          const pDirect = el.tagName === 'P' ? el : null;
          const pNested = el.querySelector && el.querySelector('p');
          const cand = pDirect || pNested;
          if (cand) {
            pushSeg(segments, cand.innerText || cand.textContent);
            break;
          }
          el = el.nextElementSibling;
        }
      }

      // Two-column layout: long <p> inside .col-md-6 (CORI-style property blurbs)
      if (!segments.length) {
        region.querySelectorAll('.col-12.col-md-6 p, .col-md-6 p').forEach((p) => {
          pushSeg(segments, p.innerText || p.textContent);
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
 * Pinned selector for the “special note” property-overview row on the hotel overview.
 * When column H is non-empty on a row, actual copy for that row is read from here (not main body / highlight heuristics).
 */
const PROPERTY_OVERVIEW_SPECIAL_FULL =
  '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.property-overview.alt-bg.pb-5 > div > div:nth-child(3)';

const PROPERTY_OVERVIEW_SPECIAL_FALLBACK =
  'section.property-overview.alt-bg.pb-5 > div > div:nth-child(3)';

/**
 * Wait until `section.property-overview` exists (client-rendered shell).
 * @param {import('playwright').Page} page
 */
async function waitForPropertyOverviewSection(page) {
  const loc = page.locator('section.property-overview').first();
  await loc.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
}

/**
 * Try to show the hotel overview / property-overview panel (tabs often hide inactive panels;
 * innerText is empty there — we still read textContent, but activating the tab helps lazy content).
 * @param {import('playwright').Page} page
 */
async function ensurePropertyOverviewVisible(page) {
  await page
    .evaluate(() => {
      const anchors = ['property-overview', 'hotel-overview', 'overview'];
      const lc = (location.hash || '').toLowerCase();
      if (!anchors.some((a) => lc.includes(a))) {
        location.hash = 'property-overview';
      }
    })
    .catch(() => {});
  await page.waitForTimeout(600);

  const tabNameRegexes = [
    /^overview$/i,
    /^hotel overview$/i,
    /\bhotel\s+overview\b/i,
    /\boverview\b/i,
    /^descripción$/i,
    /^descripcion$/i,
    /^description$/i,
    /^beschreibung$/i,
    /^présentation$/i,
    /^presentacion$/i,
    /Überblick/i,
    /aperçu de l['’]hôtel/i,
    /panoramica/i,
    /descripción general/i,
    /descripcion general/i,
    /ホテル概要/,
    /酒店概览/,
  ];

  for (const re of tabNameRegexes) {
    try {
      const tab = page.getByRole('tab', { name: re }).first();
      if (await tab.isVisible({ timeout: 700 }).catch(() => false)) {
        await tab.scrollIntoViewIfNeeded().catch(() => {});
        await tab.click({ timeout: 8000, force: true }).catch(() => {});
        await page.waitForTimeout(600);
        return;
      }
    } catch {
      // try next pattern
    }
  }

  const extraClickers = [
    page.locator('a[href*="property-overview" i]').first(),
    page.locator('a[href*="hotel-overview" i]').first(),
    page.locator('a[href*="#overview" i]').first(),
    page
      .locator('.sticky-nav-page-wrapper a, .js-stickybit-parent a, .nav-tabs a')
      .filter({ hasText: /^(overview|descripción|descripcion|description)$/i })
      .first(),
  ];

  for (const loc of extraClickers) {
    try {
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 8000, force: true }).catch(() => {});
        await page.waitForTimeout(600);
        return;
      }
    } catch {
      // next
    }
  }

  await page
    .locator('section.property-overview')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.waitForTimeout(400);
}

/**
 * Harvest the longest plausible copy for the property-overview “special note” block.
 * Prefers textContent (works when the tab panel is display:none); tries pinned selectors and every
 * `section.property-overview` in case mobile/desktop duplicates or nth-child differs by template.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function harvestPropertyOverviewTextInPage(page) {
  const raw = await page
    .evaluate(
      ([fullSel, fbSel]) => {
        const squish = (s) =>
          String(s || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const richer = (a, b) => {
          const A = squish(a);
          const B = squish(b);
          return A.length >= B.length ? A : B;
        };

        let best = '';

        const consider = (raw) => {
          const c = squish(raw);
          if (c.length > best.length) {
            best = c;
          }
        };

        const elFull = document.querySelector(fullSel);
        if (elFull) {
          consider(richer(elFull.textContent, elFull.innerText));
        }
        const elFb = document.querySelector(fbSel);
        if (elFb) {
          consider(richer(elFb.textContent, elFb.innerText));
        }

        for (const sec of document.querySelectorAll('section.property-overview')) {
          const pinned = sec.querySelector(':scope > div > div:nth-child(3)');
          if (pinned) {
            consider(richer(pinned.textContent, pinned.innerText));
          }
          consider(richer(sec.textContent, sec.innerText));
        }

        return best;
      },
      [PROPERTY_OVERVIEW_SPECIAL_FULL, PROPERTY_OVERVIEW_SPECIAL_FALLBACK],
    )
    .catch(() => '');

  return String(raw || '').trim();
}

/**
 * Text for Excel column H “special note” rows: property-overview block on the hotel overview.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readPropertyOverviewSpecialBlock(page) {
  await waitForPropertyOverviewSection(page);

  await page
    .locator('section.property-overview')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.waitForTimeout(600);

  let text = await harvestPropertyOverviewTextInPage(page);
  if (normalizeText(text)) {
    return text;
  }

  await ensurePropertyOverviewVisible(page);
  await waitForPropertyOverviewSection(page);
  await page.waitForTimeout(500);
  text = await harvestPropertyOverviewTextInPage(page);
  if (normalizeText(text)) {
    return text;
  }

  // Locator + textContent (same idea as airport line when evaluate missed timing).
  for (const sel of [PROPERTY_OVERVIEW_SPECIAL_FULL, PROPERTY_OVERVIEW_SPECIAL_FALLBACK]) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) {
        continue;
      }
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const raw = await loc
        .evaluate((el) => {
          if (!el) {
            return '';
          }
          const tc = el.textContent || '';
          const it = el.innerText || '';
          const a = String(tc).trim();
          const b = String(it).trim();
          return a.length >= b.length ? a : b;
        })
        .catch(() => '');
      if (normalizeText(raw)) {
        return String(raw).replace(/\u00a0/g, ' ').trim();
      }
    } catch {
      // next selector
    }
  }

  return '';
}

/**
 * Main copy for Excel “Overview” rows: `<p>` body inside `.col-md-7` only (no subheader quote).
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readHotelPropertyOverviewBody(page) {
  return readHotelPropertyOverviewColumn(page, 'body');
}

/**
 * Subheader quote for Excel “Quot” / “Quote” rows (`.subheader.font-amiri`).
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readHotelPropertyOverviewQuote(page) {
  return readHotelPropertyOverviewColumn(page, 'quote');
}

/**
 * @param {import('playwright').Page} page
 * @param {'body'|'quote'} part
 * @returns {Promise<string>}
 */
async function readHotelPropertyOverviewColumn(page, part) {
  await ensurePropertyOverviewVisible(page);
  await waitForPropertyOverviewSection(page);
  await page
    .locator('section.property-overview')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await page.waitForTimeout(400);

  const pull = () =>
    page
      .evaluate(
        (mode) => {
        const cleanLine = (t) =>
          String(t || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .trim();
        const textWithBreaks = (el) => {
          if (!el) {
            return '';
          }
          const clone = el.cloneNode(true);
          clone.querySelectorAll('a, button, .btn, .my-2').forEach((node) => node.remove());
          const raw =
            clone.innerText && String(clone.innerText).trim()
              ? clone.innerText
              : clone.textContent || '';
          return String(raw || '')
            .replace(/\u00a0/g, ' ')
            .split(/\r?\n/)
            .map((line) => cleanLine(line))
            .filter(Boolean)
            .join('\n\n')
            .trim();
        };
        const isEventLinkLine = (t) =>
          t.length <= 240 &&
          /^(ver|view|see|read)\b/i.test(t) &&
          /event|evento|venue|lugar|function|banquet|meeting|wedding|mariage|matrimonio/i.test(t);

        const sec = document.querySelector('section.property-overview');
        if (!sec) {
          return '';
        }

        if (mode === 'quote') {
          const subEl =
            sec.querySelector('.subheader.font-amiri') ||
            sec.querySelector('.subheader, [class*="subheader"]');
          return textWithBreaks(subEl);
        }

        /** @type {string[]} */
        const parts = [];

        const colSelectors = [
          '.col-12.col-md-7',
          '.col-md-7',
          '.col-lg-7',
          '[class*="col-md-7"]',
          '[class*="col-lg-7"]',
        ];
        let bodyCol = null;
        for (const sel of colSelectors) {
          const col = sec.querySelector(sel);
          if (col && !col.querySelector('.subheader, [class*="subheader"]')) {
            bodyCol = col;
            break;
          }
        }
        if (!bodyCol) {
          for (const col of sec.querySelectorAll('.row > [class*="col-"]')) {
            if (col.querySelector('.subheader, [class*="subheader"], .font-amiri')) {
              continue;
            }
            if (col.querySelector('p')) {
              bodyCol = col;
              break;
            }
          }
        }

        if (bodyCol) {
          let paragraphs = [...bodyCol.querySelectorAll(':scope > p')];
          if (!paragraphs.length) {
            paragraphs = [...bodyCol.querySelectorAll('p')];
          }
          for (const p of paragraphs) {
            if (p.closest('a, button, .btn, .my-2')) {
              continue;
            }
            const t = textWithBreaks(p);
            if (t.length > 30 && !isEventLinkLine(t)) {
              parts.push(t);
            }
          }
        }

        return [...new Set(parts)].join('\n\n').trim();
      },
        part,
      )
      .catch(() => '');

  let text = await pull();
  if (!normalizeText(text)) {
    await ensurePropertyOverviewVisible(page);
    await waitForPropertyOverviewSection(page);
    await page.waitForTimeout(500);
    text = await pull();
  }
  return String(text || '').trim();
}

/**
 * Column H (special note): any non-empty cell means this row’s “actual” text for comparison
 * so the runner does not spend time scraping sections that have no source row to verify.
 * @param {{ byLang: Record<string, string> }} row
 * @returns {boolean}
 */
function rowHasEnglishContent(row) {
  return Boolean(String(row.byLang?.ENG || '').trim());
}

/**
 * Failed because expected copy ≠ actual (not a scrape/run error).
 * @param {{ section?: string, status?: string, note?: string }} row
 * @returns {boolean}
 */
function isCopyMismatchResult(row) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'not found') {
    return true;
  }
  if (status !== 'failed') {
    return false;
  }
  const section = String(row.section || '');
  if (section.startsWith('(')) {
    return false;
  }
  const note = String(row.note || '').toLowerCase();
  if (
    note.includes('row error') ||
    note.includes('run continued') ||
    note.includes('feature comparison error') ||
    note.includes('highlight title error')
  ) {
    return false;
  }
  if (note.includes('selector did not match')) {
    return false;
  }
  return true;
}

/**
 * Column H (special note): any non-empty cell means this row’s “actual” text for comparison
 * comes from {@link readPropertyOverviewSpecialBlock} instead of the main page / highlight segments.
 * @param {{ specialNote?: string }} row
 * @returns {boolean}
 */
function rowHasSpecialNote(row) {
  return Boolean(String(row.specialNote || '').trim());
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
  await section.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  const airport = section.locator('p.airport').first();
  await airport.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
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
  await page.waitForTimeout(400);

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
        await page.waitForTimeout(350);
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
        await page.waitForTimeout(350);
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
 * @param {null | { title: string, description: string, hours?: string }} [spaPartOut] When `amenity === 'spa'`, receives structured title / description / hours (not generic fallback text).
 * @param {null | { value: { outlets: { name: string, hours: string }[] } | null }} [diningOperationHoursOut] When `amenity === 'dining'`, receives structured operation hours.
 * @param {null | { value: { outlets: { name: string, text: string }[] } | null }} [diningOutletBlocksOut] When `amenity === 'dining'`, receives one readable block per restaurant.
 * @returns {Promise<string>}
 */
/**
 * Wait for amenity subpage content instead of long fixed sleeps + networkidle.
 * @param {import('playwright').Page} page
 * @param {'dining'|'spa'} amenity
 */
async function waitForServicesAmenityPage(page, amenity) {
  await page.locator('#main-content').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (amenity === 'spa') {
    await page
      .locator(`${SPA_TITLE_H3_SELECTOR}, ${SPA_TITLE_SELECTOR}, .spa-details`)
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});
  } else {
    await page
      .locator(`${DINING_OPERATION_HOURS_SELECTOR}, #main-content`)
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});
  }
}

async function readServicesAmenitiesBlock(
  page,
  hotelPageUrl,
  languageCode,
  amenity,
  spaPartOut = null,
  diningOperationHoursOut = null,
  diningOutletBlocksOut = null,
  options = {},
) {
  const { skipDiningOutletBlocks = false, diningHoursOnly = false } = options;
  const targetUrl =
    amenity === 'spa'
      ? buildSpaServicesUrl(hotelPageUrl, languageCode)
      : buildDiningServicesUrl(hotelPageUrl, languageCode);
  if (!targetUrl) {
    return '';
  }

  async function pullOnce() {
    await gotoPageCommit(page, targetUrl);
    await dismissOptionalCookieBanner(page);
    await waitForServicesAmenityPage(page, amenity);

    let pageText = '';
    if (amenity === 'dining' && diningHoursOnly) {
      if (diningOperationHoursOut) {
        try {
          diningOperationHoursOut.value = await readDiningOperationHoursOnCurrentPage(page);
        } catch {
          diningOperationHoursOut.value = null;
        }
      }
      if (diningOutletBlocksOut) {
        diningOutletBlocksOut.value = null;
      }
      return '';
    }
    if (amenity === 'spa') {
      const parts = await extractSpaTitleAndDescriptionParts(page);
      const locTitle = await readSpaListTitleText(page);
      const title = String(locTitle || parts.title || '').trim();
      const description = parts.description;
      const hours = parts.hours || '';
      pageText = [title, description].filter(Boolean).join('\n\n').trim();
      if (spaPartOut) {
        spaPartOut.title = title;
        spaPartOut.description = description;
        spaPartOut.hours = hours;
      }
      if (normalizeText(pageText).length < 40) {
        const generic = String((await extractLhwServicesPageText(page)) || '').trim();
        pageText = normalizeText(pageText) ? `${pageText}\n\n${generic}`.trim() : generic;
      }
    } else {
      const diningOverviewText = await readDiningOverviewOnCurrentPage(page);
      pageText = String((await extractLhwServicesPageText(page)) || '').trim();
      if (normalizeText(diningOverviewText).length >= 40) {
        pageText = diningOverviewText;
      }
      if (diningOperationHoursOut) {
        try {
          diningOperationHoursOut.value = await readDiningOperationHoursOnCurrentPage(page);
        } catch {
          diningOperationHoursOut.value = null;
        }
      }
      if (diningOutletBlocksOut && !skipDiningOutletBlocks) {
        try {
          diningOutletBlocksOut.value = await readDiningOutletBlocksOnCurrentPage(page);
        } catch {
          diningOutletBlocksOut.value = null;
        }
      } else if (diningOutletBlocksOut && skipDiningOutletBlocks) {
        diningOutletBlocksOut.value = null;
      }
    }

    const skipSpaBulkInnerText =
      amenity === 'spa' &&
      spaPartOut &&
      Boolean(normalizeText(spaPartOut.title)) &&
      Boolean(normalizeText(spaPartOut.description)) &&
      Boolean(normalizeText(spaPartOut.hours));

    if (amenity === 'spa' && spaPartOut && !normalizeText(spaPartOut.hours)) {
      spaPartOut.hours = normalizeSpaHoursText(await readSpaHoursOnCurrentPage(page));
    }

    if (pageText.length < 80 && !skipSpaBulkInnerText) {
      try {
        const main = page.locator('main').first();
        if (await main.count()) {
          pageText = (await main.innerText({ timeout: 6_000 })).trim();
        } else {
          const block = page.locator('#main-content').first();
          if (await block.count()) {
            pageText = (await block.innerText({ timeout: 6_000 })).trim();
          } else {
            pageText = (await page.locator('body').innerText({ timeout: 6_000 })).trim();
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
    const out = await pullOnce();
    if (isLikelyBotBlockPage(out)) {
      return '';
    }
    return out;
  } catch {
    return '';
  }
}

/** Selector for dining operation hours on `/services-amenities/dining`. */
const DINING_OPERATION_HOURS_SELECTOR = 'div.hours';

/**
 * @param {string} para
 * @returns {boolean}
 */
function isDiningQuoteParagraph(para) {
  const lines = String(para || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return false;
  }
  const isAttribution = (line) =>
    line.length <= 48 && /^[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*)*\.?\s*$/u.test(line);
  const isQuotedBody = (line) =>
    line.length >= 12 &&
    (/^[""「『"\u201c\u2018]/.test(line) || /[""」』"\u201d\u2019]\s*$/.test(line));
  if (lines.length === 1) {
    return isQuotedBody(lines[0]) || isAttribution(lines[0]);
  }
  if (lines.length === 2 && isQuotedBody(lines[0]) && isAttribution(lines[1])) {
    return true;
  }
  return lines.every((line) => isQuotedBody(line) || isAttribution(line));
}

/**
 * Remove guest-quote blocks from dining copy unless the Excel expected text includes them.
 * @param {string} actual
 * @param {string} [expected]
 * @returns {string}
 */
function stripDiningQuotesUnlessInExpected(actual, expected = '') {
  const raw = String(actual || '').trim();
  if (!raw) {
    return '';
  }
  const chunks = raw.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (!chunks.length) {
    return raw;
  }
  const kept = [];
  for (const chunk of chunks) {
    if (!isDiningQuoteParagraph(chunk)) {
      kept.push(chunk);
      continue;
    }
    if (
      expected &&
      (textsMatchExpected(chunk, expected) || compareTextIncludes(expected, chunk))
    ) {
      kept.push(chunk);
    }
  }
  return kept.join('\n\n').trim();
}

/**
 * Some LHW dining templates stitch the same `<p>` copy twice (mid-word). Keep one clean copy.
 * @param {string} text
 * @returns {string}
 */
function collapseStutteredDiningCopy(text) {
  const s = String(text || '').trim();
  if (s.length < 80) {
    return s;
  }

  const anchorLen = Math.min(48, Math.max(28, Math.floor(s.length * 0.12)));
  const anchor = s.slice(0, anchorLen);
  if (anchor.length < 20) {
    return s;
  }

  const searchFrom = Math.max(anchor.length, Math.floor(s.length * 0.18));
  const marker = anchor.slice(0, Math.min(32, anchor.length));
  let repeatIdx = s.indexOf(marker, searchFrom);
  while (repeatIdx > 0) {
    const prev = s.charAt(repeatIdx - 1);
    const curr = s.charAt(repeatIdx);
    if (/[\p{L}]/u.test(prev) && /[\p{L}]/u.test(curr) && prev === prev.toLowerCase() && curr === curr.toLowerCase()) {
      repeatIdx = s.indexOf(marker, repeatIdx + 1);
      continue;
    }
    break;
  }
  if (repeatIdx <= 0) {
    return s;
  }

  let candidate = s.slice(repeatIdx).trim();
  const thirdIdx = candidate.toLowerCase().indexOf(anchor.slice(0, 24).toLowerCase(), anchorLen + 8);
  if (thirdIdx > 0) {
    candidate = candidate.slice(0, thirdIdx).trim();
  }

  candidate = candidate
    .replace(/\.\s*s\s+m[aá]s\s+ic[oó]nic[\s\S]+$/i, '.')
    .replace(/\.\s*s\s+more\s+iconic[\s\S]+$/i, '.')
    .trim();

  if (
    candidate.length >= Math.floor(s.length * 0.32) &&
    candidate.length <= Math.ceil(s.length * 0.72)
  ) {
    return candidate;
  }
  return s;
}

/**
 * Lines that belong to hours / chef / reservations — not the restaurant blurb.
 * @param {string} line
 * @returns {boolean}
 */
function isDiningMetaLine(line) {
  const lower = String(line || '')
    .trim()
    .toLowerCase();
  if (!lower) {
    return true;
  }
  if (isHoursSectionLabelText(line)) {
    return true;
  }
  if (
    /^executive chef\b|^chef ex[ée]cutif\b|^chef esecutivo\b|^chef ejecutivo\b|^エグゼクティブシェフ/.test(
      lower,
    )
  ) {
    return true;
  }
  if (
    /^for reservations\b|^pour r[ée]server\b|^prenotazioni\b|^para reservas\b|^reservierungen\b|^予約/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/^\+?\d[\d\s().-]{7,}\d$/.test(String(line || '').trim())) {
    return true;
  }
  if (looksLikeDiningHoursLine(line)) {
    return true;
  }
  return false;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function looksLikeDiningHoursLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length < 6) {
    return false;
  }
  if (!/\d{1,2}\s*[:\uFF1Ah]\s*\d{2}/i.test(t)) {
    return false;
  }
  const lower = t.toLowerCase();
  return (
    /breakfast|brunch|lunch|dinner|weekend|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|late night|last order|afternoon tea|desayuno|almuerzo|cena|petit d[ée]jeuner|d[ée]jeuner|d[iî]ner|colazione|pranzo|cena|朝食|ランチ|ディナー|ブランチ|営業/i.test(
      lower,
    ) || (t.length < 120 && (t.match(/\d{1,2}\s*[:\uFF1Ah]\s*\d{2}/gi) || []).length >= 1)
  );
}

/**
 * Remove inline / concatenated operation-hours copy from dining text.
 * @param {string} text
 * @returns {string}
 */
function stripInlineOperationHours(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const kept = lines.filter((line) => !looksLikeDiningHoursLine(line) && !isHoursSectionLabelText(line));
  if (kept.length) {
    return kept.join('\n\n').trim();
  }
  const single = String(text || '').trim();
  if (!single) {
    return '';
  }
  const cutMarkers = [
    /\bBreakfast\b/i,
    /\bBrunch\b/i,
    /\bLunch\b/i,
    /\bDinner\b/i,
    /\bWeekends?\b/i,
    /\bWeekdays?\b/i,
    /\bMonday\b/i,
    /\bHOURS OF OPERATION\b/i,
  ];
  let cutAt = single.length;
  for (const re of cutMarkers) {
    const m = re.exec(single);
    if (m && typeof m.index === 'number' && m.index > 40 && m.index < cutAt) {
      cutAt = m.index;
    }
  }
  return single.slice(0, cutAt).trim();
}

/**
 * @param {{ name?: string, text?: string, description?: string, hours?: string }} [outlet]
 * @param {string} [expected]
 * @returns {string}
 */
function deriveDiningOutletDescription(outlet, expected = '') {
  if (!outlet) {
    return '';
  }
  const direct = cleanDiningOutletDescription(
    stripDiningQuotesUnlessInExpected(String(outlet.description || '').trim(), expected),
  );
  if (normalizeText(direct)) {
    return direct;
  }
  let remainder = String(outlet.text || '').trim();
  const name = String(outlet.name || '').trim();
  const hours = String(outlet.hours || '').trim();
  if (name) {
    const nameNorm = normalizeText(name);
    if (normalizeText(remainder) === nameNorm) {
      remainder = '';
    } else if (remainder.toLowerCase().startsWith(name.toLowerCase())) {
      remainder = remainder.slice(name.length).trim();
    }
  }
  if (hours && remainder.includes(hours)) {
    remainder = remainder.replace(hours, '').trim();
  }
  remainder = stripInlineOperationHours(remainder);
  return cleanDiningOutletDescription(
    stripDiningQuotesUnlessInExpected(remainder, expected),
  );
}

/**
 * Keep only the prose restaurant description — no name, hours, chef, or phone lines.
 * @param {string} raw
 * @returns {string}
 */
function cleanDiningOutletDescription(raw) {
  const collapsed = collapseStutteredDiningCopy(String(raw || '').trim());
  if (!collapsed) {
    return '';
  }
  const chunks = collapsed.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (chunks.length <= 1) {
    const lines = collapsed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !isDiningMetaLine(line));
    return lines.join('\n\n').trim() || collapsed;
  }
  const kept = chunks.filter((chunk) => {
    const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length || lines.every((line) => isDiningMetaLine(line))) {
      return false;
    }
    return !lines.every((line) => line.length < 40 && isDiningMetaLine(line));
  });
  const cleaned = kept
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !isDiningMetaLine(line))
        .join('\n\n'),
    )
    .filter(Boolean)
    .join('\n\n')
    .trim();
  return cleaned || collapsed;
}

/**
 * @param {{ name?: string, text?: string, description?: string, hours?: string }} outlet
 * @param {string} [expected]
 * @returns {{ name: string, text: string, description: string, hours: string }}
 */
function sanitizeDiningOutletRecord(outlet, expected = '') {
  const name = String(outlet?.name || '').trim();
  const hours = String(outlet?.hours || '').trim();
  const description = cleanDiningOutletDescription(
    stripDiningQuotesUnlessInExpected(outlet?.description || '', expected),
  );
  let text = collapseStutteredDiningCopy(
    stripDiningQuotesUnlessInExpected(outlet?.text || '', expected),
  );
  const rebuilt = [name, description, hours].filter((part) => normalizeText(part)).join('\n\n');
  if (rebuilt) {
    text = rebuilt;
  }
  return { name, text, description, hours };
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null>}
 */
/**
 * Intro copy on `/services-amenities/dining` before the first restaurant / hours block.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readDiningOverviewOnCurrentPage(page) {
  return page
    .evaluate(() => {
      const cleanLine = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
      const textFrom = (el) => {
        if (!el) {
          return '';
        }
        const raw =
          el.innerText && String(el.innerText).trim().length > 0 ? el.innerText : el.textContent;
        return String(raw || '')
          .replace(/\u00a0/g, ' ')
          .split(/\r?\n/)
          .map((line) => cleanLine(line))
          .filter(Boolean)
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };
      const outletBoundarySel =
        'div.hours, .restaurant-item, .details, article[class*="restaurant"], [class*="venue"], li[class*="restaurant"]';
      const quoteSel = '.display-quote, .col-12.display-quote, p.quote, p.quote-name';
      const isInsideOutlet = (el) => Boolean(el?.closest?.(outletBoundarySel));
      const isQuote = (el) =>
        Boolean(
          el?.closest?.(quoteSel) || el?.matches?.('p.quote, p.quote-name, .quote-name'),
        );
      const isBefore = (el, boundary) => {
        if (!el || !boundary) {
          return true;
        }
        return Boolean(el.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING);
      };

      const root =
        document.querySelector('#main-content .tab-page-content') ||
        document.querySelector('#main-content') ||
        document.querySelector('main');
      if (!root) {
        return '';
      }

      const firstBoundary = root.querySelector(outletBoundarySel);
      /** @type {string[]} */
      const parts = [];

      for (const el of root.querySelectorAll('p, .subheader, [class*="subheader"], .font-amiri')) {
        if (!isBefore(el, firstBoundary)) {
          continue;
        }
        if (isInsideOutlet(el)) {
          continue;
        }
        if (isQuote(el)) {
          continue;
        }
        const t = textFrom(el);
        if (t.length > 15) {
          parts.push(t);
        }
      }

      return [...new Set(parts)].join('\n\n').trim();
    })
    .catch(() => '');
}

async function scrapeDiningOutletsFromPage(page) {
  await page
    .locator(DINING_OPERATION_HOURS_SELECTOR)
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(150);

  return page
    .evaluate((hoursSelector) => {
      const cleanLine = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
      const quoteSelector =
        '.display-quote, .col-12.display-quote, p.quote, p.quote-name, .review p.quote';
      const isInsideDiningQuote = (el) =>
        Boolean(
          el &&
            (el.matches?.('p.quote, p.quote-name') ||
              el.closest?.('.display-quote, .col-12.display-quote')),
        );
      const textFrom = (el) => {
        if (!el) {
          return '';
        }
        const raw =
          el.innerText && String(el.innerText).trim().length > 0 ? el.innerText : el.textContent;
        return String(raw || '')
          .replace(/\u00a0/g, ' ')
          .split(/\r?\n/)
          .map((line) => cleanLine(line))
          .filter(Boolean)
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      };
      const normalizeHours = (raw) => {
        const lines = String(raw || '')
          .replace(/\u00a0/g, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .split(/\r?\n/)
          .map((line) => cleanLine(line))
          .filter(Boolean);
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      };
      const normalizeLabel = (t) =>
        cleanLine(t)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/:\s*$/, '')
          .toLowerCase();
      const isHoursLabel = (t) => {
        const x = normalizeLabel(t);
        return (
          x === 'hours of operation' ||
          x === 'operation hours' ||
          x === 'opening hours' ||
          x === 'dining hours' ||
          x === 'restaurant hours' ||
          x === 'hours' ||
          x === 'horario de atencion' ||
          x === 'horarios de atencion' ||
          x === 'offnungszeiten' ||
          x === 'oeffnungszeiten' ||
          x === 'offnungszeit' ||
          x === 'oeffnungszeit' ||
          x === 'orario di apertura' ||
          x === 'orari di apertura' ||
          x === 'horaire d ouverture' ||
          x === "horaire d'ouverture" ||
          x === 'horaires d ouverture' ||
          x === "horaires d'ouverture" ||
          x === '営業時間'
        );
      };
      const skipRestaurantTitle = (t) => {
        const x = cleanLine(t);
        if (!x || x.length < 2 || x.length > 160 || isHoursLabel(x)) {
          return true;
        }
        const lower = x.toLowerCase();
        return (
          /^(dining|restaurants?|gastronomy|bars?|services|amenities|overview|our restaurants)$/i.test(
            lower,
          ) ||
          /^executive chef|^for reservations|^level \d|^the .* hotel$/i.test(x)
        );
      };
      const looksLikeHoursLine = (line) => {
        const trimmed = cleanLine(line);
        if (!trimmed || isHoursLabel(trimmed)) {
          return true;
        }
        if (!/\d{1,2}\s*[:\uFF1Ah]\s*\d{2}/i.test(trimmed)) {
          return false;
        }
        const lower = trimmed.toLowerCase();
        return (
          /breakfast|brunch|lunch|dinner|weekend|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|late night|last order|afternoon tea|desayuno|almuerzo|cena|petit d[ée]jeuner|d[ée]jeuner|d[iî]ner|colazione|pranzo|朝食|ランチ|ディナー|ブランチ/i.test(
            lower,
          ) || trimmed.length < 140
        );
      };
      const descriptionFromSection = (sectionRoot, titleName, hoursEl) => {
        const nameNorm = cleanLine(titleName).toLowerCase();
        const parts = [];
        const pushLine = (line) => {
          const trimmed = cleanLine(line);
          if (!trimmed || trimmed.toLowerCase() === nameNorm || isHoursLabel(trimmed)) {
            return;
          }
          if (
            /^executive chef|^chef exécutif|^chef esecutivo|^chef ejecutivo|^エグゼクティブシェフ/i.test(
              trimmed,
            ) ||
            /^for reservations|^pour réserver|^prenotazioni|^para reservas|^reservierungen|^予約/i.test(
              trimmed,
            ) ||
            /^\+?\d[\d\s().-]{7,}\d$/.test(trimmed) ||
            /akrotiri,\s*zakynthos/i.test(trimmed) ||
            looksLikeHoursLine(trimmed)
          ) {
            return;
          }
          parts.push(trimmed);
        };
        for (const p of sectionRoot.querySelectorAll('p')) {
          if (isInsideDiningQuote(p)) {
            continue;
          }
          if (hoursEl && (hoursEl.contains(p) || p.closest('.hours-of-operation'))) {
            continue;
          }
          pushLine(p.innerText || p.textContent);
        }
        return parts.join('\n\n').trim();
      };
      const descriptionBeforeHours = (hoursEl, titleName, hoursSelector) => {
        /** @type {string[]} */
        const parts = [];
        const nameNorm = cleanLine(titleName).toLowerCase();
        let node = hoursEl.previousElementSibling;
        for (let i = 0; i < 12 && node; i++) {
          if (node.matches?.(hoursSelector) || node.querySelector?.(hoursSelector)) {
            break;
          }
          if (/^H[1-6]$/i.test(node.tagName)) {
            const heading = cleanLine(node.innerText || node.textContent);
            if (heading && heading.toLowerCase() !== nameNorm && !isHoursLabel(heading)) {
              break;
            }
          }
          const collectFrom = (el) => {
            if (!el || isInsideDiningQuote(el)) {
              return;
            }
            const t = cleanLine(el.innerText || el.textContent);
            if (t.length > 25 && !looksLikeHoursLine(t) && !isHoursLabel(t) && t.toLowerCase() !== nameNorm) {
              parts.unshift(t);
            }
          };
          if (node.matches?.('p, .subheader, [class*="subheader"]')) {
            collectFrom(node);
          } else {
            for (const p of node.querySelectorAll?.('p, .subheader, [class*="subheader"]') || []) {
              collectFrom(p);
            }
          }
          node = node.previousElementSibling;
        }
        if (parts.length) {
          return parts.join('\n\n').trim();
        }
        const sectionRoot = sectionRootForHours(hoursEl, hoursSelector);
        return descriptionFromSection(sectionRoot || hoursEl.parentElement, titleName, hoursEl);
      };
      const outletNameFor = (hoursEl) => {
        const tryText = (el) => {
          if (!el || hoursEl.contains(el)) {
            return '';
          }
          const t = cleanLine(el.innerText || el.textContent);
          if (!t || t.length < 2 || t.length > 160 || isHoursLabel(t)) {
            return '';
          }
          return t;
        };

        const card =
          hoursEl.closest('.details, .restaurant-item, article, [class*="restaurant"], [class*="dining"]') ||
          hoursEl.parentElement;
        if (card) {
          for (const heading of card.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
            const t = tryText(heading);
            if (t) {
              return t;
            }
          }
        }

        const container =
          hoursEl.closest(
            'article, [class*="restaurant"], [class*="dining"], [class*="venue"], .card, .row, li, .col',
          ) || hoursEl.parentElement;
        if (container) {
          const headings = container.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,.restaurant-name,.dining-title,[class*="restaurant-name"]',
          );
          /** @type {Element[]} */
          const before = [];
          for (const el of headings) {
            if (!hoursEl.contains(el) && el.compareDocumentPosition(hoursEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
              before.push(el);
            }
          }
          for (let i = before.length - 1; i >= 0; i--) {
            const t = tryText(before[i]);
            if (t) {
              return t;
            }
          }
        }

        let prev = hoursEl.previousElementSibling;
        for (let i = 0; i < 10 && prev; i++) {
          if (/^H[1-6]$/i.test(prev.tagName)) {
            const t = tryText(prev);
            if (t) {
              return t;
            }
          }
          prev = prev.previousElementSibling;
        }
        return '';
      };
      const sectionRootForHours = (hoursEl, hoursSelector) => {
        for (let cur = hoursEl.parentElement; cur; cur = cur.parentElement) {
          if (cur === document.body || cur === document.documentElement) {
            break;
          }
          const hoursCount = cur.querySelectorAll?.(hoursSelector)?.length || 0;
          if (hoursCount === 1) {
            return cur;
          }
          if (hoursCount > 1) {
            break;
          }
        }
        return hoursEl.parentElement;
      };

      const root =
        document.querySelector('#main-content .tab-page-content') ||
        document.querySelector('#main-content') ||
        document.querySelector('main');
      if (!root) {
        return [];
      }

      /** @type {{ name: string, text: string, description: string, hours: string }[]} */
      const collected = [];
      const seenHours = new Set();
      for (const hoursEl of root.querySelectorAll(hoursSelector)) {
        const hours = normalizeHours(hoursEl.innerText || hoursEl.textContent);
        if (hours.length < 4) {
          continue;
        }
        const hoursKey = hours.toLowerCase();
        if (seenHours.has(hoursKey)) {
          continue;
        }
        seenHours.add(hoursKey);
        const name = outletNameFor(hoursEl);
        if (!name || skipRestaurantTitle(name)) {
          continue;
        }
        const sectionRoot = sectionRootForHours(hoursEl, hoursSelector);
        const description = descriptionBeforeHours(hoursEl, name, hoursSelector);
        const text = [name, description, hours].filter(Boolean).join('\n\n').trim();
        const key = name.toLowerCase();
        const existing = collected.find((o) => cleanLine(o.name).toLowerCase() === key);
        if (existing) {
          if (description.length > String(existing.description || '').length) {
            existing.description = description;
          }
          if (hours.length > String(existing.hours || '').length) {
            existing.hours = hours;
          }
          existing.text = [name, existing.description, existing.hours].filter(Boolean).join('\n\n');
          continue;
        }
        collected.push({ name, text, description, hours });
      }

      const upsertOutlet = (name, description, hours) => {
        const cleanName = cleanLine(name);
        if (!cleanName || skipRestaurantTitle(cleanName)) {
          return;
        }
        const cleanHours = normalizeHours(hours);
        const cleanDesc = cleanLine(description);
        const key = cleanName.toLowerCase();
        const existing = collected.find((o) => cleanLine(o.name).toLowerCase() === key);
        const text = [cleanName, cleanDesc, cleanHours].filter(Boolean).join('\n\n').trim();
        if (existing) {
          if (cleanDesc.length > String(existing.description || '').length) {
            existing.description = cleanDesc;
          }
          if (cleanHours.length > String(existing.hours || '').length) {
            existing.hours = cleanHours;
          }
          existing.text = [cleanName, existing.description, existing.hours]
            .filter(Boolean)
            .join('\n\n');
          return;
        }
        if (!text) {
          return;
        }
        collected.push({
          name: cleanName,
          text,
          description: cleanDesc,
          hours: cleanHours,
        });
      };

      const titleSelectors = [
        'h3.heading-xx-large.name',
        'h3.name.heading-xx-large',
        'h3.restaurant-name',
        '.restaurant-item h3',
        '.details h3.name',
      ];
      const seenTitles = new Set();
      for (const sel of titleSelectors) {
        for (const titleEl of root.querySelectorAll(sel)) {
          const name = cleanLine(textFrom(titleEl));
          if (!name || skipRestaurantTitle(name)) {
            continue;
          }
          const titleKey = name.toLowerCase();
          if (seenTitles.has(titleKey)) {
            continue;
          }
          seenTitles.add(titleKey);
          const details =
            titleEl.closest('.details, .restaurant-item, article, [class*="restaurant"]') ||
            titleEl.parentElement;
          if (!details) {
            upsertOutlet(name, '', '');
            continue;
          }
          const hoursEl = details.querySelector(hoursSelector);
          const hours = hoursEl ? textFrom(hoursEl) : '';
          /** @type {string[]} */
          const descParts = [];
          for (const p of details.querySelectorAll('p')) {
            if (isInsideDiningQuote(p)) {
              continue;
            }
            if (hoursEl && (hoursEl.contains(p) || p.closest('.hours-of-operation'))) {
              continue;
            }
            const t = cleanLine(textFrom(p));
            if (!t || t.toLowerCase() === titleKey || isHoursLabel(t) || looksLikeHoursLine(t)) {
              continue;
            }
            if (t.length > 20) {
              descParts.push(t);
            }
          }
          upsertOutlet(name, descParts.join('\n\n'), hours);
        }
      }

      return collected;
    }, DINING_OPERATION_HOURS_SELECTOR)
    .catch(() => []);
}

async function readDiningOutletBlocksOnCurrentPage(page) {
  /** @type {{ name: string, text: string, description?: string, hours?: string }[]} */
  let outlets = await scrapeDiningOutletsFromPage(page);

  outlets = outlets
    .map((o, i) => {
      let name = String(o.name || '').trim();
      if (!name || isHoursSectionLabelText(name)) {
        name = `Dining outlet ${i + 1}`;
      }
      return {
        name,
        text: String(o.text || '').trim(),
        description: String(o.description || '').trim(),
        hours: normalizeOperationHours(o.hours || ''),
      };
    })
    .filter((o) => normalizeText(o.text))
    .map((o) => sanitizeDiningOutletRecord(o));

  return outlets.length ? { outlets } : null;
}

/**
 * Normalize operation-hours copy (preserve readable line breaks).
 * @param {string} text
 * @returns {string}
 */
function normalizeOperationHours(text) {
  const lines = String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.replace(/[ \t]+/g, ' ').trim();
      return trimmed.replace(/^(Breakfast|Lunch|Dinner|Brunch)\s*:?\s*$/i, '$1');
    })
    .filter((line) => line && !isHoursSectionLabelText(line));

  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    if (!line && out.length > 0 && out[out.length - 1] === '') {
      continue;
    }
    out.push(line);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalize localized clock formats (French "12 h 30", Japanese ～, Spanish "de/a", German "Uhr").
 * @param {string} text
 * @returns {string}
 */
function canonicalizeLocalizedClockTimes(text) {
  let s = String(text || '');
  s = s.replace(/\uFF1A/g, ':');
  s = s.replace(/[～〜]/g, ' - ');
  s = s.replace(/\bde\s+/gi, ' ');
  s = s.replace(/\s+a\s+/gi, ' - ');
  s = s.replace(/\s*uhr\b/gi, '');
  s = s.replace(/(\d{1,2})\s*h\s*(\d{2})(?=\s*(?:-|–|—|$|\)|,))/gi, (_, h, m) => {
    return `${String(h).padStart(2, '0')}:${m}`;
  });
  s = s.replace(/(\d{1,2})\s*h\s*(?=-\s*(\d{1,2})\s*h\s*(\d{2}))/gi, (_, h) => {
    return `${String(h).padStart(2, '0')}:00 - `;
  });
  s = s.replace(/-\s*(\d{1,2})\s*h\s*(\d{2})/gi, (_, h, m) => {
    return `- ${String(h).padStart(2, '0')}:${m}`;
  });
  s = s.replace(/(\d{1,2})\s*h(?=\b)/gi, (_, h) => `${String(h).padStart(2, '0')}:00`);
  s = s.replace(/(\d{1,2})h(\d{2})/gi, (_, h, m) => `${String(h).padStart(2, '0')}:${m}`);
  return s;
}

/** Colon times or French-style `12 h 30` / `19 h 00` (passed into `page.evaluate`). */
const LOCALIZED_CLOCK_TIME_PATTERN = String.raw`\d{1,2}\s*:\s*\d{2}|\d{1,2}\s*h\s*\d{2}|\d{1,2}\s*h(?=\s*(?:\d{2}\b|-|–|—|$))`;

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasLocalizedClockTime(text) {
  return new RegExp(LOCALIZED_CLOCK_TIME_PATTERN, 'i').test(String(text || ''));
}

const MONTH_NAME_TO_NUM = {
  january: '01',
  januar: '01',
  enero: '01',
  janvier: '01',
  gennaio: '01',
  february: '02',
  februar: '02',
  febrero: '02',
  fevrier: '02',
  febbraio: '02',
  march: '03',
  marz: '03',
  marzo: '03',
  mars: '03',
  april: '04',
  abril: '04',
  avril: '04',
  aprile: '04',
  may: '05',
  mai: '05',
  maggio: '05',
  mayo: '05',
  june: '06',
  juni: '06',
  junio: '06',
  juin: '06',
  giugno: '06',
  july: '07',
  juli: '07',
  julio: '07',
  juillet: '07',
  luglio: '07',
  august: '08',
  agosto: '08',
  aout: '08',
  août: '08',
  september: '09',
  septiembre: '09',
  septembre: '09',
  settembre: '09',
  october: '10',
  oktober: '10',
  octubre: '10',
  octobre: '10',
  ottobre: '10',
  november: '11',
  noviembre: '11',
  novembre: '11',
  december: '12',
  dezember: '12',
  diciembre: '12',
  decembre: '12',
  dicembre: '12',
};

/**
 * @param {string} text
 * @returns {string}
 */
function operationHoursSeasonTokens(text) {
  const lower = normalizeText(canonicalizeLocalizedClockTimes(text))
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  /** @type {string[]} */
  const nums = [];
  for (const [name, num] of Object.entries(MONTH_NAME_TO_NUM)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(lower)) {
      nums.push(num);
    }
  }
  for (const m of lower.matchAll(/(\d{1,2})\s*月/g)) {
    nums.push(String(m[1]).padStart(2, '0'));
  }
  if (nums.length >= 2) {
    return [...new Set(nums)].sort().join('|');
  }
  return '';
}

/**
 * Compare key for operation hours — ignores label colons and line-break layout differences.
 * @param {string} text
 * @returns {string}
 */
function normalizeOperationHoursForCompare(text) {
  let s = canonicalizeLocalizedClockTimes(normalizeOperationHours(text));
  s = normalizeText(s).toLowerCase();
  s = s.replace(
    /\b(breakfast|brunch|lunch|dinner|weekends?|weekdays?|weekday|fitness|massage|pool|gym|sauna|hammam|wellness|spa|desayuno|almuerzo|cena|petit dejeuner|dejeuner|diner|colazione|pranzo|朝食|ランチ|ディナー|ブランチ)\s*:\s*/gi,
    '$1 ',
  );
  s = s.replace(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|monday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lunes|martes|miercoles|jueves|viernes|sabado|domingo|mercoledi|giovedi|venerdi|domenica|lunedi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s*-\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lunes|martes|miercoles|jueves|viernes|sabado|domingo|mercoledi|giovedi|venerdi|domenica|lunedi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))?\s*:\s*/gi,
    '$1$2 ',
  );
  s = s.replace(/\b(last order|late night|until late|todos los dias|täglich|daily|quotidien|tous les jours|ogni giorno|毎日)\s*:\s*/gi, '$1 ');
  s = s.replace(/\s*:\s*(?=\d{1,2}\s*:)/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Extract sorted clock times for schedule comparison.
 * @param {string} s normalized compare string
 * @returns {string}
 */
function operationHoursTimeTokens(s) {
  const canonical = canonicalizeLocalizedClockTimes(s);
  return [...String(canonical || '').matchAll(/\d{1,2}\s*:\s*\d{2}/g)]
    .map((m) => m[0].replace(/\s/g, ''))
    .sort()
    .join('|');
}

/** @type {Record<string, RegExp>} */
const OPERATION_HOURS_LANGUAGE_DAY_PATTERNS = {
  en: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  es: /\b(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/i,
  fr: /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i,
  de: /\b(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i,
  it: /\b(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b/i,
  ja: /[月火水木金土日]曜日|平日|土曜|日曜/,
};

/**
 * Detect weekday language markers in hours text (normalized, accents stripped).
 * @param {string} text
 * @returns {Set<string>}
 */
function operationHoursLanguagesFromText(text) {
  const normalized = normalizeText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  /** @type {Set<string>} */
  const langs = new Set();
  for (const [code, pattern] of Object.entries(OPERATION_HOURS_LANGUAGE_DAY_PATTERNS)) {
    if (pattern.test(normalized)) {
      langs.add(code);
    }
  }
  return langs;
}

/**
 * True when both strings name weekdays but in different languages (e.g. Spanish expected, English actual).
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function operationHoursLanguageMismatch(actual, expected) {
  const actualLangs = operationHoursLanguagesFromText(actual);
  const expectedLangs = operationHoursLanguagesFromText(expected);
  if (!actualLangs.size || !expectedLangs.size) {
    return false;
  }
  for (const lang of expectedLangs) {
    if (actualLangs.has(lang)) {
      return false;
    }
  }
  return true;
}

/**
 * Match dining or spa operation hours — ignores label colons and line-break layout.
 * Clock times may match across formatting, but weekday language must align when both sides name days.
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
function textsMatchOperationHours(actual, expected) {
  if (operationHoursLanguageMismatch(actual, expected)) {
    return false;
  }
  const a = normalizeOperationHoursForCompare(actual);
  const e = normalizeOperationHoursForCompare(expected);
  if (!a || !e) {
    return false;
  }
  if (a === e || a.includes(e) || e.includes(a)) {
    return true;
  }
  const aTimes = operationHoursTimeTokens(a);
  const eTimes = operationHoursTimeTokens(e);
  if (aTimes && eTimes && aTimes === eTimes) {
    return true;
  }
  const aSeason = operationHoursSeasonTokens(actual);
  const eSeason = operationHoursSeasonTokens(expected);
  if (aSeason && eSeason && aSeason === eSeason) {
    return true;
  }
  if (!aTimes && !eTimes && aSeason && eSeason) {
    return aSeason === eSeason;
  }
  return false;
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ outlets: { name: string, hours: string }[] } | null>}
 */
async function readDiningOperationHoursOnCurrentPage(page) {
  /** @type {{ name: string, text: string, description?: string, hours?: string }[]} */
  let outlets = await scrapeDiningOutletsFromPage(page);

  if (!outlets.length) {
    const loc = page.locator(DINING_OPERATION_HOURS_SELECTOR);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      try {
        const inner = await loc.nth(i).innerText({ timeout: 10_000 });
        const hours = normalizeOperationHours(inner);
        if (!normalizeText(hours)) {
          continue;
        }
        outlets.push({
          name: `Dining outlet ${outlets.length + 1}`,
          text: hours,
          description: '',
          hours,
        });
      } catch {
        // next
      }
    }
  }

  const hoursOutlets = outlets
    .map((o, i) => {
      let name = String(o.name || '').trim();
      if (!name || isHoursSectionLabelText(name)) {
        name = `Dining outlet ${i + 1}`;
      }
      return {
        name,
        hours: normalizeOperationHours(o.hours),
      };
    })
    .filter((o) => normalizeText(o.hours));

  if (!hoursOutlets.length) {
    return null;
  }

  return { outlets: hoursOutlets };
}

/**
 * Format operation hours for logs / UI previews.
 * @param {{ outlets: { name: string, hours: string }[] } | null} operationHours
 * @returns {string}
 */
function formatOperationHoursForPreview(operationHours) {
  if (!operationHours?.outlets?.length) {
    return '';
  }
  return operationHours.outlets
    .map((o, i) => {
      const label = o.name || `Dining outlet ${i + 1}`;
      return `Hours of Operation — ${label}\n${o.hours}`;
    })
    .join('\n\n---\n\n');
}

/** @param {import('playwright').Page} page */
async function readDiningServicesBlock(page, hotelPageUrl, languageCode, options = {}) {
  const hoursHolder = { value: /** @type {{ outlets: { name: string, hours: string }[] } | null} */ (null) };
  const outletBlocksHolder = { value: /** @type {{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null} */ (null) };
  const block = await readServicesAmenitiesBlock(
    page,
    hotelPageUrl,
    languageCode,
    'dining',
    null,
    hoursHolder,
    outletBlocksHolder,
    options,
  );
  let overviewText = '';
  if (!options.diningHoursOnly) {
    overviewText = String((await readDiningOverviewOnCurrentPage(page)) || '').trim();
  }
  const trimmedBlock = String(block || '').trim();
  const resolvedOverview =
    normalizeText(overviewText).length >= 40 ? overviewText : trimmedBlock;
  return {
    block: resolvedOverview || trimmedBlock,
    overviewText: resolvedOverview || trimmedBlock,
    operationHours: hoursHolder.value,
    outletBlocks: outletBlocksHolder.value,
  };
}

/** @param {import('playwright').Page} page */
async function readSpaServicesBlock(page, hotelPageUrl, languageCode) {
  const spaParts = { title: '', description: '', hours: '' };
  const block = await readServicesAmenitiesBlock(page, hotelPageUrl, languageCode, 'spa', spaParts);
  let hours = normalizeSpaHoursText(spaParts.hours || '');
  if (!normalizeText(hours)) {
    hours = normalizeSpaHoursText(await readSpaHoursOnCurrentPage(page));
  }
  return {
    block: String(block || '').trim(),
    title: String(spaParts.title || '').trim(),
    description: String(spaParts.description || '').trim(),
    hours,
  };
}

/**
 * Run one comparison pass: open URL, switch locale, read page text, compare each row.
 *
 * @param {object} opts
 * @param {string} opts.excelPath
 * @param {string} opts.languageCode ENG | GER | ...
 * @param {string} opts.pageUrl hotel deep link; host is rewritten to match opts.languageCode
 * @param {boolean} [opts.headless]
 * @param {import('playwright').Browser} [opts.sharedBrowser] Reuse one browser across languages (faster multi-lang runs).
 * @param {() => boolean} [opts.shouldAbort] When true, stop scraping and close the browser.
 * @returns {Promise<{ results: object[], diningMeta: object, spaMeta: object, propertySearchMeta: object, propertyOverviewSpecialMeta: object, propertyHighlightMeta: object, messageBannerMeta: object, specialNoticeMessage: string|null, specialNoticeMessages: string[], operationHours: { outlets: { name: string, hours: string }[] } | null, hotelName: string }>}
 */
async function runComparison({
  excelPath,
  languageCode,
  pageUrl,
  headless = true,
  sharedBrowser = undefined,
  shouldAbort = undefined,
}) {
  const lang = String(languageCode || '')
    .trim()
    .toUpperCase();
  const rows = readContentSheet(excelPath);
  /** Rows with non-empty English (ENG) source — only these are compared. */
  const searchableRows = rows.filter(rowHasEnglishContent);
  // eslint-disable-next-line no-console
  console.log(
    `[Runner] Starting comparison (language=${lang}, rows=${rows.length}, searchableRows=${searchableRows.length}, url=${pageUrl})`,
  );
  const needsLocalInfoBlock = searchableRows.some((r) => isLocalInformationSectionLabel(r.section));
  const diningPathPasted = isDiningServicesPath(pageUrl);
  const spaPathPasted = isSpaServicesPath(pageUrl);
  const golfPathPasted = isGolfServicesPath(pageUrl);
  const needsDiningOperationHoursBlock = searchableRows.some(
    (r) => isDiningOperationHoursSectionLabel(r.section),
  );
  const needsSpaBlockEarly =
    spaPathPasted ||
    searchableRows.some(
      (r) =>
        isSpaSectionLabel(r.section) ||
        isSpaHoursSectionLabel(r.section) ||
        isGenericOperationHoursSectionLabel(r.section),
    );
  const needsHotelAmenitiesHoursBlock =
    !needsSpaBlockEarly &&
    searchableRows.some(
      (r) =>
        isSpaHoursSectionLabel(r.section) ||
        isDiningOperationHoursSectionLabel(r.section) ||
        isGenericOperationHoursSectionLabel(r.section),
    );
  const needsDiningBodyText = searchableRows.some(
    (r) =>
      (isRestaurantSectionLabel(r.section) || isDiningOverviewSectionLabel(r.section)) &&
      !isDiningOperationHoursSectionLabel(r.section),
  );
  const needsDiningOutletDetailRows = searchableRows.some((r) => {
    const s = normalizeSectionLabel(r.section);
    return (
      isRestaurantSectionLabel(r.section) &&
      !isDiningOperationHoursSectionLabel(r.section) &&
      (/\bname\b/i.test(s) || /\bdescription\b/i.test(s))
    );
  });
  const needsRestaurantBlock =
    diningPathPasted || searchableRows.some((r) => searchableRowNeedsDiningSubpage(r, lang));
  let needsGolfBlock =
    golfPathPasted || searchableRows.some((r) => searchableRowNeedsGolfSubpage(r, lang));
  const needsSpaBlock = needsSpaBlockEarly;
  const needsPropertyHighlightBlock =
    searchableRows.some((r) => isPropertyHighlightSectionLabel(r.section));
  const needsHotelPropertyOverviewBlock = searchableRows.some(
    (r) => isHotelPropertyOverviewSectionLabel(r.section) && !rowHasSpecialNote(r),
  );
  const needsHotelPropertyQuoteBlock = searchableRows.some((r) =>
    isHotelPropertyQuoteSectionLabel(r.section),
  );
  const needsPropertyOverviewSpecialBlock = searchableRows.some((r) => rowHasSpecialNote(r));
  const needsPropertySearchBlock =
    searchableRows.some((r) => isPropertySearchSectionLabel(r.section));
  const needsHotelMessageBannerBlock =
    searchableRows.some((r) => isHotelMessageBannerSectionLabel(r.section));
  const needsSpecialNoticeBlock =
    searchableRows.some((r) => isSpecialNoticeSectionLabel(r.section)) ||
    searchableRows.some((r) => rowHasSpecialNote(r));
  const hasAnyFeatureRow = searchableRows.some((r) => isFeatureSectionLabel(r.section));
  const needsHighlightTitlesBlock = searchableRows.some((r) =>
    isPropertyHighlightTitleLabel(r.section),
  );
  const needsGolfAmenityInfoBlock = searchableRows.some((r) =>
    isGolfAmenityInfoItemLabel(r.section),
  );
  const needsGolfAmenityOperationHoursBlock = searchableRows.some((r) => {
    const s = normalizeSectionLabel(r.section);
    if (isGolfHoursSectionLabel(s)) {
      return true;
    }
    return false;
  });
  if (needsGolfAmenityInfoBlock || needsGolfAmenityOperationHoursBlock) {
    needsGolfBlock = true;
  }
  const needsOverviewScrape =
    needsLocalInfoBlock ||
    needsHotelPropertyOverviewBlock ||
    needsHotelPropertyQuoteBlock ||
    needsPropertyHighlightBlock ||
    needsPropertyOverviewSpecialBlock ||
    needsHotelMessageBannerBlock ||
    needsSpecialNoticeBlock ||
    hasAnyFeatureRow ||
    needsHighlightTitlesBlock ||
    needsGolfAmenityInfoBlock ||
    needsGolfAmenityOperationHoursBlock ||
    needsHotelAmenitiesHoursBlock;

  /** @type {import('playwright').Browser | null} */
  let browser = null;

  /** @type {object[]} */
  const results = [];

  /** @type {string[]} */
  let specialNoticeMessages = [];
  /** Combined preview of all notices (UI / logs). @type {string|null} */
  let specialNoticeMessage = null;

  /** @type {{ outlets: { name: string, hours: string }[] } | null} */
  let operationHours = null;
  /** @type {{ outlets: { name: string, text: string, description?: string, hours?: string }[] } | null} */
  let diningOutletBlocks = null;

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, openedOverviewFirst: boolean, operationHours: { outlets: { name: string, hours: string }[] } | null, operationHoursPreview: string, outletBlocks: { outlets: { name: string, text: string, description?: string, hours?: string }[] } | null }} */
  const diningMeta = {
    url: needsRestaurantBlock ? buildDiningServicesUrl(pageUrl, lang) : null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    openedOverviewFirst: false,
    operationHours: null,
    operationHoursPreview: '',
    outletBlocks: null,
  };

  /** @type {{
   *   active: boolean,
   *   url: string|null,
   *   title: string,
   *   titleFound: boolean,
   *   titleSelector: string,
   *   titlePreview: string,
   *   descriptionFound: boolean,
   *   descriptionLength: number,
   *   descriptionPreview: string,
   *   preview: string,
   *   characterCount: number,
   *   fetchedText: boolean,
   *   openedOverviewFirst: boolean
   * }} */
  const spaMeta = {
    active: needsSpaBlock,
    url: needsSpaBlock ? buildSpaServicesUrl(pageUrl, lang) : null,
    title: '',
    titleFound: false,
    titleSelector: SPA_TITLE_H3_SELECTOR,
    titlePreview: '',
    descriptionFound: false,
    descriptionLength: 0,
    descriptionPreview: '',
    preview: '',
    characterCount: 0,
    fetchedText: false,
    openedOverviewFirst: false,
  };

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, openedOverviewFirst: boolean, courses: { outlets: { name: string, description: string, hours: string, text: string }[] } | null }} */
  const golfMeta = {
    url: needsGolfBlock ? buildGolfServicesUrl(pageUrl, lang) : null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    openedOverviewFirst: false,
    courses: null,
  };

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, query: string }} */
  const propertySearchMeta = {
    url: null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    query: '',
  };

  /** @type {{ active: boolean, preview: string, characterCount: number, fetchedText: boolean, selectorEmpty: boolean }} */
  const propertyOverviewSpecialMeta = {
    active: false,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    selectorEmpty: false,
  };

  /** @type {{ active: boolean, segmentCount: number, preview: string, fetchedText: boolean }} */
  const propertyHighlightMeta = {
    active: needsPropertyHighlightBlock,
    segmentCount: 0,
    preview: '',
    fetchedText: false,
  };

  /** @type {{ active: boolean, preview: string, characterCount: number, fetchedText: boolean, selector: string }} */
  const messageBannerMeta = {
    active: needsHotelMessageBannerBlock,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    selector: HOTEL_MESSAGE_BANNER_SELECTOR,
  };

  /**
   * Merged expected features for the SELECTED language. Empty when none of the 4 feature
   * rows had content for this language (or no feature rows exist at all).
   * @type {{ feature: string, sourceLabel: string }[]}
   */
  const expectedFeatures = hasAnyFeatureRow ? buildExpectedFeatures(searchableRows, lang) : [];
  const needsFeaturesBlock = expectedFeatures.length > 0;

  /**
   * Human-friendly hotel name derived from the URL slug (e.g. "Kahala Yokohama Japan").
   * Stamped on every result row so the front-end can show a "Hotel" column.
   */
  const hotelName = derivePropertySearchQueryFromUrl(pageUrl) || '';

  if (searchableRows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[Runner] No rows with English source content; skipping browser search.');
    return {
      results,
      diningMeta,
      spaMeta,
      golfMeta,
      propertySearchMeta,
      propertyOverviewSpecialMeta,
      propertyHighlightMeta,
      messageBannerMeta,
      specialNoticeMessage,
      specialNoticeMessages,
      operationHours,
      hotelName,
    };
  }

  /** @type {import('playwright').BrowserContext | null} */
  let context = null;
  const ownsBrowser = !sharedBrowser;

  const langRunStartedAt = Date.now();

  try {
    browser = sharedBrowser || (await launchRunBrowser(headless));
    if (ownsBrowser) {
      setActiveRunBrowser(browser);
    }
    throwIfAborted(shouldAbort);

    context = await createRunContext(browser, lang);
    const page = await context.newPage();

    const finalUrl = buildUrlForLanguage(pageUrl, lang);
    const overviewNavUrl = buildHotelOverviewUrl(pageUrl, lang);
    const firstNavUrl = overviewNavUrl || finalUrl;
    if (needsSpaBlock && !spaMeta.url) {
      spaMeta.url = buildSpaServicesUrl(firstNavUrl, lang);
    }
    if (needsGolfBlock && !golfMeta.url) {
      golfMeta.url = buildGolfServicesUrl(firstNavUrl, lang);
    }
    const openedOverviewFirst = Boolean(overviewNavUrl && overviewNavUrl !== finalUrl);
    diningMeta.openedOverviewFirst = openedOverviewFirst;
    spaMeta.openedOverviewFirst = openedOverviewFirst;
    golfMeta.openedOverviewFirst = openedOverviewFirst;

    let propertySearchDesc = '';
    const propertySearchPromise = needsPropertySearchBlock
      ? runPropertySearchAndReadHotelDesc(context, firstNavUrl, lang)
      : null;

    let mainPageText = '';
    const diningLoadOptions = {
      skipDiningOutletBlocks: !needsDiningOutletDetailRows,
      diningHoursOnly: !needsDiningBodyText,
    };
    const needsAnySubpage = needsRestaurantBlock || needsSpaBlock || needsGolfBlock;
    /** @type {Promise<{ diningRes: object|null, spaRes: object|null, golfRes: object|null }>} */
    let subpagesPromise = Promise.resolve({ diningRes: null, spaRes: null, golfRes: null });

    if (needsOverviewScrape) {
      const scrapeStartedAt = Date.now();
      await gotoPageCommit(page, firstNavUrl);
      throwIfAborted(shouldAbort);
      await dismissOptionalCookieBanner(page);
      await page.locator('#main-content').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});

      if (needsAnySubpage) {
        // eslint-disable-next-line no-console
        console.log('[Runner] Loading dining + spa + golf subpages in parallel (while overview scrapes)…');
        subpagesPromise = loadSubpagesParallel(context, {
          firstNavUrl,
          lang,
          needsRestaurantBlock,
          needsSpaBlock,
          needsGolfBlock,
          diningLoadOptions,
          shouldAbort,
          needsGolfAmenityScrape:
            needsGolfAmenityInfoBlock || needsGolfAmenityOperationHoursBlock,
        });
      }

      if (needsLocalInfoBlock) {
        await waitForLocalInformationSection(page);
        try {
          const main = page.locator('main').first();
          if (await main.count()) {
            mainPageText = await main.innerText({ timeout: 6_000 });
          } else {
            mainPageText = await page.locator('body').innerText({ timeout: 6_000 });
          }
        } catch {
          mainPageText = await page.innerText('body').catch(() => '');
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[Runner] Overview navigation + setup: ${Date.now() - scrapeStartedAt}ms`);
    } else if (needsAnySubpage) {
      // eslint-disable-next-line no-console
      console.log('[Runner] Fast path: subpages only (no overview scrape).');
      subpagesPromise = loadSubpagesParallel(context, {
        firstNavUrl,
        lang,
        needsRestaurantBlock,
        needsSpaBlock,
        needsGolfBlock,
        diningLoadOptions,
        shouldAbort,
        needsGolfAmenityScrape:
          needsGolfAmenityInfoBlock || needsGolfAmenityOperationHoursBlock,
      });
    }

    /**
     * Raw text from `section.features` on the hotel overview. Empty string means the
     * selector did not match anything — in that case every expected feature is reported
     * as "Actual selector not found".
     * @type {string}
     */
    let actualFeaturesText = '';
    if (needsFeaturesBlock) {
      // eslint-disable-next-line no-console
      console.log(`[Runner] Capturing features block for ${expectedFeatures.length} expected feature(s)…`);
      actualFeaturesText = await readActualFeaturesText(page);
    }

    /** @type {string} */
    let hotelAmenitiesHoursForMeta = '';
    let hotelAmenitiesTabReady = false;

    /**
     * Map of ordinal → actual h3 text on the page, for the three Property Highlight tiles.
     * Empty strings mean the selector did not match (treated as "Actual selector not found"
     * in the per-row loop). Pre-fetched in one pass to keep the row loop simple.
     * @type {Record<1|2|3, string>}
     */
    let propertyHighlightTitleMap = { 1: '', 2: '', 3: '' };
    if (needsHighlightTitlesBlock) {
      // eslint-disable-next-line no-console
      console.log('[Runner] Capturing the three Property Highlight h3 titles…');
      propertyHighlightTitleMap = await readAllPropertyHighlightTitles(page);
    }

    /** @type {Record<'golfLessons'|'dressCode'|'handicapMen'|'handicapWomen', string>} */
    let golfAmenityInfoMap = { golfLessons: '', dressCode: '', handicapMen: '', handicapWomen: '' };
    /** @type {string} */
    let golfAmenityOperationHours = '';
    let golfPropertyOperationHours = '';
    const golfAmenityFromGolfSubpage = needsGolfBlock;
    if (needsGolfAmenityInfoBlock || needsGolfAmenityOperationHoursBlock) {
      if (golfAmenityFromGolfSubpage) {
        // eslint-disable-next-line no-console
        console.log(
          '[Runner] Golf amenity tiles will be read from /services-amenities/golf (overview has no #hotel-amenities on Armancette)…',
        );
      } else {
        // eslint-disable-next-line no-console
        console.log('[Runner] Capturing golf amenity tiles + hours (#hotel-amenities on overview)…');
        const golfAmenityData = await readAllGolfAmenityData(page);
        golfAmenityInfoMap = golfAmenityData.items;
        golfAmenityOperationHours = golfAmenityData.operationHours;
        hotelAmenitiesTabReady = true;
        if (normalizeText(golfAmenityOperationHours)) {
          // eslint-disable-next-line no-console
          console.log(
            `[Runner] Golf amenity hours: found (${golfAmenityOperationHours.length} chars).`,
          );
        }
      }
    }
    if (needsHotelAmenitiesHoursBlock) {
      hotelAmenitiesHoursForMeta = await readHotelAmenitiesExtrasHours(page, {
        amenitiesTabReady: hotelAmenitiesTabReady,
      });
      if (normalizeText(hotelAmenitiesHoursForMeta)) {
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] Hotel amenities hours (#hotel-amenities .row.extras): found (${hotelAmenitiesHoursForMeta.length} chars).`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.log('[Runner] Hotel amenities hours (#hotel-amenities .row.extras): not found.');
      }
    }

    /** @type {string[]} */
    let propertyHighlightSegments = [];
    /** @type {string} */
    let hotelMessageBannerText = '';
    if (
      needsPropertyOverviewSpecialBlock ||
      needsPropertyHighlightBlock ||
      needsHotelMessageBannerBlock ||
      needsSpecialNoticeBlock
    ) {
      await page
        .locator('#main-content')
        .first()
        .waitFor({ state: 'attached', timeout: 35_000 })
        .catch(() => {});
      await page.locator('#main-content').first().scrollIntoViewIfNeeded().catch(() => {});
    }

    if (needsSpecialNoticeBlock) {
      try {
        specialNoticeMessages = await readAllSpecialNoticeMessages(page);
        if (specialNoticeMessages.length) {
          specialNoticeMessage = formatSpecialNoticesForPreview(specialNoticeMessages);
          // eslint-disable-next-line no-console
          console.log(
            `[Runner] Special notice found (${specialNoticeMessages.length} block(s))`,
          );
          // eslint-disable-next-line no-console
          console.log(`[Runner] specialNoticeMessages:\n${specialNoticeMessage}`);
        } else {
          specialNoticeMessages = [];
          specialNoticeMessage = null;
          // eslint-disable-next-line no-console
          console.log('[Runner] No special notice found');
        }
      } catch {
        specialNoticeMessages = [];
        specialNoticeMessage = null;
        // eslint-disable-next-line no-console
        console.log('[Runner] No special notice found');
      }
    } else {
      specialNoticeMessages = [];
      specialNoticeMessage = null;
      // eslint-disable-next-line no-console
      console.log('[Runner] Skipping special notice read; no Special Notice rows with English source content.');
    }

    if (needsPropertyHighlightBlock) {
      await page
        .locator('section.property-highlights, [class*="property-highlights"], #main-content')
        .first()
        .waitFor({ state: 'attached', timeout: 25_000 })
        .catch(() => {});
      await page
        .locator('section.property-highlights, .highlight-item, #main-content')
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await page.waitForTimeout(150);
      propertyHighlightSegments = await readPropertyHighlightSegments(page);
      propertyHighlightMeta.segmentCount = propertyHighlightSegments.length;
      propertyHighlightMeta.fetchedText = propertyHighlightSegments.length > 0;
      propertyHighlightMeta.preview = propertyHighlightSegments
        .map(
          (s, i) =>
            `Property Highlight #${i + 1} body (overview)\n${truncateForResultPreview(s, 6000)}`,
        )
        .join('\n\n---\n\n');
      if (!propertyHighlightMeta.fetchedText) {
        // eslint-disable-next-line no-console
        console.warn(
          '[Runner] Property highlight descriptions: no paragraphs captured (check section.property-highlights / .highlight-item on the overview).',
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] Property highlight descriptions: captured ${propertyHighlightSegments.length} paragraph(s) for #1–#${propertyHighlightSegments.length}.`,
        );
      }
    }

    if (needsHotelMessageBannerBlock) {
      // eslint-disable-next-line no-console
      console.log(`[Runner] Capturing hotel message banner (${HOTEL_MESSAGE_BANNER_SELECTOR})…`);
      hotelMessageBannerText = await readHotelMessageBannerBlock(page);
      messageBannerMeta.fetchedText = Boolean(normalizeText(hotelMessageBannerText));
      messageBannerMeta.characterCount = hotelMessageBannerText.length;
      messageBannerMeta.preview = truncateForResultPreview(
        normalizeText(hotelMessageBannerText) || hotelMessageBannerText,
        20_000,
      );
      if (messageBannerMeta.fetchedText) {
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] Hotel message banner: ${hotelMessageBannerText.length} character(s) (title + paragraphs + link text).`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[Runner] Hotel message banner: empty after ${HOTEL_MESSAGE_BANNER_SELECTOR} and fallbacks — page may have no notice block.`,
        );
      }
    }

    let propertyOverviewSpecialText = '';
    let hotelPropertyOverviewText = '';
    let hotelPropertyQuoteText = '';
    if (needsHotelPropertyOverviewBlock) {
      // eslint-disable-next-line no-console
      console.log('[Runner] Capturing property-overview body for Overview row(s)…');
      hotelPropertyOverviewText = await readHotelPropertyOverviewBody(page);
    }
    if (needsHotelPropertyQuoteBlock) {
      // eslint-disable-next-line no-console
      console.log('[Runner] Capturing property-overview subheader for Quot/Quote row(s)…');
      hotelPropertyQuoteText = await readHotelPropertyOverviewQuote(page);
    }
    if (needsPropertyOverviewSpecialBlock) {
      propertyOverviewSpecialMeta.active = true;
      // eslint-disable-next-line no-console
      console.log('[Runner] Capturing property-overview block for column H (special note) row(s)…');
      propertyOverviewSpecialText = await readPropertyOverviewSpecialBlock(page);
      propertyOverviewSpecialMeta.selectorEmpty = !normalizeText(propertyOverviewSpecialText);
      if (normalizeText(propertyOverviewSpecialText)) {
        propertyOverviewSpecialMeta.fetchedText = true;
        propertyOverviewSpecialMeta.characterCount = propertyOverviewSpecialText.length;
        propertyOverviewSpecialMeta.preview = truncateForResultPreview(propertyOverviewSpecialText, 20_000);
      }
    }

    const airportBlock = needsLocalInfoBlock ? await readLocalInformationAirportText(page) : '';
    let diningBlock = '';
    let diningOverviewText = '';
    let spaBlock = '';
    let spaTitleForMeta = '';
    let spaDescriptionForMeta = '';
    let spaHoursForMeta = '';

    const applyDiningRes = (diningRes) => {
      diningBlock = diningRes.block;
      diningOverviewText = diningRes.overviewText || diningBlock;
      operationHours = diningRes.operationHours;
      diningOutletBlocks = diningRes.outletBlocks;
      diningMeta.operationHours = operationHours;
      diningMeta.operationHoursPreview = formatOperationHoursForPreview(operationHours);
      diningMeta.outletBlocks = diningOutletBlocks;
      if (operationHours?.outlets?.length) {
        // eslint-disable-next-line no-console
        console.log('[Runner] Operation hours found');
        for (const outlet of operationHours.outlets) {
          // eslint-disable-next-line no-console
          console.log(`[Runner] operationHours — ${outlet.name}:\n${outlet.hours}`);
        }
      } else {
        // eslint-disable-next-line no-console
        console.log('[Runner] No operation hours found');
      }
    };

    const applySpaRes = (spaRes) => {
      spaBlock = spaRes.block;
      spaTitleForMeta = spaRes.title;
      spaDescriptionForMeta = spaRes.description;
      spaHoursForMeta = pickBestSpaHoursText(hotelAmenitiesHoursForMeta, spaRes.hours);
    };

    const subpagesStartedAt = Date.now();
    const { diningRes, spaRes, golfRes } = await subpagesPromise;
    // eslint-disable-next-line no-console
    console.log(`[Runner] Subpages loaded in ${Date.now() - subpagesStartedAt}ms`);
    if (diningRes) {
      applyDiningRes(diningRes);
    }
    if (spaRes) {
      applySpaRes(spaRes);
    }

    if (needsSpaBlock) {
      spaMeta.title = spaTitleForMeta;
      spaMeta.titleFound = Boolean(normalizeText(spaTitleForMeta));
      spaMeta.descriptionFound = Boolean(normalizeText(spaDescriptionForMeta));
      spaMeta.hoursFound = Boolean(normalizeText(spaHoursForMeta));
      spaMeta.descriptionLength = spaDescriptionForMeta.length;
      spaMeta.titlePreview = truncateForResultPreview(spaTitleForMeta, 500);
      spaMeta.descriptionPreview = truncateForResultPreview(spaDescriptionForMeta, 5000);
      spaMeta.hoursPreview = truncateForResultPreview(spaHoursForMeta, 5000);

      if (spaMeta.titleFound) {
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] SPA title (${SPA_TITLE_H3_SELECTOR}): ${JSON.stringify(truncateForResultPreview(spaTitleForMeta, 160))} (${spaTitleForMeta.length} chars)`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[Runner] SPA title missing: no match for ${SPA_TITLE_H3_SELECTOR} (and ${SPA_TITLE_SELECTOR} with nested .spa-details stripped).`,
        );
      }
      if (spaMeta.descriptionFound) {
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] SPA description (.spa-details / fallbacks): found (${spaDescriptionForMeta.length} chars).`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[Runner] SPA description missing or empty after structured `.spa-details` and fallback paragraph reads.',
        );
      }
      if (spaMeta.hoursFound) {
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] SPA hours (schedule <p> on /services-amenities/spa): found (${spaHoursForMeta.length} chars).`,
        );
      }
    }

    if (diningBlock) {
      diningMeta.fetchedText = true;
      diningMeta.characterCount = diningBlock.length;
      diningMeta.preview = truncateForResultPreview(normalizeText(diningBlock), 1200);
    }
    if (spaBlock) {
      spaMeta.fetchedText = true;
      spaMeta.characterCount = spaBlock.length;
      const norm = normalizeText(spaBlock);
      spaMeta.preview = [
        `SPA title (${SPA_TITLE_H3_SELECTOR} — LHW list heading, e.g. “CORI Spa”):`,
        spaMeta.titlePreview || spaMeta.title || '(empty)',
        '',
        'SPA description (.spa-details / fallbacks):',
        spaMeta.descriptionPreview || '(empty)',
        '',
        'SPA hours (#hotel-amenities .row.extras + spa page schedule):',
        spaMeta.hoursPreview || '(empty)',
        '',
        '--- Combined text used for Excel substring checks (title + description + optional generic fallback) ---',
        truncateForResultPreview(norm || String(spaBlock).trim(), 4000),
      ].join('\n');
    }

    let golfBlock = '';
    /** @type {{ outlets: { name: string, description: string, hours: string, text: string }[] } | null} */
    let golfCourseBlocks = null;
    if (needsGolfBlock && golfRes) {
      golfBlock = golfRes.block;
      golfCourseBlocks = golfRes.courses;
      golfPropertyOperationHours = String(golfRes.propertyOperationHours || '').trim();
      golfMeta.courses = golfCourseBlocks;
      if (normalizeText(golfPropertyOperationHours) && !normalizeText(golfAmenityOperationHours)) {
        golfAmenityOperationHours = golfPropertyOperationHours;
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] Golf property hours (golf subpage): ${golfPropertyOperationHours.length} chars.`,
        );
      }
      if (needsGolfAmenityInfoBlock || needsGolfAmenityOperationHoursBlock) {
        const merged = mergeGolfAmenityScrape(
          golfAmenityInfoMap,
          golfAmenityOperationHours,
          golfRes?.amenityData || null,
        );
        golfAmenityInfoMap = merged.infoMap;
        golfAmenityOperationHours = merged.hoursOut;
        if (
          isGolfAmenityDataEmpty({
            items: golfAmenityInfoMap,
            operationHours: golfAmenityOperationHours,
          })
        ) {
          try {
            const fromGolfPage = await readGolfAmenityDataOnGolfSubpage(page, firstNavUrl, lang);
            const mergedFallback = mergeGolfAmenityScrape(
              golfAmenityInfoMap,
              golfAmenityOperationHours,
              fromGolfPage,
            );
            golfAmenityInfoMap = mergedFallback.infoMap;
            golfAmenityOperationHours = mergedFallback.hoursOut;
          } catch {
            // ignore
          }
        }
        if (
          !normalizeText(golfAmenityOperationHours) &&
          normalizeText(golfPropertyOperationHours)
        ) {
          golfAmenityOperationHours = golfPropertyOperationHours;
        }
        if (!isGolfAmenityDataEmpty({ items: golfAmenityInfoMap, operationHours: golfAmenityOperationHours })) {
          // eslint-disable-next-line no-console
          console.log('[Runner] Golf amenity tiles loaded from golf subpage.');
        }
      }

      if (golfCourseBlocks?.outlets?.length) {
        // eslint-disable-next-line no-console
        console.log('[Runner] Golf courses found');
        for (const course of golfCourseBlocks.outlets) {
          // eslint-disable-next-line no-console
          console.log(
            `[Runner] golf — ${course.name}: desc=${course.description?.length || 0} chars, hours=${course.hours?.length || 0} chars`,
          );
        }
      } else if (normalizeText(golfBlock)) {
        // eslint-disable-next-line no-console
        console.log(`[Runner] Golf page text found (${golfBlock.length} chars, no structured courses).`);
      } else {
        // eslint-disable-next-line no-console
        console.log('[Runner] No golf course content found');
      }
      if (normalizeText(golfBlock)) {
        golfMeta.fetchedText = true;
        golfMeta.characterCount = golfBlock.length;
        golfMeta.preview = truncateForResultPreview(normalizeText(golfBlock), 4000);
      }
    }

    if (propertySearchPromise) {
      throwIfAborted(shouldAbort);
      const psRes = await propertySearchPromise;
      propertySearchDesc = psRes.text;
      propertySearchMeta.query = psRes.query || '';
      propertySearchMeta.url = psRes.resultUrl || null;
      if (propertySearchDesc) {
        propertySearchMeta.fetchedText = true;
        propertySearchMeta.characterCount = propertySearchDesc.length;
        propertySearchMeta.preview = truncateForResultPreview(normalizeText(propertySearchDesc), 1200);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[Runner] Comparing ${searchableRows.length} row(s) with English source — Passed if fields match, Failed if not, Skipped if the ${lang} cell is empty…`,
    );

    /** @type {Map<number, { localizedNames: string[], englishNames: string[], descriptions: string[] }>} */
    const diningRowContextByOrdinal = new Map();
    const diningContextForOrdinal = (ordinal) => {
      if (!diningRowContextByOrdinal.has(ordinal)) {
        diningRowContextByOrdinal.set(ordinal, {
          localizedNames: [],
          englishNames: [],
          descriptions: [],
        });
      }
      return diningRowContextByOrdinal.get(ordinal);
    };
    /** @type {string[]} */
    const diningOutletNameCatalog = [];
    const pushUniqueText = (arr, value) => {
      const text = plainTextFromMaybeHtml(value || '');
      if (!normalizeText(text)) {
        return;
      }
      if (!arr.some((existing) => normalizeText(existing) === normalizeText(text))) {
        arr.push(text);
      }
    };
    for (const diningRow of searchableRows) {
      const label = normalizeSectionLabel(diningRow.section);
      const isDiningLabel =
        isRestaurantSectionLabel(label) || isDiningOperationHoursSectionLabel(label);
      if (!isDiningLabel) {
        continue;
      }
      const labelHint = diningOutletNameHintsFromSectionLabel(label);
      if (labelHint) {
        pushUniqueText(diningOutletNameCatalog, labelHint);
      }
      const ordinal = diningHoursOrdinalFromLabel(label);
      if (ordinal && isRestaurantSectionLabel(label)) {
        const ctx = diningContextForOrdinal(ordinal);
        const localized = diningRow.byLang?.[lang] || '';
        const english = diningRow.byLang?.ENG || '';
        if (
          (/\bname\b/i.test(label) || /\btitle\b/i.test(label)) &&
          !/\bdescription\b/i.test(label)
        ) {
          pushUniqueText(ctx.localizedNames, localized);
          pushUniqueText(ctx.englishNames, english);
          pushUniqueText(diningOutletNameCatalog, localized);
          pushUniqueText(diningOutletNameCatalog, english);
        } else if (/\bdescription\b/i.test(label)) {
          pushUniqueText(ctx.descriptions, localized);
          pushUniqueText(ctx.descriptions, english);
        }
      }
    }
    /** @type {Map<number, { localizedNames: string[], englishNames: string[], descriptions: string[] }>} */
    const golfRowContextByOrdinal = new Map();
    const golfContextForOrdinal = (ordinal) => {
      if (!golfRowContextByOrdinal.has(ordinal)) {
        golfRowContextByOrdinal.set(ordinal, {
          localizedNames: [],
          englishNames: [],
          descriptions: [],
        });
      }
      return golfRowContextByOrdinal.get(ordinal);
    };
    for (const golfRow of searchableRows) {
      const label = normalizeSectionLabel(golfRow.section);
      if (!isGolfSectionLabel(label)) {
        continue;
      }
      const ordinal = golfOrdinalFromLabel(label);
      if (!ordinal) {
        continue;
      }
      const ctx = golfContextForOrdinal(ordinal);
      const localized = golfRow.byLang?.[lang] || '';
      const english = golfRow.byLang?.ENG || '';
      if (isGolfTitleSectionLabel(label)) {
        pushUniqueText(ctx.localizedNames, localized);
        pushUniqueText(ctx.englishNames, english);
      } else if (/\bdescription\b/i.test(label)) {
        pushUniqueText(ctx.descriptions, localized);
        pushUniqueText(ctx.descriptions, english);
      }
    }
    /** When Excel special-notice rows lack #N, assign blocks in sheet order. */
    let specialNoticeRowSeq = 0;
    /** @type {Set<number>} */
    const usedSpecialNoticeIndices = new Set();
    let currentDiningOutletName = '';
    let currentDiningOrdinal = 0;
    let currentGolfCourseName = '';
    let currentGolfOrdinal = 0;
    /** @type {Map<number, number>} */
    const diningOutletIndexByOrdinal = new Map();
    /** @type {Map<number, number>} */
    const golfCourseIndexByOrdinal = new Map();

    for (const row of searchableRows) {
      throwIfAborted(shouldAbort);
      const section = normalizeSectionLabel(row.section);
      const expected = plainTextFromMaybeHtml(row.byLang[lang] || '');

      // Feature rows are compared per-feature below — skip them in the generic blob comparison.
      if (isFeatureSectionLabel(section)) {
        continue;
      }

      // Property Highlight TITLE rows (#1 / #2 / #3, NOT "… Description") are compared against
      // a specific h3 with strict equality. Description rows fall through to the existing flow.
      if (isPropertyHighlightTitleLabel(section)) {
        try {
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

          const ordinal = propertyHighlightTitleOrdinalFromLabel(section);
          const actualTitle = ordinal ? propertyHighlightTitleMap[ordinal] : '';

          if (!normalizeText(actualTitle)) {
            results.push({
              section,
              language: lang,
              expectedText: expected,
              actualText: 'Actual selector not found',
              status: 'Failed',
              note: `The Property Highlight #${ordinal} h3 selector did not match anything on the page.`,
            });
            continue;
          }

          const { match } = compareHighlightTitle(expected, actualTitle);
          results.push({
            section,
            language: lang,
            expectedText: expected,
            actualText: actualTitle,
            status: match ? 'Passed' : 'Failed',
            note: match ? 'Fields match.' : 'Expected and actual do not match.',
          });
        } catch (titleErr) {
          // Per-row try/catch — bad title row never aborts the others.
          const message = titleErr instanceof Error ? titleErr.message : String(titleErr);
          // eslint-disable-next-line no-console
          console.log(`[Runner] Highlight title "${section}" threw — continuing. (${message})`);
          results.push({
            section,
            language: lang,
            expectedText: expected,
            actualText: '',
            status: 'Failed',
            note: `Highlight title error (run continued for remaining rows): ${message}`,
          });
        }
        continue;
      }

      if (isGolfAmenityInfoItemLabel(section)) {
        try {
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

          const infoKey = golfAmenityInfoItemKeyFromLabel(section);
          const actualInfo = infoKey ? golfAmenityInfoMap[infoKey] : '';

          if (!normalizeText(actualInfo)) {
            results.push({
              section,
              language: lang,
              expectedText: expected,
              actualText: 'Actual selector not found',
              status: 'Failed',
              note: `The ${section} selector under #hotel-amenities did not match anything on the page.`,
            });
            continue;
          }

          const { match } = compareGolfAmenityInfoItemForKey(infoKey, expected, actualInfo);
          const passNote =
            infoKey === 'handicapMen' || infoKey === 'handicapWomen'
              ? 'Fields match (expected text found in actual).'
              : 'Fields match.';
          const failNote =
            infoKey === 'handicapMen' || infoKey === 'handicapWomen'
              ? 'Expected text not found within the actual handicap line.'
              : 'Expected and actual do not match.';
          results.push({
            section,
            language: lang,
            expectedText: expected,
            actualText: actualInfo,
            status: match ? 'Passed' : 'Failed',
            note: match ? passNote : failNote,
          });
        } catch (infoErr) {
          const message = infoErr instanceof Error ? infoErr.message : String(infoErr);
          // eslint-disable-next-line no-console
          console.log(`[Runner] Golf amenity info "${section}" threw — continuing. (${message})`);
          results.push({
            section,
            language: lang,
            expectedText: expected,
            actualText: '',
            status: 'Failed',
            note: `Golf amenity info error (run continued for remaining rows): ${message}`,
          });
        }
        continue;
      }

      const sectionLooksLikeRestaurantName =
        isRestaurantSectionLabel(section) &&
        !isDiningOperationHoursSectionLabel(section) &&
        (/\bname\b/i.test(section) || /\btitle\b/i.test(section)) &&
        !/\bdescription\b/i.test(section);
      const sectionLooksLikeRestaurantDescription =
        isRestaurantSectionLabel(section) &&
        !isDiningOperationHoursSectionLabel(section) &&
        /\bdescription\b/i.test(section);

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

      // Per-row try/catch: a single bad row is reported as Failed but the run continues.
      try {

      const hasSpecialNote = rowHasSpecialNote(row);
      const isHotelOverviewRow =
        isHotelPropertyOverviewSectionLabel(section) && !hasSpecialNote;
      const isHotelQuoteRow = isHotelPropertyQuoteSectionLabel(section);
      const isDiningOverviewRow = isDiningOverviewSectionLabel(section);
      const isRestRow = isRestaurantSectionLabel(section);
      const isSpaRow = isSpaSectionLabel(section);
      const isGolfRow = isGolfSectionLabel(section);
      const sectionLooksLikeGolfName = isGolfTitleSectionLabel(section);
      const sectionLooksLikeGolfDescription = isGolfDescriptionSectionLabel(section);
      const isPHRow = isPropertyHighlightSectionLabel(section);
      const isPSRow = isPropertySearchSectionLabel(section);
      const isMsgRow = isHotelMessageBannerSectionLabel(section);
      const specialNoticeContentIndex = specialNoticeBlockIndexForExpected(
        specialNoticeMessages,
        expected,
      );
      const isSpecialNoticeRow =
        isSpecialNoticeSectionLabel(section) || specialNoticeContentIndex >= 0;
      const specialNoticeLabelNumber = specialNoticeOrdinalFromLabel(section);
      let specialNoticeOrdinal = specialNoticeLabelNumber;
      if (isSpecialNoticeRow && !specialNoticeOrdinal && specialNoticeMessages.length) {
        specialNoticeRowSeq += 1;
        specialNoticeOrdinal = specialNoticeRowSeq;
      }
      let specialNoticeTextForRow = '';
      let specialNoticeIndexForRow = -1;
      if (isSpecialNoticeRow && specialNoticeMessages.length) {
        const resolved = resolveSpecialNoticeBlock(specialNoticeMessages, {
          ordinal: specialNoticeOrdinal,
          expected,
          usedIndices: usedSpecialNoticeIndices,
          contentIndex: specialNoticeContentIndex,
          labelHasNumber: specialNoticeLabelNumber > 0,
        });
        specialNoticeTextForRow = resolved.text;
        specialNoticeIndexForRow = resolved.index;
        if (specialNoticeIndexForRow >= 0) {
          usedSpecialNoticeIndices.add(specialNoticeIndexForRow);
        }
        // eslint-disable-next-line no-console
        console.log(
          `[Runner] Special notice row "${section}" → block ${specialNoticeIndexForRow + 1}/${specialNoticeMessages.length}`,
        );
      }
      const golfHoursDisambigCtx = {
        golfAmenityHours: golfAmenityOperationHours,
        golfPropertyHours: golfPropertyOperationHours,
        golfCourses: golfCourseBlocks,
        spaHours: spaHoursForMeta,
        hotelAmenitiesHours: hotelAmenitiesHoursForMeta,
      };
      const isGolfHoursRow =
        isGolfHoursRowLabel(section, expected, golfCourseBlocks) ||
        (isGenericOperationHoursSectionLabel(section) &&
          shouldUseGolfOperationHours(expected, golfHoursDisambigCtx));
      const isSpaHoursRow =
        !isGolfHoursRow &&
        isSpaHoursRowLabel(
          section,
          hotelAmenitiesHoursForMeta,
          expected,
          spaHoursForMeta,
          operationHours,
        );
      const isHoursRow =
        isDiningOperationHoursSectionLabel(section) && !isSpaHoursRow && !isGolfHoursRow;
      const isDiningOutletTitleRow =
        sectionLooksLikeRestaurantName ||
        sectionLooksLikeRestaurantDescription ||
        isHoursRow;
      const diningOrdinal = diningHoursOrdinalFromLabel(section);
      const effectiveDiningOrdinal =
        diningOrdinal ||
        (isDiningOutletTitleRow ? currentDiningOrdinal : 0);
      const diningRowContext = effectiveDiningOrdinal
        ? diningRowContextByOrdinal.get(effectiveDiningOrdinal) || {
            localizedNames: [],
            englishNames: [],
            descriptions: [],
          }
        : { localizedNames: [], englishNames: [], descriptions: [] };
      const diningLabelHint = diningOutletNameHintsFromSectionLabel(section);
      const diningTitleCandidates = buildDiningTitleCandidates({
        lang,
        isNameRow: sectionLooksLikeRestaurantName,
        expected,
        context: diningRowContext,
        currentDiningOutletName,
        labelHint: diningLabelHint,
      });
      const diningNameCandidates = uniqueNormalizedNames([
        ...diningTitleCandidates.localizedNames,
        ...diningTitleCandidates.englishNames,
      ]);
      let diningOutletForRow = diningOutletBoundToOrdinal(
        diningOutletBlocks,
        diningOutletIndexByOrdinal,
        effectiveDiningOrdinal,
      );
      const diningPickDescriptions = uniqueNormalizedNames([
        ...diningRowContext.descriptions,
        ...(sectionLooksLikeRestaurantDescription ? [expected] : []),
      ]);
      if (!diningOutletForRow) {
        diningOutletForRow = pickDiningOutletBySignals(diningOutletBlocks, {
          ordinal: effectiveDiningOrdinal,
          sectionLabel: section,
          localizedNames: diningTitleCandidates.localizedNames,
          englishNames: diningTitleCandidates.englishNames,
          descriptions: diningPickDescriptions,
          expectedHours: isHoursRow ? expected : '',
          expectedText:
            sectionLooksLikeRestaurantName || sectionLooksLikeRestaurantDescription ? expected : '',
          allowOrdinalFallback: false,
          matchByTitle: sectionLooksLikeRestaurantName && !isHoursRow,
          matchOutletNameOnly: sectionLooksLikeRestaurantName && !isHoursRow,
        });
      }
      if (!diningOutletForRow && isHoursRow && normalizeText(expected)) {
        diningOutletForRow = pickDiningOutletBySignals(diningOutletBlocks, {
          expectedHours: expected,
          allowOrdinalFallback: false,
          matchByTitle: false,
        });
      }
      if (
        (sectionLooksLikeRestaurantName || sectionLooksLikeRestaurantDescription) &&
        diningOutletForRow
      ) {
        const bindOrdinal = diningHoursOrdinalFromLabel(section) || effectiveDiningOrdinal;
        if (bindOrdinal > 0) {
          bindDiningOutletOrdinal(
            diningOutletBlocks,
            diningOutletIndexByOrdinal,
            bindOrdinal,
            diningOutletForRow,
          );
        }
      }
      const diningNameTextForRow = sectionLooksLikeRestaurantName
        ? pickDiningOutletDisplayName(diningOutletForRow, expected)
        : '';
      if (sectionLooksLikeRestaurantName) {
        const resolvedName = diningNameTextForRow || String(diningOutletForRow?.name || '').trim();
        if (normalizeText(resolvedName)) {
          currentDiningOutletName = resolvedName;
        }
        const nameOrdinal = diningHoursOrdinalFromLabel(section);
        if (nameOrdinal > 0) {
          currentDiningOrdinal = nameOrdinal;
        }
      } else if (isDiningOutletTitleRow && diningOutletForRow?.name) {
        const resolvedTitle = String(diningOutletForRow.name || '').trim();
        if (normalizeText(resolvedTitle)) {
          currentDiningOutletName = resolvedTitle;
        }
        if (effectiveDiningOrdinal > 0) {
          currentDiningOrdinal = effectiveDiningOrdinal;
        }
      }
      const diningDescriptionTextForRow = sectionLooksLikeRestaurantDescription
        ? deriveDiningOutletDescription(diningOutletForRow, expected)
        : '';
      let hoursText = '';
      if (isHoursRow) {
        hoursText = normalizeOperationHours(diningOutletForRow?.hours || '');
        if (!normalizeText(hoursText) && diningOutletForRow?.name) {
          hoursText = pickOperationHoursText(
            operationHours,
            effectiveDiningOrdinal,
            section,
            diningOutletForRow.name,
            expected,
          );
        }
        if (!normalizeText(hoursText)) {
          hoursText = pickOperationHoursText(
            operationHours,
            effectiveDiningOrdinal,
            section,
            diningNameCandidates.join(' '),
            expected,
          );
        }
      }
      const golfOrdinal = golfOrdinalFromLabel(section);
      const isGolfCourseTitleRow =
        sectionLooksLikeGolfName || sectionLooksLikeGolfDescription || isGolfHoursRow;
      const effectiveGolfOrdinal =
        golfOrdinal || (isGolfCourseTitleRow ? currentGolfOrdinal : 0);
      const golfRowContext = effectiveGolfOrdinal
        ? golfRowContextByOrdinal.get(effectiveGolfOrdinal) || {
            localizedNames: [],
            englishNames: [],
            descriptions: [],
          }
        : { localizedNames: [], englishNames: [], descriptions: [] };
      const golfLabelHint = golfCourseNameHintsFromSectionLabel(section);
      const golfTitleCandidates = buildDiningTitleCandidates({
        lang,
        isNameRow: sectionLooksLikeGolfName,
        expected,
        context: golfRowContext,
        currentDiningOutletName: currentGolfCourseName,
        labelHint: golfLabelHint,
      });
      const sheetGolfCount = golfRowContextByOrdinal.size;
      const scrapedGolfCount = golfCourseBlocks?.outlets?.length || 0;
      const allowGolfOrdinalFallback =
        effectiveGolfOrdinal > 0 &&
        isGolfCourseTitleRow &&
        sheetGolfCount > 0 &&
        scrapedGolfCount === sheetGolfCount;
      let golfCourseForRow = diningOutletBoundToOrdinal(
        golfCourseBlocks,
        golfCourseIndexByOrdinal,
        effectiveGolfOrdinal,
      );
      const golfPickDescriptions = uniqueNormalizedNames([
        ...golfRowContext.descriptions,
        ...(sectionLooksLikeGolfDescription ? [expected] : []),
      ]);
      if (!golfCourseForRow) {
        golfCourseForRow = pickDiningOutletBySignals(golfCourseBlocks, {
          ordinal: effectiveGolfOrdinal,
          sectionLabel: section,
          localizedNames: golfTitleCandidates.localizedNames,
          englishNames: golfTitleCandidates.englishNames,
          descriptions: golfPickDescriptions,
          expectedHours: isGolfHoursRow ? expected : '',
          expectedText:
            sectionLooksLikeGolfName || sectionLooksLikeGolfDescription ? expected : '',
          allowOrdinalFallback: allowGolfOrdinalFallback,
          sheetRestaurantCount: sheetGolfCount,
          matchByTitle: sectionLooksLikeGolfName && !isGolfHoursRow,
          matchOutletNameOnly: sectionLooksLikeGolfName && !isGolfHoursRow,
        });
      }
      if (!golfCourseForRow && isGolfHoursRow && normalizeText(expected)) {
        golfCourseForRow = pickDiningOutletBySignals(golfCourseBlocks, {
          expectedHours: expected,
          allowOrdinalFallback: false,
          matchByTitle: false,
        });
      }
      if (
        (sectionLooksLikeGolfName || sectionLooksLikeGolfDescription) &&
        golfCourseForRow
      ) {
        const bindOrdinal = golfOrdinalFromLabel(section) || effectiveGolfOrdinal;
        if (bindOrdinal > 0) {
          if (sectionLooksLikeGolfDescription) {
            bindDiningOutletOrdinal(
              golfCourseBlocks,
              golfCourseIndexByOrdinal,
              bindOrdinal,
              golfCourseForRow,
            );
          } else {
            const matchedByTitle = [
              ...golfTitleCandidates.localizedNames,
              ...golfTitleCandidates.englishNames,
            ].some(
              (candidate) =>
                textsMatchOutletTitle(golfCourseForRow.name, candidate) ||
                outletNamesLikelyMatch(golfCourseForRow.name, candidate),
            );
            if (matchedByTitle) {
              bindDiningOutletOrdinal(
                golfCourseBlocks,
                golfCourseIndexByOrdinal,
                bindOrdinal,
                golfCourseForRow,
              );
            }
          }
        }
      }
      const golfNameTextForRow = sectionLooksLikeGolfName
        ? pickDiningOutletDisplayName(golfCourseForRow, expected)
        : '';
      if (sectionLooksLikeGolfName) {
        const resolvedName = golfNameTextForRow || String(golfCourseForRow?.name || '').trim();
        if (normalizeText(resolvedName)) {
          currentGolfCourseName = resolvedName;
        }
        const nameOrdinal = golfOrdinalFromLabel(section);
        if (nameOrdinal > 0) {
          currentGolfOrdinal = nameOrdinal;
        }
      } else if (isGolfCourseTitleRow && golfCourseForRow?.name) {
        const resolvedTitle = String(golfCourseForRow.name || '').trim();
        if (normalizeText(resolvedTitle)) {
          currentGolfCourseName = resolvedTitle;
        }
        if (effectiveGolfOrdinal > 0) {
          currentGolfOrdinal = effectiveGolfOrdinal;
        }
      }
      const golfDescriptionTextForRow = sectionLooksLikeGolfDescription
        ? deriveGolfCourseDescription(golfCourseForRow, expected)
        : '';
      const golfHoursFromCourse = normalizeOperationHours(golfCourseForRow?.hours || '');
      const golfHoursPicked = normalizeOperationHours(
        pickGolfOperationHoursText(
          golfAmenityOperationHours,
          golfPropertyOperationHours,
          golfCourseBlocks,
          expected,
        ),
      );
      const golfHoursTextForRow = isGolfHoursRow
        ? golfOrdinalFromLabel(section) > 0 && normalizeText(golfHoursFromCourse)
          ? golfHoursFromCourse
          : golfHoursPicked || golfHoursFromCourse
        : '';
      const golfTextForRow = pickGolfTextForRow(section, golfBlock, golfCourseForRow);
      const isLocRow = isLocalInformationSectionLabel(section);
      // If a label accidentally matches both, restaurant/dining wins so “Restaurant #1 Description”
      // still reads from the dining subpage, not the airport line.
      const useAirport =
        isLocRow &&
        !isRestRow &&
        !isSpaRow &&
        !isGolfRow &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        Boolean(airportBlock);
      const spaTextForRow = pickSpaTextForRow(
        section,
        spaBlock,
        spaTitleForMeta,
        spaDescriptionForMeta,
        spaHoursForMeta,
      );
      const spaHoursTextForRow = isSpaHoursRow
        ? pickBestSpaHoursText(spaHoursForMeta, hotelAmenitiesHoursForMeta) ||
          normalizeSpaHoursText(spaHoursForMeta)
        : '';
      const diningTextForRow = stripDiningQuotesUnlessInExpected(
        diningOutletForRow?.text ||
          pickDiningOutletText(diningOutletBlocks, effectiveDiningOrdinal, section, currentDiningOutletName, {
            localizedNames: diningTitleCandidates.localizedNames,
            englishNames: diningTitleCandidates.englishNames,
            expectedText: expected,
            allowOrdinalFallback: false,
            matchByTitle: sectionLooksLikeRestaurantName,
          }),
        expected,
      );
      const useDiningName =
        Boolean(normalizeText(diningNameTextForRow)) &&
        sectionLooksLikeRestaurantName &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow;
      const useDiningDescription =
        sectionLooksLikeRestaurantDescription &&
        Boolean(diningOutletForRow) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !isSpaHoursRow;
      const useGolfName =
        isGolfTitleSectionLabel(section) &&
        Boolean(normalizeText(golfNameTextForRow || golfCourseForRow?.name)) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !isGolfHoursRow;
      const useGolfDescription =
        sectionLooksLikeGolfDescription &&
        Boolean(golfCourseForRow) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !isSpaHoursRow &&
        !isGolfHoursRow;
      const useHotelPropertyOverview =
        isHotelOverviewRow &&
        Boolean(normalizeText(hotelPropertyOverviewText)) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !useDiningName &&
        !useDiningDescription &&
        !isHotelQuoteRow;
      const useHotelPropertyQuote =
        isHotelQuoteRow &&
        Boolean(normalizeText(hotelPropertyQuoteText)) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !useDiningName &&
        !useDiningDescription &&
        !useHotelPropertyOverview;
      const useDiningOverview =
        isDiningOverviewRow &&
        Boolean(normalizeText(diningOverviewText || diningBlock)) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !useDiningName &&
        !useDiningDescription &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote;
      const useDining =
        Boolean(diningTextForRow || diningBlock) &&
        !sectionLooksLikeRestaurantDescription &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !useDiningName &&
        !useDiningDescription &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        (isRestRow ||
          (diningPathPasted && !isSpaRow && !isGolfRow && !isHotelOverviewRow && !isHotelQuoteRow));
      const useSpaHours =
        Boolean(normalizeText(spaHoursTextForRow)) &&
        isSpaHoursRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !isGolfRow &&
        !isGolfHoursRow &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow;
      const useSpa =
        Boolean(normalizeText(spaTextForRow)) &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !isSpaHoursRow &&
        !isGolfHoursRow &&
        (isSpaRow || (spaPathPasted && !isRestRow && !isGolfRow));
      const useGolfHours =
        Boolean(normalizeText(golfHoursTextForRow)) &&
        isGolfHoursRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useSpa &&
        !useSpaHours &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow;
      const useGolf =
        Boolean(normalizeText(golfTextForRow)) &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useSpa &&
        !useSpaHours &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        !isSpaHoursRow &&
        !isGolfHoursRow &&
        !useGolfName &&
        !useGolfDescription &&
        (isGolfRow || (golfPathPasted && !isRestRow && !isSpaRow));

      const phOrdinal = propertyHighlightOrdinalFromLabel(section);
      const phSlice =
        isPHRow && propertyHighlightSegments.length
          ? String(propertyHighlightSegments[phOrdinal - 1] ?? '').trim()
          : '';
      const usePH =
        !hasSpecialNote &&
        Boolean(propertyHighlightSegments.length) &&
        isPHRow &&
        Boolean(normalizeText(phSlice)) &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useSpa &&
        !useSpaHours &&
        !useGolf &&
        !useGolfHours &&
        !isPSRow;

      // Column H pins to property-overview for normal rows — never for Property Highlight copy,
      // or Excel “Description” rows would compare against the wrong block when H is filled.
      // Message-banner rows always use `div.message`, not the property-overview pin.
      const useSpecialOverview =
        hasSpecialNote &&
        !isPHRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useDiningName &&
        !useDiningDescription &&
        !useSpa &&
        !usePS &&
        Boolean(normalizeText(propertyOverviewSpecialText));

      const useMessageBanner =
        Boolean(normalizeText(hotelMessageBannerText)) &&
        isMsgRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useSpa &&
        !isPHRow &&
        !isPSRow &&
        !isSpecialNoticeRow;

      const useSpecialNotice =
        Boolean(normalizeText(specialNoticeTextForRow)) &&
        isSpecialNoticeRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useSpa &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow;

      const useOperationHours =
        Boolean(normalizeText(hoursText)) &&
        isHoursRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useSpa &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow;

      const usePS =
        Boolean(propertySearchDesc) &&
        isPSRow &&
        !useAirport &&
        !useDining &&
        !useDiningOverview &&
        !useHotelPropertyOverview &&
        !useHotelPropertyQuote &&
        !useSpa &&
        !usePH &&
        !useMessageBanner &&
        !useSpecialNotice &&
        !useOperationHours &&
        !useSpaHours;

      const diningOverviewActual = stripDiningQuotesUnlessInExpected(
        diningOverviewText || diningBlock,
        expected,
      );

      let textForCompare = mainPageText;
      if (useAirport) {
        textForCompare = `${mainPageText}\n\n${airportBlock}`;
      } else if (useHotelPropertyOverview) {
        textForCompare = hotelPropertyOverviewText;
      } else if (useHotelPropertyQuote) {
        textForCompare = hotelPropertyQuoteText;
      } else if (useDiningName) {
        textForCompare = diningNameTextForRow;
      } else if (useDiningDescription) {
        textForCompare = diningDescriptionTextForRow;
      } else if (useOperationHours) {
        textForCompare = hoursText;
      } else if (useSpaHours) {
        textForCompare = spaHoursTextForRow;
      } else if (useGolfName) {
        textForCompare = golfNameTextForRow;
      } else if (useGolfDescription) {
        textForCompare = golfDescriptionTextForRow;
      } else if (useGolfHours) {
        textForCompare = golfHoursTextForRow;
      } else if (useDiningOverview) {
        textForCompare = diningOverviewActual;
      } else if (useDining) {
        textForCompare =
          diningTextForRow || stripDiningQuotesUnlessInExpected(diningBlock, expected);
      } else if (useSpa) {
        textForCompare = spaTextForRow;
      } else if (useGolf) {
        textForCompare = golfTextForRow;
      } else if (useSpecialOverview) {
        textForCompare = propertyOverviewSpecialText;
      } else if (useMessageBanner) {
        textForCompare = hotelMessageBannerText;
      } else if (useSpecialNotice) {
        textForCompare = specialNoticeTextForRow;
      } else if (usePH) {
        textForCompare = phSlice;
      } else if (usePS) {
        textForCompare = propertySearchDesc;
      }
      const expNorm = normalizeText(expected);
      const snippet = extractMatchingSnippet(textForCompare, expected);
      const useStrictCopyMatch =
        useHotelPropertyOverview ||
        useHotelPropertyQuote ||
        (useDiningDescription && String(lang).toUpperCase() === 'ENG') ||
        (useGolfDescription && String(lang).toUpperCase() === 'ENG');
      const useHoursMatch = useOperationHours || useSpaHours || useGolfHours;
      const englishExpectedForRow = plainTextFromMaybeHtml(row.byLang?.ENG || '');
      const golfTitleCompareText =
        golfNameTextForRow || String(golfCourseForRow?.name || '').trim();
      const found = useHoursMatch
        ? textsMatchOperationHours(textForCompare, expected)
        : useDiningName
          ? textsMatchOutletTitle(textForCompare, expected, englishExpectedForRow)
          : isGolfTitleSectionLabel(section) && normalizeText(golfTitleCompareText)
            ? textsMatchOutletTitle(golfTitleCompareText, expected, englishExpectedForRow)
            : useSpa && isSpaTitleSectionLabel(section)
              ? textsMatchSpaTitle(textForCompare, expected, englishExpectedForRow)
              : useSpa && isSpaDescriptionSectionLabel(section)
                ? textsMatchExpectedStrict(textForCompare, expected)
                : useGolf && isGolfDescriptionSectionLabel(section)
                  ? textsMatchExpectedStrict(textForCompare, expected)
                  : useStrictCopyMatch
                    ? textsMatchExpectedStrict(textForCompare, expected)
                    : textsMatchExpected(textForCompare, expected);

      if (found) {
        let actualPass;
        if (useSpecialOverview) {
          // Show the full captured overview block (not the tiny normalized substring from extractMatchingSnippet).
          actualPass = truncateForResultPreview(propertyOverviewSpecialText, 12_000);
        } else if (useHotelPropertyOverview) {
          actualPass = truncateForResultPreview(hotelPropertyOverviewText, 12_000);
        } else if (useHotelPropertyQuote) {
          actualPass = truncateForResultPreview(hotelPropertyQuoteText, 12_000);
        } else if (useMessageBanner) {
          actualPass = truncateForResultPreview(hotelMessageBannerText, 12_000);
        } else if (useSpecialNotice) {
          actualPass = truncateForResultPreview(specialNoticeTextForRow, 12_000);
        } else if (useDiningName) {
          actualPass = truncateForResultPreview(diningNameTextForRow, 500);
        } else if (useDiningDescription) {
          actualPass = truncateForResultPreview(diningDescriptionTextForRow, 12_000);
        } else if (useOperationHours) {
          actualPass = truncateForResultPreview(hoursText, 12_000);
        } else if (useSpaHours) {
          actualPass = truncateForResultPreview(spaHoursTextForRow, 12_000);
        } else if (useGolfName) {
          actualPass = truncateForResultPreview(golfNameTextForRow, 500);
        } else if (useGolfDescription) {
          actualPass = truncateForResultPreview(golfDescriptionTextForRow, 12_000);
        } else if (useGolfHours) {
          actualPass = truncateForResultPreview(golfHoursTextForRow, 12_000);
        } else if (useSpa && isSpaTitleSectionLabel(section)) {
          actualPass = truncateForResultPreview(
            spaTitleForMeta || spaTextForRow || snippet || expNorm,
            500,
          );
        } else if (useSpa) {
          actualPass = truncateForResultPreview(spaTextForRow, 12_000);
        } else if (useGolf && isGolfTitleSectionLabel(section)) {
          actualPass = truncateForResultPreview(golfNameTextForRow || golfTextForRow || snippet || expNorm, 500);
        } else if (useGolf) {
          actualPass = truncateForResultPreview(golfTextForRow, 12_000);
        } else if (useDiningOverview) {
          actualPass = truncateForResultPreview(diningOverviewActual, 12_000);
        } else if (useDining) {
          actualPass = truncateForResultPreview(
            diningTextForRow || stripDiningQuotesUnlessInExpected(diningBlock, expected),
            12_000,
          );
        } else if ((usePH || usePS) && (snippet || expNorm)) {
          actualPass = truncateForResultPreview(snippet || expNorm, 12_000);
        } else {
          actualPass = snippet || expNorm;
        }
        const passNote = 'Fields match.';
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
        const diningNameHintRaw = useDiningName && diningNameTextForRow
          ? normalizeText(diningNameTextForRow)
          : '';
        const diningNameHint = diningNameHintRaw ? truncateForResultPreview(diningNameHintRaw, 500) : '';
        const diningDescriptionHintRaw = useDiningDescription
          ? normalizeText(diningDescriptionTextForRow)
          : '';
        const diningDescriptionHint = useDiningDescription
          ? truncateForResultPreview(
              diningDescriptionHintRaw || '(no restaurant description scraped for this outlet)',
              12_000,
            )
          : '';
        const diningOverviewHintRaw =
          useDiningOverview && diningOverviewActual ? normalizeText(diningOverviewActual) : '';
        const diningOverviewHint = diningOverviewHintRaw
          ? truncateForResultPreview(diningOverviewHintRaw, 12_000)
          : '';
        const hotelOverviewHintRaw =
          useHotelPropertyOverview && hotelPropertyOverviewText
            ? normalizeText(hotelPropertyOverviewText)
            : '';
        const hotelOverviewHint = hotelOverviewHintRaw
          ? truncateForResultPreview(hotelOverviewHintRaw, 12_000)
          : '';
        const hotelQuoteHintRaw =
          useHotelPropertyQuote && hotelPropertyQuoteText
            ? normalizeText(hotelPropertyQuoteText)
            : '';
        const hotelQuoteHint = hotelQuoteHintRaw
          ? truncateForResultPreview(hotelQuoteHintRaw, 12_000)
          : '';
        const diningHintRaw =
          useDining && (diningTextForRow || diningBlock)
            ? normalizeText(
                cleanDiningOutletDescription(diningTextForRow || diningBlock) ||
                  diningTextForRow ||
                  diningBlock,
              )
            : '';
        const diningHint = diningHintRaw ? truncateForResultPreview(diningHintRaw) : '';
        const operationHoursHintRaw =
          isHoursRow && normalizeText(hoursText) ? normalizeText(hoursText) : '';
        const operationHoursHint = operationHoursHintRaw
          ? truncateForResultPreview(operationHoursHintRaw, 12_000)
          : '';
        const spaHoursHintRaw =
          isSpaHoursRow && normalizeText(spaHoursTextForRow)
            ? normalizeText(spaHoursTextForRow)
            : isSpaHoursRow && normalizeText(spaHoursForMeta)
              ? normalizeText(spaHoursForMeta)
              : '';
        const spaHoursHint = spaHoursHintRaw
          ? truncateForResultPreview(spaHoursHintRaw, 12_000)
          : '';
        const spaHintSource =
          isSpaTitleSectionLabel(section) && normalizeText(spaTitleForMeta)
            ? spaTitleForMeta
            : isSpaDescriptionSectionLabel(section) && normalizeText(spaDescriptionForMeta)
              ? spaDescriptionForMeta
              : spaTextForRow;
        const spaHintRaw = isSpaRow && normalizeText(spaHintSource) ? normalizeText(spaHintSource) : '';
        const spaHint = spaHintRaw
          ? truncateForResultPreview(
              spaHintRaw,
              isSpaTitleSectionLabel(section) ? 500 : 12_000,
            )
          : '';
        const golfNameHintRaw = useGolfName && golfNameTextForRow
          ? normalizeText(golfNameTextForRow)
          : '';
        const golfNameHint = golfNameHintRaw ? truncateForResultPreview(golfNameHintRaw, 500) : '';
        const golfDescriptionHintRaw = useGolfDescription
          ? normalizeText(golfDescriptionTextForRow)
          : '';
        const golfDescriptionHint = useGolfDescription
          ? truncateForResultPreview(
              golfDescriptionHintRaw || '(no golf course description scraped for this course)',
              12_000,
            )
          : '';
        const golfHoursHintRaw =
          isGolfHoursRow && normalizeText(golfHoursTextForRow)
            ? normalizeText(golfHoursTextForRow)
            : '';
        const golfHoursHint = golfHoursHintRaw
          ? truncateForResultPreview(golfHoursHintRaw, 12_000)
          : '';
        const golfHintSource =
          isGolfTitleSectionLabel(section) && normalizeText(golfNameTextForRow)
            ? golfNameTextForRow
            : isGolfDescriptionSectionLabel(section) && normalizeText(golfDescriptionTextForRow)
              ? golfDescriptionTextForRow
              : golfTextForRow;
        const golfHintRaw = isGolfRow && normalizeText(golfHintSource) ? normalizeText(golfHintSource) : '';
        const golfHint = golfHintRaw
          ? truncateForResultPreview(
              golfHintRaw,
              isGolfTitleSectionLabel(section) ? 500 : 12_000,
            )
          : '';
        const specialNoticeHintRaw =
          isSpecialNoticeRow && normalizeText(specialNoticeTextForRow)
            ? normalizeText(specialNoticeTextForRow)
            : isSpecialNoticeRow && specialNoticeMessages.length
              ? normalizeText(
                  specialNoticeMessages[specialNoticeIndexForRow] ||
                    specialNoticeMessages[0] ||
                    '',
                )
              : '';
        const specialNoticeHint = specialNoticeHintRaw
          ? truncateForResultPreview(specialNoticeHintRaw, 12_000)
          : '';
        const specialHintRaw =
          hasSpecialNote &&
          !isPHRow &&
          !isMsgRow &&
          !isSpecialNoticeRow &&
          !useAirport &&
          !useDining &&
          !useSpa &&
          !useGolf &&
          !usePS
            ? normalizeText(propertyOverviewSpecialText)
            : '';
        const specialHint = specialHintRaw
          ? truncateForResultPreview(specialHintRaw, 12_000)
          : '';
        const messageHintRaw =
          isMsgRow && normalizeText(hotelMessageBannerText)
            ? normalizeText(hotelMessageBannerText)
            : '';
        const messageHint = messageHintRaw ? truncateForResultPreview(messageHintRaw, 12_000) : '';
        const phHintRaw =
          isPHRow &&
          !isPSRow &&
          propertyHighlightSegments.length
            ? normalizeText(phSlice || propertyHighlightSegments.join('\n\n'))
            : '';
        const phHint = phHintRaw ? truncateForResultPreview(phHintRaw) : '';
        const isLocal = isLocalInformationSectionLabel(section);
        const wantsDining =
          isDiningOverviewRow ||
          (isRestRow && !isHotelOverviewRow) ||
          (diningPathPasted &&
            !isSpaRow &&
            !isGolfRow &&
            !useAirport &&
            !isPHRow &&
            !isPSRow &&
            !isHotelOverviewRow);
        const wantsSpa =
          isSpaRow || (spaPathPasted && !isRestRow && !isGolfRow && !useAirport && !isPHRow && !isPSRow);
        const wantsGolf =
          isGolfRow || (golfPathPasted && !isRestRow && !isSpaRow && !useAirport && !isPHRow && !isPSRow);
        const wantsPH = isPHRow && !useAirport && !isPSRow;
        const wantsPS = isPSRow && !useAirport;
        const wantsSpecialOverview =
          hasSpecialNote &&
          !isPHRow &&
          !isMsgRow &&
          !isSpecialNoticeRow &&
          !useAirport &&
          !useDining &&
          !useSpa &&
          !useGolf &&
          !isPSRow;
        const wantsMessageBanner = isMsgRow && !useAirport && !isPSRow;
        const wantsSpecialNotice = isSpecialNoticeRow && !useAirport && !isPSRow;
        const wantsOperationHours = isHoursRow && !useAirport && !isPSRow;
        const wantsSpaHours = isSpaHoursRow && !useAirport && !isPSRow;
        const wantsGolfHours = isGolfHoursRow && !useAirport && !isPSRow;
        const psHintRaw = isPSRow && propertySearchDesc ? normalizeText(propertySearchDesc) : '';
        const psHint = psHintRaw ? truncateForResultPreview(psHintRaw) : '';
        const actualFallback =
          airportHint ||
          diningNameHint ||
          diningDescriptionHint ||
          hotelOverviewHint ||
          hotelQuoteHint ||
          diningOverviewHint ||
          diningHint ||
          operationHoursHint ||
          spaHoursHint ||
          spaHint ||
          golfNameHint ||
          golfDescriptionHint ||
          golfHoursHint ||
          golfHint ||
          specialHint ||
          messageHint ||
          specialNoticeHint ||
          phHint ||
          psHint;

        let failNote = 'Expected and actual do not match.';
        if (airportHint) {
          failNote =
            'Expected text not found. "Actual" is the Local Information airport line (p.airport).';
        } else if (diningDescriptionHint) {
          failNote = diningDescriptionHintRaw
            ? 'Expected restaurant description not found. "Actual" is the matched outlet description from the dining page.'
            : 'Expected restaurant description not found. The matched outlet had no description paragraph — only hours or meta lines were scraped.';
        } else if (diningNameHint) {
          failNote =
            'Expected restaurant name not found. "Actual" is the matched outlet name from the dining page.';
        } else if (golfDescriptionHint) {
          failNote = golfDescriptionHintRaw
            ? 'Expected golf course description not found. "Actual" is the matched course description from the golf page.'
            : 'Expected golf course description not found. The matched course had no description paragraph scraped.';
        } else if (golfNameHint) {
          failNote =
            'Expected golf course name not found. "Actual" is the matched course name from the golf page.';
        } else if (hotelOverviewHint) {
          failNote =
            'Expected text not found. "Actual" is the property-overview body from `.col-md-7` (main `<p>` copy only).';
        } else if (hotelQuoteHint) {
          failNote =
            'Expected text not found. "Actual" is the property-overview subheader quote (`.subheader.font-amiri`).';
        } else if (diningOverviewHint) {
          failNote =
            'Expected text not found. "Actual" is the dining page overview intro (/services-amenities/dining).';
        } else if (diningHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the dining page (/services-amenities/dining).';
        } else if (operationHoursHint) {
          failNote =
            'Expected text not found. "Actual" is operation hours from `div.hours` on the dining page.';
        } else if (spaHoursHint) {
          failNote =
            'Expected text not found. "Actual" is spa/fitness hours from `#hotel-amenities` or the spa amenities page.';
        } else if (golfHoursHint) {
          failNote =
            'Expected text not found. "Actual" is golf hours from `#hotel-amenities section.course-hours div.hours` or the matched course on /services-amenities/golf.';
        } else if (wantsSpaHours && !spaHoursHintRaw) {
          failNote =
            'Expected spa hours not found. Use a spa hours row label (e.g. “Spa Hours”) — the site shows times in a `<p>` with Weekdays / Fitness Center / Massage lines.';
        } else if (wantsGolfHours && !golfHoursHintRaw) {
          failNote =
            'Expected golf hours not found. Use a golf hours row label (e.g. “Golf #1 Hours” or “Hours of Operation” with golf schedule text) — the site shows times in `#hotel-amenities section.course-hours div.hours` or on /services-amenities/golf.';
        } else if (wantsOperationHours && !operationHoursHintRaw) {
          failNote =
            'Expected text not found, no matching `div.hours` for this row, or label missing Restaurant #N / outlet name (e.g. “CORI Table - Hours of Operation”).';
        } else if (spaHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the spa page (/services-amenities/spa).';
        } else if (golfHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the golf page (/services-amenities/golf).';
        } else if (specialHint) {
          failNote =
            'Expected text not found. "Actual" is the property-overview block (column H special note).';
        } else if (wantsSpecialOverview && !specialHintRaw) {
          failNote =
            'Column H is set (special note) but the property-overview pinned selector returned no text.';
        } else if (messageHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the overview message banner (`div.message`).';
        } else if (wantsMessageBanner && !messageHintRaw) {
          failNote =
            'Expected text not found, or the overview message banner (`#main-content div.message`) returned no text.';
        } else if (specialNoticeHint) {
          const noticeIdx =
            specialNoticeOrdinal > 0 ? specialNoticeOrdinal : specialNoticeRowSeq;
          failNote =
            specialNoticeMessages.length > 1
              ? `Expected text not found. "Actual" is special-notice block ${noticeIdx} of ${specialNoticeMessages.length} (\`div.alert.alert-info.special-notice div.message\`).`
              : 'Expected text not found. "Actual" is visible copy from the special-notice block (`div.alert.alert-info.special-notice div.message`).';
        } else if (wantsSpecialNotice && !specialNoticeHintRaw) {
          failNote =
            specialNoticeMessages.length > 1
              ? `Expected text not found, or no matching special-notice block (${specialNoticeMessages.length} on page). Use labels like "Special Notice #1" / "#2", or ensure expected text matches one block.`
              : 'Expected text not found, or the special-notice block (`div.alert.alert-info.special-notice div.message`) returned no text.';
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
          status: 'Failed',
          note: failNote,
        });
      }
      } catch (rowErr) {
        const message = rowErr instanceof Error ? rowErr.message : String(rowErr);
        // eslint-disable-next-line no-console
        console.log(`[Runner] Row "${section}" failed — continuing with remaining rows. (${message})`);
        results.push({
          section,
          language: lang,
          expectedText: expected,
          actualText: '',
          status: 'Failed',
          note: `Row error (run continued for remaining rows): ${message}`,
        });
      }
    }

    // Per-feature comparison output (replaces the single blob row for the 4 feature labels).
    if (expectedFeatures.length > 0) {
      const selectorMissing = !normalizeText(actualFeaturesText);
      // eslint-disable-next-line no-console
      console.log(
        `[Runner] Comparing ${expectedFeatures.length} expected feature(s) against the actual features block…`,
      );
      const comparison = compareFeatures(expectedFeatures, actualFeaturesText);
      for (const { feature, sourceLabel, found, actualSnippet } of comparison) {
        try {
          if (selectorMissing) {
            results.push({
              section: `Hotel Features → ${normalizeSectionLabel(sourceLabel)}`,
              language: lang,
              expectedText: feature,
              actualText: FEATURE_STATUS.SELECTOR_NOT_FOUND,
              status: 'Failed',
              note:
                'The features selector (section.features … row > div > div) did not match anything on the page.',
            });
            continue;
          }
          results.push({
            section: `Hotel Features → ${normalizeSectionLabel(sourceLabel)}`,
            language: lang,
            expectedText: feature,
            actualText: found
              ? actualSnippet || FEATURE_STATUS.FOUND
              : FEATURE_STATUS.MISSING,
            status: found ? 'Passed' : 'Failed',
            note: found ? 'Fields match.' : 'Expected and actual do not match.',
          });
        } catch (featureErr) {
          // Per-feature try/catch — a bad single feature does not stop the others.
          const message = featureErr instanceof Error ? featureErr.message : String(featureErr);
          // eslint-disable-next-line no-console
          console.log(`[Runner] Feature "${feature}" failed — continuing. (${message})`);
          results.push({
            section: `Hotel Features → ${normalizeSectionLabel(sourceLabel)}`,
            language: lang,
            expectedText: feature,
            actualText: '',
            status: 'Failed',
            note: `Feature comparison error (run continued for remaining features): ${message}`,
          });
        }
      }
    }
  } catch (err) {
    if (isRunCancelledError(err)) {
      throw err;
    }
    // Setup/navigation level error — surface a synthetic row so the UI still renders.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(`[Runner] Fatal error before/while reading the page: ${message}`);
    results.push({
      section: '(run error)',
      language: lang,
      expectedText: '',
      actualText: '',
      status: 'Failed',
      note: message,
    });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (ownsBrowser && browser) {
      clearActiveRunBrowser(browser);
      await browser.close().catch(() => {});
    }
    // Stamp the hotel name on every result row so the front-end can render a "Hotel" column
    // without having to plumb it through every push site.
    for (const r of results) {
      r.hotelName = hotelName;
    }
    const counts = results.reduce(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      /** @type {Record<string, number>} */ ({}),
    );
    // eslint-disable-next-line no-console
    console.log(
      `[Runner] Finished ${lang} in ${((Date.now() - langRunStartedAt) / 1000).toFixed(1)}s — Passed=${counts.Passed || 0}, Failed=${counts.Failed || 0}, Skipped=${counts.Skipped || 0}`,
    );
  }

  return {
    results,
    diningMeta,
    spaMeta,
    golfMeta,
    propertySearchMeta,
    propertyOverviewSpecialMeta,
    propertyHighlightMeta,
    messageBannerMeta,
    specialNoticeMessage,
    specialNoticeMessages,
    operationHours,
    hotelName,
  };
}

module.exports = {
  runComparison,
  isCopyMismatchResult,
  launchRunBrowser,
  setActiveRunBrowser,
  closeActiveRunBrowser,
  isRunCancelledError,
  normalizeText,
  normalizeSectionLabel,
  readLocalInformationAirportText,
  readServicesAmenitiesBlock,
  readDiningServicesBlock,
  DINING_OPERATION_HOURS_SELECTOR,
  isDiningOperationHoursSectionLabel,
  isDiningOverviewSectionLabel,
  isHotelPropertyOverviewSectionLabel,
  isHotelPropertyQuoteSectionLabel,
  diningHoursOrdinalFromLabel,
  pickOperationHoursText,
  pickDiningOutletBySignals,
  pickDiningOutletText,
  isSpaDescriptionSectionLabel,
  isSpaHoursSectionLabel,
  isSpaTitleSectionLabel,
  normalizeSpaHoursText,
  pickSpaTextForRow,
  textsMatchSpaTitle,
  textsMatchOutletTitle,
  compactOutletTitleForCompare,
  looksLikeSpaScheduleLine,
  normalizeOperationHours,
  normalizeOperationHoursForCompare,
  textsMatchOperationHours,
  readDiningOperationHoursOnCurrentPage,
  readDiningOverviewOnCurrentPage,
  readHotelPropertyOverviewBody,
  readHotelPropertyOverviewQuote,
  readDiningOutletBlocksOnCurrentPage,
  formatOperationHoursForPreview,
  readSpaServicesBlock,
  readGolfServicesBlock,
  scrapeGolfCoursesFromPage,
  GOLF_COURSE_TITLE_SELECTOR,
  isGolfSectionLabel,
  isGolfDescriptionSectionLabel,
  isGolfTitleSectionLabel,
  isGolfHoursSectionLabel,
  golfOrdinalFromLabel,
  pickGolfTextForRow,
  SPA_TITLE_SELECTOR,
  SPA_TITLE_H3_SELECTOR,
  extractSpaTitleAndDescriptionParts,
  extractSpaTitleAndDetailsText,
  waitForLocalInformationSection,
  isLocalInformationSectionLabel,
  isRestaurantSectionLabel,
  isSpaSectionLabel,
  isPropertyHighlightSectionLabel,
  isPropertySearchSectionLabel,
  // Legacy name kept for any external consumer; same function as `derivePropertySearchQueryFromUrl`.
  deriveHotelSearchQueryFromHotelUrl: derivePropertySearchQueryFromUrl,
  derivePropertySearchQueryFromUrl,
  runPropertySearchAndReadHotelDesc,
  isFeatureSectionLabel,
  buildExpectedFeatures,
  readActualFeaturesText,
  compareFeatures,
  isPropertyHighlightTitleLabel,
  propertyHighlightTitleOrdinalFromLabel,
  compareHighlightTitle,
  readAllPropertyHighlightTitles,
  propertyHighlightOrdinalFromLabel,
  readPropertyHighlightSegments,
  HOTEL_MESSAGE_BANNER_SELECTOR,
  isHotelMessageBannerSectionLabel,
  readHotelMessageBannerBlock,
  isSpecialNoticeSectionLabel,
  SPECIAL_NOTICE_SELECTOR,
  SPECIAL_NOTICE_SELECTORS,
  normalizeSpecialNoticeMessage,
  specialNoticeOrdinalFromLabel,
  readAllSpecialNoticeMessages,
  pickSpecialNoticeText,
  resolveSpecialNoticeBlock,
  specialNoticeBlockIndexForExpected,
  textsMatchExpected,
  textsMatchExpectedStrict,
  formatSpecialNoticesForPreview,
  readSpecialNoticeMessage,
  LOCAL_INFO_AIRPORT_SELECTOR_FULL,
  LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK,
};
