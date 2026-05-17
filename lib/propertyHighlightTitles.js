/**
 * Property Highlight TITLE comparison (the short `h3` titles only).
 *
 * What this module does:
 *   - Detects Excel rows whose column A is exactly "Property Highlight #1" / "#2" / "#3"
 *     (case-insensitive, ignores extra whitespace) but NOT "… Description".
 *   - Reads the matching `h3` title from the hotel detail page using three pinned selectors
 *     (one per ordinal), with a couple of softer fallbacks in case LHW reshuffles a wrapper div.
 *   - Compares normalized expected vs normalized actual:
 *       lowercase + collapse whitespace + ignore line breaks → strict equality.
 *   - Returns per-row results that the runner can drop straight into the table.
 *
 * Why a separate module:
 *   The existing "Property Highlight … Description" rows already use a paragraph-based
 *   comparison via `readPropertyHighlightSegments`. The title rows need a different
 *   selector (h3 instead of nearby `p`), a different normalization (strict equality, not
 *   substring), and a different "Failed" semantics on mismatch. Keeping them in their
 *   own module avoids tangling those two flows.
 */

const { normalizeText } = require('./textNormalize');

/**
 * Pinned full selectors copied from DevTools. One per ordinal (1, 2, 3).
 */
const HIGHLIGHT_TITLE_SELECTOR_FULL = Object.freeze({
  1:
    '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.property-highlights.alt-bg.pb-5 > div.container.d-none.d-md-block > div:nth-child(3) > div > div:nth-child(1) > h3',
  2:
    '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.property-highlights.alt-bg.pb-5 > div.container.d-none.d-md-block > div:nth-child(3) > div > div:nth-child(2) > h3',
  3:
    '#main-content > div.page.hotel-detail.hotel-overview > div.sticky-nav-page-wrapper.js-stickybit-parent > div.tab-page-content > div.alt-bg-list > section.property-highlights.alt-bg.pb-5 > div.container.d-none.d-md-block > div:nth-child(3) > div > div:nth-child(3) > h3',
});

/**
 * Shorter fallback that drops the `div:nth-child(3)` row index — useful if LHW adds /
 * removes an unrelated wrapper above the highlights row.
 */
const HIGHLIGHT_TITLE_SELECTOR_FALLBACK = Object.freeze({
  1:
    'section.property-highlights.alt-bg .container.d-none.d-md-block div > div:nth-child(1) > h3',
  2:
    'section.property-highlights.alt-bg .container.d-none.d-md-block div > div:nth-child(2) > h3',
  3:
    'section.property-highlights.alt-bg .container.d-none.d-md-block div > div:nth-child(3) > h3',
});

/**
 * Softest fallback — picks the Nth `h3` directly under `section.property-highlights`.
 * Last resort if both pinned chains break.
 */
const HIGHLIGHT_TITLE_SELECTOR_LOOSE = Object.freeze({
  1: 'section.property-highlights h3:nth-of-type(1)',
  2: 'section.property-highlights h3:nth-of-type(2)',
  3: 'section.property-highlights h3:nth-of-type(3)',
});

const SUPPORTED_ORDINALS = Object.freeze([1, 2, 3]);

/**
 * Tiny progress logger so title work shows up alongside the other [Tag] lines.
 * @param {string} message
 */
