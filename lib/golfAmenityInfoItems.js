/**
 * Golf amenity tiles on the hotel overview (`#hotel-amenities` → Golf block).
 */

const { normalizeText } = require('./textNormalize');
const { dismissOptionalCookieBanner, buildGolfServicesUrl } = require('./changeLanguage');

/** Max wait for `page.goto` on golf subpage amenity scrape. */
const PAGE_GOTO_TIMEOUT_MS = 25_000;

/** Heading matchers for label fallbacks (Excel labels stay English; site may be EN/FR/DE/ES/IT). */
const GOLF_AMENITY_HEADING_PATTERNS = Object.freeze({
  golfLessons:
    /\b(golf\s*lessons?|cours\s*de\s*golf|lezione\w*\s*di\s*golf|clases?\s*de\s*golf|golfunterricht)\b/i,
  dressCode:
    /\b(dress\s*code|code\s*vestimentaire|codice\s*vestiario|codigo\s*de\s*vestiment|kleiderordnung)\b/i,
  handicapMen:
    /\b(handicap\s*men|handicap\s*hommes?|handicap\s*masculin|handicap\s*maschile|handicap\s*hombre|no\s*restriction\s*for\s*men|aucune\s*restriction\s*(pour\s*)?les?\s*hommes?)\b/i,
  handicapWomen:
    /\b(handicap\s*women|handicap\s*femmes?|handicap\s*féminin|handicap\s*femminil|handicap\s*mujer|no\s*restriction\s*for\s*women|aucune\s*restriction\s*(pour\s*)?les?\s*femmes?)\b/i,
});

const GOLF_AMENITY_OPERATION_HOURS_SELECTOR =
  '#hotel-amenities > section > div:nth-child(4) > section.course-hours.mt-5 > div.hours';

const GOLF_AMENITY_OPERATION_HOURS_FALLBACK =
  '#hotel-amenities section.course-hours div.hours';

/** @type {Record<string, string>} */
const GOLF_AMENITY_INFO_SELECTOR = Object.freeze({
  golfLessons:
    '#hotel-amenities > section > div:nth-child(4) > section:nth-child(4) > div.row.no-gutters.info-items > div:nth-child(7)',
  dressCode:
    '#hotel-amenities > section > div:nth-child(4) > section:nth-child(3) > div.row.no-gutters.info-items > div:nth-child(4) > div',
  handicapMen:
    '#hotel-amenities > section > div:nth-child(4) > section:nth-child(3) > div.row.no-gutters.info-items > div:nth-child(3) > div > p:nth-child(2)',
  handicapWomen:
    '#hotel-amenities > section > div:nth-child(4) > section:nth-child(3) > div.row.no-gutters.info-items > div:nth-child(3) > div > p:nth-child(3)',
});

/** @type {Record<string, RegExp>} */
const GOLF_AMENITY_INFO_LABEL_FALLBACK = GOLF_AMENITY_HEADING_PATTERNS;

/** @type {Record<string, RegExp>} */
const GOLF_AMENITY_INFO_ROW_LABEL = Object.freeze({
  golfLessons: /^golf\s*lessons?(?:\s*note)?$/i,
  dressCode: /^dress\s*code$/i,
  handicapMen: /^handicap\s*men$/i,
  handicapWomen: /^handicap\s*women$/i,
});

/** Keys that pass when expected text appears inside actual (handicap lines). */
const GOLF_AMENITY_PARTIAL_MATCH_KEYS = new Set(['handicapMen', 'handicapWomen']);

/**
 * @typedef {'golfLessons'|'dressCode'|'handicapMen'|'handicapWomen'} GolfAmenityInfoKey
 */

/**
 * @param {string} message
 */
