/**
 * Tiny shared text helpers.
 * Kept in its own module so any file (excel, playwrightRunner, propertySearch, …)
 * can import it without worrying about circular dependencies.
 */

/**
 * Normalize a piece of text before comparing it against another piece.
 *
 * - Strips BOM / zero-width characters that often appear after Excel paste/export.
 * - Replaces non-breaking spaces with regular spaces.
 * - Replaces curly / smart punctuation (quotes, dashes) with their ASCII equivalents.
 * - Collapses any run of whitespace (incl. newlines) into a single space.
 * - Trims leading / trailing whitespace.
 *
 * The goal is "the same visible text on the page and in Excel should compare equal".
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  let s = String(text || '');
  try {
    s = s.normalize('NFC');
  } catch {
    // ignore environments without String.prototype.normalize
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
 * Normalize a label cell from column A (trim + strip invisibles).
 * Lighter than `normalizeText` because we usually want to preserve internal punctuation.
 *
 * @param {string} label
 * @returns {string}
 */
function normalizeSectionLabel(label) {
  return String(label || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

module.exports = {
  normalizeText,
  normalizeSectionLabel,
};
