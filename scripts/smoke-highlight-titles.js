/**
 * Pure-logic smoke test for Property Highlight title detection + comparison.
 * No browser is launched.
 */

const { readContentSheet } = require('../lib/excel');
const {
  isPropertyHighlightTitleLabel,
  propertyHighlightTitleOrdinalFromLabel,
  compareHighlightTitle,
  normalizeHighlightText,
  HIGHLIGHT_TITLE_SELECTOR_FULL,
} = require('../lib/propertyHighlightTitles');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/smoke-highlight-titles.js <path-to-xlsx>');
  process.exit(1);
}

console.log('Selectors per ordinal:');
console.log('  #1 :', HIGHLIGHT_TITLE_SELECTOR_FULL[1]);
console.log('  #2 :', HIGHLIGHT_TITLE_SELECTOR_FULL[2]);
console.log('  #3 :', HIGHLIGHT_TITLE_SELECTOR_FULL[3]);
console.log('---');

console.log('isPropertyHighlightTitleLabel:');
[
  'Property Highlight #1',
  'Property Highlight #2',
  'Property Highlight #3',
  'Property Highlight #1 Description',
  'property highlight 1',
  '  Property Highlights #3  ',
  'Property Highlight #4',
  'Overview',
  '',
].forEach((s) => {
  const ok = isPropertyHighlightTitleLabel(s);
  const ord = propertyHighlightTitleOrdinalFromLabel(s);
  console.log(`  ${JSON.stringify(s).padEnd(40)} → title=${ok}, ordinal=${ord}`);
});
console.log('---');

console.log('compareHighlightTitle (lowercase + collapse whitespace, strict equal):');
const cases = [
  ['Spa', 'Spa'],
  ['Spa', 'SPA'],
  ['Spa', '  spa  '],
  ['Spa', 'spa\ntreatments'],
  ['Fine Dining', 'Fine Dining'],
  ['Fine Dining', 'Fine  Dining'],
  ['Location', 'Locations'],
  ['', 'Spa'],
];
for (const [a, b] of cases) {
  const r = compareHighlightTitle(a, b);
  console.log(
    `  expected=${JSON.stringify(a).padEnd(15)} actual=${JSON.stringify(b).padEnd(22)} → match=${r.match}`,
  );
}
console.log('---');

const rows = readContentSheet(file);
console.log(`Workbook rows: ${rows.length}`);
console.log('Title rows detected (with expected values per language):');
for (const row of rows) {
  if (!isPropertyHighlightTitleLabel(row.section)) {
    continue;
  }
  const ord = propertyHighlightTitleOrdinalFromLabel(row.section);
  console.log(
    `  #${ord}  label=${JSON.stringify(row.section)}  ENG=${JSON.stringify(row.byLang.ENG)}  GER=${JSON.stringify(row.byLang.GER)}`,
  );
}