function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[Golf amenity info] ${message}`);
}

/**
 * @param {string} label
 * @returns {boolean}
 */
function isGolfAmenityInfoItemLabel(label) {
  return Boolean(golfAmenityInfoItemKeyFromLabel(label));
}

/**
 * @param {string} label
 * @returns {''|GolfAmenityInfoKey}
 */
function golfAmenityInfoItemKeyFromLabel(label) {
  const s = normalizeText(label);
  if (!s) {
    return '';
  }
  for (const [key, pattern] of Object.entries(GOLF_AMENITY_INFO_ROW_LABEL)) {
    if (pattern.test(s)) {
      return /** @type {GolfAmenityInfoKey} */ (key);
    }
  }
  return '';
}

/**
 * Dress Code + Golf Lessons (Note): normalized equality or mutual substring.
 * @param {string} expected
 * @param {string} actual
 * @returns {{ match: boolean }}
 */
function compareGolfAmenityInfoItem(expected, actual) {
  const e = normalizeText(expected).toLowerCase();
  const a = normalizeText(actual).toLowerCase();
  if (!e || !a) {
    return { match: false };
  }
  if (e === a || a.includes(e) || e.includes(a)) {
    return { match: true };
  }
  return { match: false };
}

/**
 * Handicap Men / Women: pass when expected is contained in actual.
 * @param {string} expected
 * @param {string} actual
 * @returns {{ match: boolean }}
 */
function compareGolfAmenityHandicap(expected, actual) {
  const e = normalizeText(expected).toLowerCase();
  const a = normalizeText(actual).toLowerCase();
  if (!e || !a) {
    return { match: false };
  }
  if (a.includes(e) || e === a) {
    return { match: true };
  }
  return { match: false };
}

/**
 * @param {GolfAmenityInfoKey} key
 * @param {string} expected
 * @param {string} actual
 * @returns {{ match: boolean }}
 */
function compareGolfAmenityInfoItemForKey(key, expected, actual) {
  if (GOLF_AMENITY_PARTIAL_MATCH_KEYS.has(key)) {
    return compareGolfAmenityHandicap(expected, actual);
  }
  return compareGolfAmenityInfoItem(expected, actual);
}

/**
 * @param {import('playwright').Page} page
 */
async function ensureHotelAmenitiesTabVisible(page) {
  const servicesPatterns = [
    /services\s*&\s*amenities/i,
    /services\s*and\s*amenities/i,
    /services\s*et\s*équipements/i,
    /services\s*et\s*equipements/i,
    /servicios\s*y\s*servicios/i,
    /servizi\s*e\s*servizi/i,
    /dienstleistungen/i,
  ];
  for (const pattern of servicesPatterns) {
    const servicesBtn = page.getByRole('button', { name: pattern }).first();
    if (await servicesBtn.isVisible({ timeout: 1200 }).catch(() => false)) {
      await servicesBtn.click({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(200);
      break;
    }
    const servicesLink = page.getByRole('link', { name: pattern }).first();
    if (await servicesLink.isVisible({ timeout: 800 }).catch(() => false)) {
      await servicesLink.click({ timeout: 5000, force: true }).catch(() => {});
      await page.waitForTimeout(200);
      break;
    }
  }

  const stickyAmenities = page
    .locator(
      '.sticky-nav a, .sticky-nav button, [class*="sticky"] a, [class*="sticky"] button, a[href*="amenit"]',
    )
    .filter({
      hasText:
        /hotel\s*amenities|services\s*&\s*amenities|équipements|equipements|servicios|servizi|annehmlichkeiten/i,
    })
    .first();
  if (await stickyAmenities.isVisible({ timeout: 800 }).catch(() => false)) {
    await stickyAmenities.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(100);
  }

  const tab = page
    .getByRole('tab', { name: /hotel\s*amenities|hotel\s*équipements|équipements|amenities/i })
    .first();
  if (await tab.isVisible({ timeout: 800 }).catch(() => false)) {
    await tab.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(100);
  }

  await page
    .evaluate(() => {
      location.hash = 'hotel-amenities';
    })
    .catch(() => {});

  const root = page.locator('#hotel-amenities, .info-items').first();
  await root.waitFor({ state: 'attached', timeout: 8_000 }).catch(() => {});
  await root.scrollIntoViewIfNeeded().catch(() => {});
}

/**
 * @param {{ items: Record<GolfAmenityInfoKey, string>, operationHours: string }} data
 * @returns {boolean}
 */
function isGolfAmenityDataEmpty(data) {
  const items = data?.items || {};
  return !Object.values(items).some((v) => normalizeText(v)) && !normalizeText(data?.operationHours);
}

/**
 * @param {import('playwright').Page} page
 */
async function expandGolfBlockInAmenities(page) {
  const amenityRoot = page.locator('#hotel-amenities').first();
  const root =
    (await amenityRoot.count().catch(() => 0)) > 0
      ? amenityRoot
      : page.locator('#main-content, body').first();
  const triggers = [
    root.getByRole('button', { name: /^\s*golf\s*$/i }).first(),
    root.getByRole('tab', { name: /^\s*golf\s*$/i }).first(),
    page.getByRole('link', { name: /^\s*golf\s*$/i }).first(),
    root.locator('a, button, [data-toggle="collapse"]').filter({ hasText: /^\s*golf\s*$/i }).first(),
    root.locator('h2, h3').filter({ hasText: /^\s*golf\s*$/i }).first(),
  ];
  for (const trigger of triggers) {
    if (await trigger.isVisible({ timeout: 400 }).catch(() => false)) {
      await trigger.click({ timeout: 3000, force: true }).catch(() => {});
      await page.waitForTimeout(100);
      break;
    }
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<string>}
 */
async function readTextFromSelector(page, selector) {
  if (!selector) {
    return '';
  }
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) > 0) {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const text = await loc.innerText({ timeout: 8000 }).catch(() => '');
      if (normalizeText(text)) {
        return String(text).trim();
      }
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * @param {import('playwright').Page} page
 * @param {GolfAmenityInfoKey} key
 * @returns {Promise<string>}
 */
async function readGolfAmenityInfoItemByKey(page, key) {
  const selector = GOLF_AMENITY_INFO_SELECTOR[key];
  const text = await readTextFromSelector(page, selector);
  if (normalizeText(text)) {
    return text;
  }

  const fallbackPattern = GOLF_AMENITY_INFO_LABEL_FALLBACK[key];
  if (!fallbackPattern) {
    return '';
  }

  try {
    const found = await page.evaluate((patternSource) => {
      const clean = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .trim();
      const pattern = new RegExp(patternSource, 'i');
      const root = document.querySelector('#hotel-amenities');
      if (!root) {
        return '';
      }
      for (const h3 of root.querySelectorAll('.info-items h3')) {
        const h3Text = clean(h3.innerText || h3.textContent);
        if (!pattern.test(h3Text)) {
          continue;
        }
        const card = h3.closest('div[class*="col-"]') || h3.parentElement;
        const em = card?.querySelector('em');
        if (em && /\bgolf\s*lessons?\b/i.test(patternSource)) {
          return clean(em.innerText || em.textContent);
        }
        const cardText = clean(card?.innerText || card?.textContent);
        const rest = cardText
          .replace(h3Text, '')
          .replace(/^[\s:–—-]+/, '')
          .trim();
        return rest.length >= 2 ? rest : cardText;
      }
      return '';
    }, fallbackPattern.source);
    if (normalizeText(found)) {
      return String(found).trim();
    }
  } catch {
    // ignore
  }

  return '';
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readGolfAmenityOperationHours(page) {
  const { operationHours } = await readAllGolfAmenityData(page);
  return operationHours;
}

/**
 * DOM scrape: pinned selectors, then label-based fallbacks under #hotel-amenities or .info-items.
 * @param {import('playwright').Page} page
 * @returns {Promise<{ items: Record<GolfAmenityInfoKey, string>, operationHours: string }>}
 */
async function scrapeGolfAmenityDataOnPage(page) {
  await page.locator('#hotel-amenities, .info-items').first().waitFor({ state: 'attached', timeout: 12_000 }).catch(() => {});

  return page.evaluate((selectors) => {
    const headingPatterns = {
      golfLessons:
        '\\b(golf\\s*lessons?|cours\\s*de\\s*golf|lezione\\w*\\s*di\\s*golf|clases?\\s*de\\s*golf|golfunterricht)\\b',
      dressCode:
        '\\b(dress\\s*code|code\\s*vestimentaire|codice\\s*vestiario|codigo\\s*de\\s*vestiment|kleiderordnung)\\b',
      handicapMen:
        '\\b(handicap\\s*men|handicap\\s*hommes?|no\\s*restriction\\s*for\\s*men)\\b',
      handicapWomen:
        '\\b(handicap\\s*women|handicap\\s*femmes?|no\\s*restriction\\s*for\\s*women)\\b',
    };
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
    const readSel = (sel) => (sel ? pick(document.querySelector(sel)) : '');

    const roots = [
      document.querySelector('#hotel-amenities'),
      document.querySelector('#main-content'),
      document.body,
    ].filter(Boolean);

    const infoColumnByHeading = (patternSource) => {
      const headingRe = new RegExp(patternSource, 'i');
      for (const root of roots) {
        for (const h3 of root.querySelectorAll('.info-items h3, h3')) {
          const h3Text = clean(h3.innerText || h3.textContent);
          if (!headingRe.test(h3Text)) {
            continue;
          }
          const col =
            h3.closest('.info-items > div') ||
            h3.closest('div[class*="col-"]') ||
            h3.parentElement?.parentElement ||
            h3.parentElement;
          const colText = pick(col);
          const em = col?.querySelector?.('em') || h3.parentElement?.querySelector('em');
          const emText = em ? clean(em.innerText || em.textContent) : '';
          if (/\bgolf\s*lessons?\b/i.test(patternSource) && emText) {
            return emText;
          }
          if (colText) {
            const rest = colText
              .replace(h3Text, '')
              .replace(/^[\s:–—-]+/, '')
              .trim();
            return rest.length >= 2 ? rest : colText;
          }
          if (emText) {
            return emText;
          }
        }
      }
      return '';
    };

    const handicapLine = (which) => {
      const menRe = /\b(men|hommes?|masculin|maschile|hombre)\b/i;
      const womenRe = /\b(women|femmes?|féminin|femminil|mujer)\b/i;
      for (const root of roots) {
        for (const h3 of root.querySelectorAll('.info-items h3, h3')) {
          const h3Text = clean(h3.innerText || h3.textContent);
          if (!/\bhandicap\b/i.test(h3Text) && !/course\s*handicap/i.test(h3Text)) {
            continue;
          }
          const card = h3.closest('div[class*="col-"]') || h3.parentElement;
          const ps = card ? [...card.querySelectorAll('p')] : [];
          for (const p of ps) {
            const line = pick(p);
            if (!line) {
              continue;
            }
            if (which === 'men' && (menRe.test(line) || (ps.indexOf(p) === 1 && !womenRe.test(line)))) {
              return line;
            }
            if (which === 'women' && womenRe.test(line)) {
              return line;
            }
          }
          if (which === 'men' && ps[1]) {
            return pick(ps[1]);
          }
          if (which === 'women' && ps[2]) {
            return pick(ps[2]);
          }
        }
      }
      return '';
    };

    const items = {
      golfLessons: readSel(selectors.golfLessons),
      dressCode: readSel(selectors.dressCode),
      handicapMen: readSel(selectors.handicapMen),
      handicapWomen: readSel(selectors.handicapWomen),
    };

    if (!items.golfLessons) {
      items.golfLessons = infoColumnByHeading(headingPatterns.golfLessons);
    }
    if (!items.dressCode) {
      items.dressCode = infoColumnByHeading(headingPatterns.dressCode);
    }
    if (!items.handicapMen) {
      items.handicapMen = handicapLine('men');
    }
    if (!items.handicapWomen) {
      items.handicapWomen = handicapLine('women');
    }

    let operationHours =
      readSel(selectors.operationHours) || readSel(selectors.operationHoursFallback);
    if (!operationHours) {
      for (const root of roots) {
        const golfRoot =
          root.querySelector?.('section > div:nth-child(4)') ||
          [...(root.querySelectorAll('section > div') || [])].find((div) =>
            /golf/i.test(clean(div.querySelector('h2,h3')?.innerText)),
          );
        if (golfRoot) {
          operationHours = pick(
            golfRoot.querySelector('section.course-hours div.hours') ||
              golfRoot.querySelector('.course-hours .hours') ||
              golfRoot.querySelector('div.hours'),
          );
          if (operationHours) {
            break;
          }
        }
      }
    }

    return { items, operationHours };
  }, {
    golfLessons: GOLF_AMENITY_INFO_SELECTOR.golfLessons,
    dressCode: GOLF_AMENITY_INFO_SELECTOR.dressCode,
    handicapMen: GOLF_AMENITY_INFO_SELECTOR.handicapMen,
    handicapWomen: GOLF_AMENITY_INFO_SELECTOR.handicapWomen,
    operationHours: GOLF_AMENITY_OPERATION_HOURS_SELECTOR,
    operationHoursFallback: GOLF_AMENITY_OPERATION_HOURS_FALLBACK,
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} overviewUrl
 * @returns {Promise<{ items: Record<GolfAmenityInfoKey, string>, operationHours: string }>}
 */
/**
 * @param {{ items: Record<GolfAmenityInfoKey, string>, operationHours: string }} data
 * @param {string} [passLabel]
 */
function logGolfAmenityScrapeResult(data, passLabel = '') {
  const prefix = passLabel ? `${passLabel} ` : '';
  for (const key of Object.keys(data.items)) {
    log(
      `${prefix}${key} → ${data.items[key] ? JSON.stringify(data.items[key]) : '(selector not found)'}`,
    );
  }
  log(
    `${prefix}operationHours → ${data.operationHours ? `${data.operationHours.length} chars` : '(selector not found)'}`,
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {string} hotelPageUrl
 * @param {string} languageCode
 * @returns {Promise<{ items: Record<GolfAmenityInfoKey, string>, operationHours: string }>}
 */
async function readGolfAmenityDataOnGolfSubpage(page, hotelPageUrl, languageCode) {
  /** @type {Record<GolfAmenityInfoKey, string>} */
  const emptyItems = { golfLessons: '', dressCode: '', handicapMen: '', handicapWomen: '' };
  const targetUrl = buildGolfServicesUrl(hotelPageUrl, languageCode);
  if (!targetUrl) {
    return { items: emptyItems, operationHours: '' };
  }
  try {
    log(`Opening golf subpage for amenity tiles → ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'commit', timeout: PAGE_GOTO_TIMEOUT_MS });
    await dismissOptionalCookieBanner(page);
    await page
      .locator('h3.golf-course-title, #golf-hero-title')
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});
    const scraped = await scrapeGolfAmenityDataOnPage(page);
    const data = {
      items: { ...emptyItems, ...(scraped?.items || {}) },
      operationHours: String(scraped?.operationHours || '').trim(),
    };
    logGolfAmenityScrapeResult(data, 'golf-subpage');
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`golf-subpage read threw: ${message}`);
    return { items: emptyItems, operationHours: '' };
  }
}

