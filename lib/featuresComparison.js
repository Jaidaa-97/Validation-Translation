/**
 * Hotel "Features" comparison.
 *
 * What this module does:
 *   1. Picks the 4 feature rows from the uploaded Excel CONTENT sheet by their column-A label
 *      (Recreation & Health Complimentary / Additional Cost, General Features Complimentary /
 *      Additional cost — case-insensitive).
 *   2. For the language being tested, splits each cell by line breaks, trims, removes empties,
 *      de-duplicates, and merges everything into a single `expectedFeatures` array.
 *   3. Reads the actual features text from a dedicated selector on the hotel detail page:
 *        section.features.alt-bg.pb-5 → div.row → individual feature blocks.
 *   4. Compares each expected feature to the actual text and returns per-feature results
 *      (Found / Missing / Actual selector not found).
 *
 * Why a separate module:
 *   The existing per-row comparison treats each Excel cell as a single blob that must appear
 *   as a substring. That fails the whole row when one bullet on the site is reworded. Splitting
 *   by line breaks and comparing feature-by-feature gives you a much clearer "what's missing"
 *   view, which is what we want here.
 */

const { normalizeText } = require('./textNormalize');

/**
 * Exact column-A labels in the Excel `CONTENT` sheet that should be merged into the
 * single expected-features list. Matching is case-insensitive and whitespace-tolerant —
 * the workbook sometimes uses "Cost" vs "cost", or has trailing/leading spaces.
 */
const FEATURE_SECTION_LABELS = Object.freeze([
  'Recreation & Health Additional Cost',
  'Recreation & Health Complimentary',
  'General Features Additional cost',
  'General Features Complimentary',
]);

/**
 * Dedicated selector for the "Features" block on a hotel overview page.
 * Long form is what the user copied from DevTools.
 * Fallback is the same block addressed by its semantic classes — used if the long
 * chain breaks because LHW reshuffles a wrapper div.
 */
const ACTUAL_FEATURES_SELECTOR_FULL =
  '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.features.alt-bg.pb-5 > div > div.row > div > div';

const ACTUAL_FEATURES_SELECTOR_FALLBACK =
  '#main-content section.features .row > div > div';

/**
 * Status strings rendered into the "Actual" column of the results table.
 * Keep them centralized so a future translation/UI tweak only edits this object.
 */
const FEATURE_STATUS = Object.freeze({
  FOUND: 'Found on actual site',
  MISSING: 'Missing on actual site',
  SELECTOR_NOT_FOUND: 'Actual selector not found',
});

/**
 * Tiny logger for progress lines, mirroring [Property Search] / [Runner].
 * @param {string} message
 */
