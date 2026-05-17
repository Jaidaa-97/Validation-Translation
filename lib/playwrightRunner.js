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
const {
  normalizeText: sharedNormalizeText,
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

      const parts = [];
      if (title) {
        parts.push(title);
      }
      if (desc) {
        parts.push(desc);
      }
      return { title, description: desc, combined: parts.join('\n\n') };
    })
    .catch(() => ({ title: '', description: '', combined: '' }));

  const title = String(raw?.title || '').trim();
  const description = String(raw?.description || '').trim();
  const combined = String(raw?.combined || '').trim();
  return { title, description, combined };
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
  if (isDiningOperationHoursSectionLabel(s)) {
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
  const s = normalizeSectionLabel(sectionLabel);
  if (!s) {
    return false;
  }
  if (/property\s*highlight/i.test(s) || /property\s*search/i.test(s) || /local\s*information/i.test(s)) {
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
    .replace(/:\s*$/, '')
    .trim()
    .toLowerCase();
  return (
    t === 'hours of operation' ||
    t === 'operation hours' ||
    t === 'opening hours' ||
    t === 'dining hours' ||
    t === 'restaurant hours' ||
    t === 'hours'
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeOutletNameForMatch(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
    const name = normalizeOutletNameForMatch(o.name);
    if (!name || name.length < 3) {
      continue;
    }
    if (name === wanted || name.includes(wanted) || wanted.includes(name)) {
      return o.hours;
    }
  }
  return '';
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
) {
  if (!operationHours?.outlets?.length) {
    return '';
  }
  const outlets = operationHours.outlets;

  const byPreferredName = pickOperationHoursByOutletName(operationHours, preferredOutletName);
  if (byPreferredName) {
    return byPreferredName;
  }

  const byLabelName = pickOperationHoursByOutletName(operationHours, sectionLabel);
  if (byLabelName) {
    return byLabelName;
  }

  if (ordinal > 0 && outlets[ordinal - 1]) {
    return outlets[ordinal - 1].hours;
  }

  if (outlets.length === 1) {
    return outlets[0].hours;
  }

  // Multiple outlets but no index in the label — do not paste the same block on every row.
  return '';
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
 * @returns {string}
 */
function pickSpaTextForRow(sectionLabel, spaBlock, spaTitle, spaDescription) {
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

/**
 * Visible copy from the overview “message” strip (e.g. Summer 2026 notice: title, body paragraphs, CTA link text).
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readHotelMessageBannerBlock(page) {
  const primary = page.locator(HOTEL_MESSAGE_BANNER_SELECTOR).first();
  await primary.waitFor({ state: 'attached', timeout: 25_000 }).catch(() => {});
  await primary.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

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
        const el = document.querySelector(sel);
        if (!el) {
          continue;
        }
        const t = richer(el.innerText, el.textContent);
        if (t.length > 12) {
          return t;
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
 * Read the overview special-notice block (title, paragraphs, CTA link text).
 * Returns empty string when the element is missing — callers map that to `null`.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readSpecialNoticeMessage(page) {
  const loc = page.locator(SPECIAL_NOTICE_SELECTOR).first();
  await loc.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);

  const raw = await page
    .evaluate((selectors) => {
      const richer = (a, b) => {
        const x = String(a || '').replace(/\u00a0/g, ' ').trim();
        const y = String(b || '').replace(/\u00a0/g, ' ').trim();
        return x.length >= y.length ? x : y;
      };
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) {
          continue;
        }
        const t = richer(el.innerText, el.textContent);
        if (t.length > 5) {
          return t;
        }
      }
      return '';
    }, SPECIAL_NOTICE_SELECTORS)
    .catch(() => '');

  if (normalizeText(raw)) {
    return normalizeSpecialNoticeMessage(raw);
  }

  for (const sel of SPECIAL_NOTICE_SELECTORS) {
    try {
      const fallback = page.locator(sel).first();
      if ((await fallback.count()) === 0) {
        continue;
      }
      await fallback.scrollIntoViewIfNeeded().catch(() => {});
      const inner = await fallback.innerText({ timeout: 10_000 }).catch(() => '');
      const normalized = normalizeSpecialNoticeMessage(inner);
      if (normalizeText(normalized)) {
        return normalized;
      }
    } catch {
      // try next selector
    }
  }

  return '';
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
  await loc.waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
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
    /Überblick/i,
    /aperçu de l['’]hôtel/i,
    /panoramica/i,
    /descripción general/i,
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
      .filter({ hasText: /^overview$/i })
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
 * True if the English source cell is non-empty. Rows without English copy are ignored
 * so the runner does not spend time scraping sections that have no source row to verify.
 * @param {{ byLang: Record<string, string> }} row
 * @returns {boolean}
 */
function rowHasEnglishContent(row) {
  return Boolean(String(row.byLang?.ENG || '').trim());
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
 * @param {null | { title: string, description: string }} [spaPartOut] When `amenity === 'spa'`, receives structured title / description (not generic fallback text).
 * @param {null | { value: { outlets: { name: string, hours: string }[] } | null }} [diningOperationHoursOut] When `amenity === 'dining'`, receives structured operation hours.
 * @returns {Promise<string>}
 */
async function readServicesAmenitiesBlock(
  page,
  hotelPageUrl,
  languageCode,
  amenity,
  spaPartOut = null,
  diningOperationHoursOut = null,
) {
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
        .locator(SPA_TITLE_H3_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 20_000 })
        .catch(() => {});
      await page
        .locator(SPA_TITLE_SELECTOR)
        .first()
        .waitFor({ state: 'attached', timeout: 35_000 })
        .catch(() => {});
      await page
        .locator(`${SPA_TITLE_H3_SELECTOR}, ${SPA_TITLE_SELECTOR}`)
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await page
        .locator('.spa-details')
        .first()
        .waitFor({ state: 'attached', timeout: 35_000 })
        .catch(() => {});
      await page.locator('.spa-details').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      const parts = await extractSpaTitleAndDescriptionParts(page);
      const locTitle = await readSpaListTitleText(page);
      const title = String(locTitle || parts.title || '').trim();
      const description = parts.description;
      pageText = [title, description].filter(Boolean).join('\n\n').trim();
      if (spaPartOut) {
        spaPartOut.title = title;
        spaPartOut.description = description;
      }
      if (normalizeText(pageText).length < 40) {
        const generic = String((await extractLhwServicesPageText(page)) || '').trim();
        pageText = normalizeText(pageText) ? `${pageText}\n\n${generic}`.trim() : generic;
      }
    } else {
      pageText = String((await extractLhwServicesPageText(page)) || '').trim();
      if (diningOperationHoursOut) {
        try {
          diningOperationHoursOut.value = await readDiningOperationHoursOnCurrentPage(page);
        } catch {
          diningOperationHoursOut.value = null;
        }
      }
    }

    const skipSpaBulkInnerText =
      amenity === 'spa' &&
      spaPartOut &&
      (Boolean(normalizeText(spaPartOut.title)) || Boolean(normalizeText(spaPartOut.description)));

    if (pageText.length < 80 && !skipSpaBulkInnerText) {
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

/** Selector for dining operation hours on `/services-amenities/dining`. */
const DINING_OPERATION_HOURS_SELECTOR = 'div.hours';

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
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
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
 * @param {import('playwright').Page} page
 * @returns {Promise<{ outlets: { name: string, hours: string }[] } | null>}
 */
async function readDiningOperationHoursOnCurrentPage(page) {
  await page
    .locator(DINING_OPERATION_HOURS_SELECTOR)
    .first()
    .waitFor({ state: 'attached', timeout: 25_000 })
    .catch(() => {});
  await page.waitForTimeout(400);

  /** @type {{ name: string, hours: string }[]} */
  let outlets = await page
    .evaluate((selector) => {
      const cleanLine = (t) =>
        String(t || '')
          .replace(/\u00a0/g, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/[ \t]+/g, ' ')
          .trim();

      const normalizeHours = (raw) => {
        const lines = String(raw || '')
          .replace(/\u00a0/g, ' ')
          .replace(/<br\s*\/?>/gi, '\n')
          .split(/\r?\n/)
          .map((line) => cleanLine(line))
          .filter(Boolean);
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      };

      const isHoursLabel = (t) => {
        const x = cleanLine(t)
          .replace(/:\s*$/, '')
          .toLowerCase();
        return (
          x === 'hours of operation' ||
          x === 'operation hours' ||
          x === 'opening hours' ||
          x === 'dining hours' ||
          x === 'restaurant hours' ||
          x === 'hours'
        );
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

        const container =
          hoursEl.closest(
            'article, [class*="restaurant"], [class*="dining"], [class*="venue"], .card, section, li, .col',
          ) || hoursEl.parentElement;

        if (container) {
          const headings = container.querySelectorAll(
            'h1,h2,h3,h4,h5,h6,.restaurant-name,.dining-title,[class*="restaurant-name"]',
          );
          /** @type {Element[]} */
          const before = [];
          for (const el of headings) {
            if (hoursEl.contains(el)) {
              continue;
            }
            if (el.compareDocumentPosition(hoursEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
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
        for (let i = 0; i < 8 && prev; i++) {
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

      /** @type {{ name: string, hours: string }[]} */
      const collected = [];
      const seen = new Set();

      for (const hoursEl of document.querySelectorAll(selector)) {
        const richer = (a, b) => {
          const x = String(a || '').replace(/\u00a0/g, ' ').trim();
          const y = String(b || '').replace(/\u00a0/g, ' ').trim();
          return x.length >= y.length ? x : y;
        };
        const hours = normalizeHours(richer(hoursEl.innerText, hoursEl.textContent));
        if (hours.length < 4) {
          continue;
        }
        const key = hours.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        let name = outletNameFor(hoursEl);
        if (!name) {
          name = `Dining outlet ${collected.length + 1}`;
        }
        collected.push({ name, hours });
      }
      return collected;
    }, DINING_OPERATION_HOURS_SELECTOR)
    .catch(() => []);

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
          hours,
        });
      } catch {
        // next
      }
    }
  }

  outlets = outlets
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

  if (!outlets.length) {
    return null;
  }

  return { outlets };
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
async function readDiningServicesBlock(page, hotelPageUrl, languageCode) {
  const hoursHolder = { value: /** @type {{ outlets: { name: string, hours: string }[] } | null} */ (null) };
  const block = await readServicesAmenitiesBlock(
    page,
    hotelPageUrl,
    languageCode,
    'dining',
    null,
    hoursHolder,
  );
  return {
    block: String(block || '').trim(),
    operationHours: hoursHolder.value,
  };
}

/** @param {import('playwright').Page} page */
async function readSpaServicesBlock(page, hotelPageUrl, languageCode) {
  const spaParts = { title: '', description: '' };
  const block = await readServicesAmenitiesBlock(page, hotelPageUrl, languageCode, 'spa', spaParts);
  return {
    block: String(block || '').trim(),
    title: String(spaParts.title || '').trim(),
    description: String(spaParts.description || '').trim(),
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
 * @returns {Promise<{ results: object[], diningMeta: object, spaMeta: object, propertySearchMeta: object, propertyOverviewSpecialMeta: object, propertyHighlightMeta: object, messageBannerMeta: object, specialNoticeMessage: string|null, operationHours: { outlets: { name: string, hours: string }[] } | null, hotelName: string }>}
 */
async function runComparison({ excelPath, languageCode, pageUrl, headless = true }) {
  const lang = String(languageCode || '')
    .trim()
    .toUpperCase();
  const rows = readContentSheet(excelPath);
  const searchableRows = rows.filter(rowHasEnglishContent);
  // eslint-disable-next-line no-console
  console.log(
    `[Runner] Starting comparison (language=${lang}, rows=${rows.length}, searchableRows=${searchableRows.length}, url=${pageUrl})`,
  );
  const needsLocalInfoBlock = searchableRows.some((r) => isLocalInformationSectionLabel(r.section));
  const diningPathPasted = isDiningServicesPath(pageUrl);
  const spaPathPasted = isSpaServicesPath(pageUrl);
  const needsDiningOperationHoursBlock = searchableRows.some(
    (r) => isDiningOperationHoursSectionLabel(r.section),
  );
  const needsRestaurantBlock =
    diningPathPasted ||
    needsDiningOperationHoursBlock ||
    searchableRows.some((r) => isRestaurantSectionLabel(r.section));
  const needsSpaBlock =
    spaPathPasted ||
    searchableRows.some((r) => isSpaSectionLabel(r.section));
  const needsPropertyHighlightBlock =
    searchableRows.some((r) => isPropertyHighlightSectionLabel(r.section));
  const needsPropertyOverviewSpecialBlock = searchableRows.some((r) => rowHasSpecialNote(r));
  const needsPropertySearchBlock =
    searchableRows.some((r) => isPropertySearchSectionLabel(r.section));
  const needsHotelMessageBannerBlock =
    searchableRows.some((r) => isHotelMessageBannerSectionLabel(r.section));
  const needsSpecialNoticeBlock =
    searchableRows.some((r) => isSpecialNoticeSectionLabel(r.section));
  // True when at least one of the 4 feature-category rows has a non-empty English source cell.
  // We still need `expectedFeatures` (the list for the selected language) to decide if we read the
  // page selector. Computed below after we know which language we are running for.
  const hasAnyFeatureRow = searchableRows.some(
    (r) => isFeatureSectionLabel(r.section),
  );
  // True when at least one Excel row is a Property Highlight TITLE row (e.g. "Property Highlight #1").
  // Description rows like "Property Highlight #1 Description" are intentionally NOT counted here —
  // they still flow through the existing paragraph-based comparison.
  const needsHighlightTitlesBlock = searchableRows.some((r) =>
    isPropertyHighlightTitleLabel(r.section),
  );

  /** @type {import('playwright').Browser | null} */
  let browser = null;

  /** @type {object[]} */
  const results = [];

  /** @type {string|null} */
  let specialNoticeMessage = null;

  /** @type {{ outlets: { name: string, hours: string }[] } | null} */
  let operationHours = null;

  /** @type {{ url: string|null, preview: string, characterCount: number, fetchedText: boolean, openedOverviewFirst: boolean, operationHours: { outlets: { name: string, hours: string }[] } | null, operationHoursPreview: string }} */
  const diningMeta = {
    url: needsRestaurantBlock ? buildDiningServicesUrl(pageUrl, lang) : null,
    preview: '',
    characterCount: 0,
    fetchedText: false,
    openedOverviewFirst: false,
    operationHours: null,
    operationHoursPreview: '',
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
      propertySearchMeta,
      propertyOverviewSpecialMeta,
      propertyHighlightMeta,
      messageBannerMeta,
      specialNoticeMessage,
      operationHours,
      hotelName,
    };
  }

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
    if (needsSpaBlock && !spaMeta.url) {
      spaMeta.url = buildSpaServicesUrl(firstNavUrl, lang);
    }
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
    // Hotel detail is client-rendered, but LHW often keeps analytics/network requests open.
    // Keep this short and let the section-specific waits below handle the exact content needed.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1000);
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
      await page.waitForTimeout(800);
      await page.locator('#main-content').first().scrollIntoViewIfNeeded().catch(() => {});
    }

    if (needsSpecialNoticeBlock) {
      try {
        const specialNoticeRaw = await readSpecialNoticeMessage(page);
        if (normalizeText(specialNoticeRaw)) {
          specialNoticeMessage = specialNoticeRaw;
          // eslint-disable-next-line no-console
          console.log('[Runner] Special notice found');
          // eslint-disable-next-line no-console
          console.log(`[Runner] specialNoticeMessage:\n${specialNoticeMessage}`);
        } else {
          specialNoticeMessage = null;
          // eslint-disable-next-line no-console
          console.log('[Runner] No special notice found');
        }
      } catch {
        specialNoticeMessage = null;
        // eslint-disable-next-line no-console
        console.log('[Runner] No special notice found');
      }
    } else {
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
      await page.waitForTimeout(600);
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
    if (needsRestaurantBlock) {
      const diningRes = await readDiningServicesBlock(page, firstNavUrl, lang);
      diningBlock = diningRes.block;
      operationHours = diningRes.operationHours;
      diningMeta.operationHours = operationHours;
      diningMeta.operationHoursPreview = formatOperationHoursForPreview(operationHours);
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
    }
    let spaBlock = '';
    let spaTitleForMeta = '';
    let spaDescriptionForMeta = '';
    if (needsSpaBlock) {
      const spaRes = await readSpaServicesBlock(page, firstNavUrl, lang);
      spaBlock = spaRes.block;
      spaTitleForMeta = spaRes.title;
      spaDescriptionForMeta = spaRes.description;

      spaMeta.title = spaTitleForMeta;
      spaMeta.titleFound = Boolean(normalizeText(spaTitleForMeta));
      spaMeta.descriptionFound = Boolean(normalizeText(spaDescriptionForMeta));
      spaMeta.descriptionLength = spaDescriptionForMeta.length;
      spaMeta.titlePreview = truncateForResultPreview(spaTitleForMeta, 500);
      spaMeta.descriptionPreview = truncateForResultPreview(spaDescriptionForMeta, 5000);

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
        '--- Combined text used for Excel substring checks (title + description + optional generic fallback) ---',
        truncateForResultPreview(norm || String(spaBlock).trim(), 4000),
      ].join('\n');
    }

    // eslint-disable-next-line no-console
    console.log(
      `[Runner] Comparing ${searchableRows.length} row(s) with English source content against the captured page text…`,
    );

    /** When Excel “Hours” rows lack Restaurant #N, assign outlets in sheet order. */
    let diningHoursRowSeq = 0;
    let currentDiningOutletName = '';

    for (const row of searchableRows) {
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
            note: match
              ? 'Strict-equality match (lowercase + whitespace collapsed) on the highlight h3.'
              : 'Excel title does not match the highlight h3 on the site after normalization.',
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
      const isRestRow = isRestaurantSectionLabel(section);
      const isSpaRow = isSpaSectionLabel(section);
      const isPHRow = isPropertyHighlightSectionLabel(section);
      const isPSRow = isPropertySearchSectionLabel(section);
      const isMsgRow = isHotelMessageBannerSectionLabel(section);
      const isSpecialNoticeRow = isSpecialNoticeSectionLabel(section);
      const isHoursRow = isDiningOperationHoursSectionLabel(section);
      if (
        isRestRow &&
        !isHoursRow &&
        /\bname\b/i.test(section) &&
        !/\bdescription\b/i.test(section) &&
        normalizeText(expected)
      ) {
        currentDiningOutletName = expected;
      }
      let hoursText = '';
      if (isHoursRow) {
        let hoursOrdinal = diningHoursOrdinalFromLabel(section);
        hoursText = pickOperationHoursText(operationHours, hoursOrdinal, section, currentDiningOutletName);
        if (!normalizeText(hoursText) && operationHours?.outlets?.length) {
          diningHoursRowSeq += 1;
          hoursOrdinal = diningHoursRowSeq;
          hoursText = pickOperationHoursText(operationHours, hoursOrdinal, section);
        }
      }
      const isLocRow = isLocalInformationSectionLabel(section);
      // If a label accidentally matches both, restaurant/dining wins so “Restaurant #1 Description”
      // still reads from the dining subpage, not the airport line.
      const useAirport =
        isLocRow &&
        !isRestRow &&
        !isSpaRow &&
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
      );
      const useDining =
        Boolean(diningBlock) &&
        !useAirport &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        (isRestRow || (diningPathPasted && !isSpaRow));
      const useSpa =
        Boolean(normalizeText(spaTextForRow)) &&
        !useAirport &&
        !useDining &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow &&
        !isSpecialNoticeRow &&
        !isHoursRow &&
        (isSpaRow || (spaPathPasted && !isRestRow));

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
        !useSpa &&
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
        !useSpa &&
        !usePS;

      const useMessageBanner =
        Boolean(normalizeText(hotelMessageBannerText)) &&
        isMsgRow &&
        !useAirport &&
        !useDining &&
        !useSpa &&
        !isPHRow &&
        !isPSRow &&
        !isSpecialNoticeRow;

      const useSpecialNotice =
        Boolean(normalizeText(specialNoticeMessage || '')) &&
        isSpecialNoticeRow &&
        !useAirport &&
        !useDining &&
        !useSpa &&
        !isPHRow &&
        !isPSRow &&
        !isMsgRow;

      const useOperationHours =
        Boolean(normalizeText(hoursText)) &&
        isHoursRow &&
        !useAirport &&
        !useDining &&
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
        !useSpa &&
        !usePH &&
        !useMessageBanner &&
        !useSpecialNotice &&
        !useOperationHours;

      let textForCompare = mainPageText;
      if (useAirport) {
        textForCompare = `${mainPageText}\n\n${airportBlock}`;
      } else if (useOperationHours) {
        textForCompare = hoursText;
      } else if (useDining) {
        textForCompare = diningBlock;
      } else if (useSpa) {
        textForCompare = spaTextForRow;
      } else if (useSpecialOverview) {
        textForCompare = propertyOverviewSpecialText;
      } else if (useMessageBanner) {
        textForCompare = hotelMessageBannerText;
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
        let actualPass;
        if (useSpecialOverview) {
          // Show the full captured overview block (not the tiny normalized substring from extractMatchingSnippet).
          actualPass = truncateForResultPreview(propertyOverviewSpecialText, 12_000);
        } else if (useMessageBanner) {
          actualPass = truncateForResultPreview(hotelMessageBannerText, 12_000);
        } else if (useSpecialNotice) {
          actualPass = truncateForResultPreview(specialNoticeMessage || '', 12_000);
        } else if (useOperationHours) {
          actualPass = truncateForResultPreview(hoursText, 12_000);
        } else if (useSpa && isSpaTitleSectionLabel(section)) {
          actualPass = truncateForResultPreview(
            spaTitleForMeta || spaTextForRow || snippet || expNorm,
            500,
          );
        } else if (useSpa) {
          actualPass = truncateForResultPreview(spaTextForRow, 12_000);
        } else if ((useDining || usePH || usePS) && (snippet || expNorm)) {
          actualPass = truncateForResultPreview(snippet || expNorm, 12_000);
        } else {
          actualPass = snippet || expNorm;
        }
        let passNote = '';
        if (useDining) {
          passNote = 'Match verified on the dining subpage (/services-amenities/dining).';
        } else if (useSpa && isSpaDescriptionSectionLabel(section)) {
          passNote =
            'Match verified in the spa description (`.spa-details` paragraphs on /services-amenities/spa).';
        } else if (useSpa && isSpaTitleSectionLabel(section)) {
          passNote =
            'Match verified in the spa title/name only (`h3#spa-list-title` on /services-amenities/spa).';
        } else if (useSpa) {
          passNote = 'Match verified on the spa subpage (/services-amenities/spa).';
        } else if (useSpecialOverview) {
          passNote =
            'Match verified in the property-overview block (column H special note; pinned selector).';
        } else if (useMessageBanner) {
          passNote =
            'Match verified in the overview message banner (`#main-content div.message`: title, paragraphs, and link text).';
        } else if (useSpecialNotice) {
          passNote =
            'Match verified in the special-notice block (`div.alert.alert-info.special-notice div.message`).';
        } else if (useOperationHours) {
          passNote =
            'Match verified in dining operation hours (`div.hours` on /services-amenities/dining).';
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
        const operationHoursHintRaw =
          isHoursRow && normalizeText(hoursText) ? normalizeText(hoursText) : '';
        const operationHoursHint = operationHoursHintRaw
          ? truncateForResultPreview(operationHoursHintRaw, 12_000)
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
        const specialNoticeHintRaw =
          isSpecialNoticeRow && normalizeText(specialNoticeMessage || '')
            ? normalizeText(specialNoticeMessage || '')
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
          isRestRow || (diningPathPasted && !isSpaRow && !useAirport && !isPHRow && !isPSRow);
        const wantsSpa =
          isSpaRow || (spaPathPasted && !isRestRow && !useAirport && !isPHRow && !isPSRow);
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
          !isPSRow;
        const wantsMessageBanner = isMsgRow && !useAirport && !isPSRow;
        const wantsSpecialNotice = isSpecialNoticeRow && !useAirport && !isPSRow;
        const wantsOperationHours = isHoursRow && !useAirport && !isPSRow;
        const psHintRaw = isPSRow && propertySearchDesc ? normalizeText(propertySearchDesc) : '';
        const psHint = psHintRaw ? truncateForResultPreview(psHintRaw) : '';
        const actualFallback =
          airportHint ||
          diningHint ||
          operationHoursHint ||
          spaHint ||
          specialHint ||
          messageHint ||
          specialNoticeHint ||
          phHint ||
          psHint;

        let failNote =
          'Expected text was not found in the main page text (Local Information line is only used when the Excel section label mentions Local Information / airport).';
        if (airportHint) {
          failNote =
            'Expected text not found. "Actual" is the Local Information airport line (p.airport).';
        } else if (diningHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the dining page (/services-amenities/dining).';
        } else if (operationHoursHint) {
          failNote =
            'Expected text not found. "Actual" is operation hours from `div.hours` on the dining page.';
        } else if (wantsOperationHours && !operationHoursHintRaw) {
          failNote =
            'Expected text not found, no matching `div.hours` for this row, or label missing Restaurant #N / outlet name (e.g. “CORI Table - Hours of Operation”).';
        } else if (spaHint) {
          failNote =
            'Expected text not found. "Actual" is visible copy from the spa page (/services-amenities/spa).';
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
          failNote =
            'Expected text not found. "Actual" is visible copy from the special-notice block (`motion.alert.alert-info.special-notice div.message`).';
        } else if (wantsSpecialNotice && !specialNoticeHintRaw) {
          failNote =
            'Expected text not found, or the special-notice block (`motion.alert.alert-info.special-notice div.message`) returned no text.';
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
      for (const { feature, sourceLabel, found } of comparison) {
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
            actualText: found ? FEATURE_STATUS.FOUND : FEATURE_STATUS.MISSING,
            status: found ? 'Passed' : 'Not Found',
            note: found
              ? 'Match verified inside the hotel-overview features block.'
              : 'Listed in the Excel features rows but not present in the actual features block on the site.',
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
    if (browser) {
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
      `[Runner] Finished. Passed=${counts.Passed || 0}, Not Found=${counts['Not Found'] || 0}, Skipped=${counts.Skipped || 0}, Failed=${counts.Failed || 0}`,
    );
  }

  return {
    results,
    diningMeta,
    spaMeta,
    propertySearchMeta,
    propertyOverviewSpecialMeta,
    propertyHighlightMeta,
    messageBannerMeta,
    specialNoticeMessage,
    operationHours,
    hotelName,
  };
}

module.exports = {
  runComparison,
  normalizeText,
  normalizeSectionLabel,
  readLocalInformationAirportText,
  readServicesAmenitiesBlock,
  readDiningServicesBlock,
  DINING_OPERATION_HOURS_SELECTOR,
  isDiningOperationHoursSectionLabel,
  diningHoursOrdinalFromLabel,
  pickOperationHoursText,
  isSpaDescriptionSectionLabel,
  isSpaTitleSectionLabel,
  pickSpaTextForRow,
  normalizeOperationHours,
  readDiningOperationHoursOnCurrentPage,
  formatOperationHoursForPreview,
  readSpaServicesBlock,
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
  readSpecialNoticeMessage,
  LOCAL_INFO_AIRPORT_SELECTOR_FULL,
  LOCAL_INFO_AIRPORT_SELECTOR_FALLBACK,
};