async function readAllGolfAmenityData(page, options = {}) {
  /** @type {Record<GolfAmenityInfoKey, string>} */
  const emptyItems = { golfLessons: '', dressCode: '', handicapMen: '', handicapWomen: '' };
  const { skipOverviewAttempt = false } = options;

  if (skipOverviewAttempt) {
    return { items: emptyItems, operationHours: '' };
  }

  try {
    log('Reading golf tiles + hours (#hotel-amenities on current page)…');
    await ensureHotelAmenitiesTabVisible(page);
    await expandGolfBlockInAmenities(page);
    const scraped = await scrapeGolfAmenityDataOnPage(page);
    const items = { ...emptyItems, ...(scraped?.items || {}) };
    const operationHours = String(scraped?.operationHours || '').trim();
    const data = { items, operationHours };
    logGolfAmenityScrapeResult(data, 'overview');
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`overview read threw: ${message}`);
    return { items: emptyItems, operationHours: '' };
  }
}

/**
 * Merge scraped golf amenity fields into runner maps.
 * @param {Record<GolfAmenityInfoKey, string>} infoMap
 * @param {string} hoursOut
 * @param {{ items?: Record<GolfAmenityInfoKey, string>, operationHours?: string } | null} scraped
 * @returns {{ infoMap: Record<GolfAmenityInfoKey, string>, hoursOut: string }}
 */