function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[Features] ${message}`);
}

/**
 * Returns true when the given column-A label is one of the 4 feature categories.
 * Comparison is case-insensitive and ignores extra whitespace.
 *
 * @param {string} label
 * @returns {boolean}
 */
function isFeatureSectionLabel(label) {
  const norm = normalizeText(label).toLowerCase();
  if (!norm) {
    return false;
  }
  return FEATURE_SECTION_LABELS.some(
    (target) => normalizeText(target).toLowerCase() === norm,
  );
}

/**
 * Normalize a single feature string before comparing it to the page text.
 *
 * - Lowercase (case-insensitive comparison).
 * - Collapse all whitespace (including line breaks) into single spaces.
 * - Trim.
 * - Strip BOM / zero-width chars (often present after Excel paste).
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeFeatureText(text) {
  return normalizeText(text).toLowerCase();
}

/**
 * Split one Excel cell into a list of individual features.
 *
 * Splits on newlines (Excel uses `\n` between bullets when you Alt+Enter inside a cell).
 * Trims each item, removes empty items, and dedupes within this single cell.
 *
 * @param {string} cellText
 * @returns {string[]}
 */
function splitFeatureCell(cellText) {
  const raw = String(cellText || '');
  if (!raw.trim()) {
    return [];
  }

  const parts = raw
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    const key = normalizeFeatureText(part);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(part);
  }
  return out;
}

/**
 * Build the merged `expectedFeatures` array for one language across all 4 feature rows.
 *
 * Returns an array of `{ feature, sourceLabel }` so the result table can still tell you
 * which Excel row a feature came from (handy when several rows mention "Wi-Fi", etc.).
 *
 * Globally dedupes case-insensitively so the same feature listed in two rows is not
 * compared twice.
 *
 * @param {{ section: string, byLang: Record<string, string>, specialNote?: string }[]} rows
 * @param {string} languageCode  ENG | GER | ITA | FRE | JAP | SPA
 * @returns {{ feature: string, sourceLabel: string }[]}
 */
function buildExpectedFeatures(rows, languageCode) {
  const lang = String(languageCode || '').trim().toUpperCase();
  const seen = new Set();
  /** @type {{ feature: string, sourceLabel: string }[]} */
  const out = [];

  for (const row of rows) {
    if (!isFeatureSectionLabel(row.section)) {
      continue;
    }
    const cell = row.byLang[lang] || '';
    const items = splitFeatureCell(cell);
    for (const item of items) {
      const key = normalizeFeatureText(item);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ feature: item, sourceLabel: row.section });
    }
  }
  return out;
}

/**
 * Read the actual features text from the hotel detail page.
 *
 * Strategy:
 *   1. Wait for `section.features` to attach (the page is client-rendered).
 *   2. Scroll it into view so lazy children render.
 *   3. Collect text from each leaf `div` inside the .row (one bullet per leaf), joined by newlines.
 *      We use the full user-supplied selector first, then the shorter fallback if the long chain
 *      doesn't match.
 *
 * Returns an empty string if the selector cannot be read at all — the caller will then mark
 * every expected feature as "Actual selector not found".
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readActualFeaturesText(page) {
  log('reading actual features block from the hotel overview page');

  await page
    .locator('section.features')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 })
    .catch(() => {});

  await page
    .locator('section.features')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});

  await page.waitForTimeout(500);

  for (const selector of [ACTUAL_FEATURES_SELECTOR_FULL, ACTUAL_FEATURES_SELECTOR_FALLBACK]) {
    try {
      const loc = page.locator(selector);
      const count = await loc.count();
      if (count === 0) {
        continue;
      }

      const items = await loc.evaluateAll((els) =>
        els
          .map((el) => {
            const txt = el.innerText || el.textContent || '';
            return String(txt).trim();
          })
          .filter((t) => t.length > 0),
      );

      const joined = items.join('\n').trim();
      if (joined) {
        log(`captured ${items.length} feature block(s), ${joined.length} chars total`);
        return joined;
      }
    } catch {
      // try the next selector
    }
  }

  log('actual features selector did not match anything on the page');
  return '';
}

/**
 * Compare each expected feature against the actual features text.
 *
 * Normalization (applied to BOTH sides before comparing):
 *   - lowercase
 *   - replace any run of whitespace (incl. line breaks) with a single space
 *   - trim
 *
 * A feature counts as present when its normalized form is a substring of the
 * normalized actual text. We do NOT require an exact equality match because LHW
 * sometimes adds extra qualifiers (e.g. "Wi-Fi" → "Wi-Fi (complimentary)").
 *
 * @param {{ feature: string, sourceLabel: string }[]} expectedFeatures
 * @param {string} actualText
 * @returns {{ feature: string, sourceLabel: string, found: boolean }[]}
 */
function compareFeatures(expectedFeatures, actualText) {
  const actualNorm = normalizeFeatureText(actualText);
  return expectedFeatures.map(({ feature, sourceLabel }) => {
    const featureNorm = normalizeFeatureText(feature);
    const found = featureNorm.length > 0 && actualNorm.includes(featureNorm);
    return { feature, sourceLabel, found };
  });
}

module.exports = {
  FEATURE_SECTION_LABELS,
  ACTUAL_FEATURES_SELECTOR_FULL,
  ACTUAL_FEATURES_SELECTOR_FALLBACK,
  FEATURE_STATUS,
  isFeatureSectionLabel,
  normalizeFeatureText,
  splitFeatureCell,
  buildExpectedFeatures,
  readActualFeaturesText,
  compareFeatures,
};