function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[Property Highlight Titles] ${message}`);
}

/**
 * Does this Excel column-A label look like a Property Highlight TITLE row?
 *
 * - Matches "Property Highlight #1", "property highlight 2", "  Property Highlights #3  ".
 * - REJECTS "Property Highlight #N Description" (those are handled by the existing flow).
 * - Only accepts ordinals 1, 2, 3 — the LHW page exposes exactly three highlight tiles.
 *
 * @param {string} label
 * @returns {boolean}
 */
function isPropertyHighlightTitleLabel(label) {
  const s = normalizeText(label);
  if (!s) {
    return false;
  }
  if (/description/i.test(s)) {
    return false;
  }
  return /^property\s*highlights?\s*#?\s*[123]\b\s*$/i.test(s);
}

/**
 * Extract the ordinal (1, 2, or 3) from a title label.
 * Returns 0 if the label is not a recognised title row.
 *
 * @param {string} label
 * @returns {0|1|2|3}
 */
function propertyHighlightTitleOrdinalFromLabel(label) {
  if (!isPropertyHighlightTitleLabel(label)) {
    return 0;
  }
  const s = normalizeText(label);
  const m = s.match(/property\s*highlights?\s*#?\s*([123])\b/i);
  if (!m) {
    return 0;
  }
  const n = parseInt(m[1], 10);
  return /** @type {0|1|2|3} */ (SUPPORTED_ORDINALS.includes(n) ? n : 0);
}

/**
 * Normalize a title for comparison:
 * lowercase + collapse all whitespace (incl. line breaks) into single spaces + trim.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeHighlightText(text) {
  return normalizeText(text).toLowerCase();
}

/**
 * LHW highlight titles can render their visual tile number in the h3 text
 * (for example, "1 / BUTLER"). Keep only the title copy for comparison/display.
 *
 * @param {string} text
 * @returns {string}
 */
function stripHighlightOrdinalPrefix(text) {
  return String(text || '').replace(/^\s*[123]\s*\/\s*/, '').trim();
}

/**
 * Compare expected (Excel) vs actual (h3) titles with the rules from the spec.
 *
 * Strict equality after normalization — substring matching would let "Spa" pass
 * against the page text "Spa Treatments", which the spec does not want for titles.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {{ match: boolean, normalizedExpected: string, normalizedActual: string }}
 */
function compareHighlightTitle(expected, actual) {
  const normalizedExpected = normalizeHighlightText(expected);
  const normalizedActual = normalizeHighlightText(actual);
  return {
    match: normalizedExpected.length > 0 && normalizedExpected === normalizedActual,
    normalizedExpected,
    normalizedActual,
  };
}

/**
 * Try the pinned selector first, then the shorter fallback, then the loosest one.
 * Returns the trimmed text, or '' if every selector fails to match anything visible.
 *
 * @param {import('playwright').Page} page
 * @param {1|2|3} ordinal
 * @returns {Promise<string>}
 */
async function readPropertyHighlightTitleByOrdinal(page, ordinal) {
  const selectors = [
    HIGHLIGHT_TITLE_SELECTOR_FULL[ordinal],
    HIGHLIGHT_TITLE_SELECTOR_FALLBACK[ordinal],
    HIGHLIGHT_TITLE_SELECTOR_LOOSE[ordinal],
  ].filter(Boolean);

  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) {
        continue;
      }
      await loc.scrollIntoViewIfNeeded().catch(() => {});

      let text = await loc.innerText({ timeout: 8_000 }).catch(() => '');
      if (!normalizeText(text)) {
        text = await loc
          .evaluate((el) => (el && el.textContent ? el.textContent : ''))
          .catch(() => '');
      }
      if (normalizeText(text)) {
        return stripHighlightOrdinalPrefix(text);
      }
    } catch {
      // Try the next selector. Whatever the error, we just want best-effort capture.
    }
  }
  return '';
}

/**
 * Pre-fetch all 3 highlight titles in one go so the per-row loop can do constant-time
 * lookups instead of querying the DOM three times.
 *
 * - Waits for `section.property-highlights` to attach (the page is client-rendered).
 * - Scrolls it into view so lazy children render.
 * - Reads each ordinal independently — one missing tile does not stop the others.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Record<1|2|3, string>>}
 */
async function readAllPropertyHighlightTitles(page) {
  log('Reading the three h3 titles from section.property-highlights …');

  await page
    .locator('section.property-highlights')
    .first()
    .waitFor({ state: 'attached', timeout: 30_000 })
    .catch(() => {});

  await page
    .locator('section.property-highlights')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});

  await page.waitForTimeout(500);

  /** @type {Record<1|2|3, string>} */
  const titles = { 1: '', 2: '', 3: '' };

  for (const ordinal of SUPPORTED_ORDINALS) {
    try {
      const title = await readPropertyHighlightTitleByOrdinal(page, ordinal);
      titles[/** @type {1|2|3} */ (ordinal)] = title;
      log(`#${ordinal} → ${title ? JSON.stringify(title) : '(selector not found)'}`);
    } catch (err) {
      // Continue with the remaining ordinals — never let one bad tile abort the rest.
      const message = err instanceof Error ? err.message : String(err);
      log(`#${ordinal} threw: ${message}`);
      titles[/** @type {1|2|3} */ (ordinal)] = '';
    }
  }

  return titles;
}

module.exports = {
  HIGHLIGHT_TITLE_SELECTOR_FULL,
  HIGHLIGHT_TITLE_SELECTOR_FALLBACK,
  HIGHLIGHT_TITLE_SELECTOR_LOOSE,
  SUPPORTED_ORDINALS,
  isPropertyHighlightTitleLabel,
  propertyHighlightTitleOrdinalFromLabel,
  normalizeHighlightText,
  stripHighlightOrdinalPrefix,
  compareHighlightTitle,
  readPropertyHighlightTitleByOrdinal,
  readAllPropertyHighlightTitles,
};