function mergeGolfAmenityScrape(infoMap, hoursOut, scraped) {
  const items = scraped?.items || {};
  const nextMap = { ...infoMap };
  for (const key of Object.keys(nextMap)) {
    if (!normalizeText(nextMap[key]) && normalizeText(items[key])) {
      nextMap[key] = items[key];
    }
  }
  let nextHours = hoursOut;
  if (!normalizeText(nextHours) && normalizeText(scraped?.operationHours)) {
    nextHours = String(scraped.operationHours).trim();
  }
  return { infoMap: nextMap, hoursOut: nextHours };
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<Record<GolfAmenityInfoKey, string>>}
 */
async function readAllGolfAmenityInfoItems(page) {
  const { items } = await readAllGolfAmenityData(page);
  return items;
}

module.exports = {
  GOLF_AMENITY_INFO_SELECTOR,
  GOLF_AMENITY_OPERATION_HOURS_SELECTOR,
  GOLF_AMENITY_OPERATION_HOURS_FALLBACK,
  isGolfAmenityInfoItemLabel,
  golfAmenityInfoItemKeyFromLabel,
  compareGolfAmenityInfoItem,
  compareGolfAmenityHandicap,
  compareGolfAmenityInfoItemForKey,
  readGolfAmenityInfoItemByKey,
  readAllGolfAmenityInfoItems,
  readAllGolfAmenityData,
  readGolfAmenityDataOnGolfSubpage,
  readGolfAmenityOperationHours,
  scrapeGolfAmenityDataOnPage,
  mergeGolfAmenityScrape,
  isGolfAmenityDataEmpty,
  GOLF_AMENITY_HEADING_PATTERNS,
};
