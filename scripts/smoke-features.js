/**
 * Quick local check for the new features comparison.
 * Does NOT launch Playwright — only exercises the pure helpers against a real workbook.
 */

const { readContentSheet } = require('../lib/excel');
const {
  isFeatureSectionLabel,
  buildExpectedFeatures,
  compareFeatures,
  splitFeatureCell,
  normalizeFeatureText,
} = require('../lib/featuresComparison');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/smoke-features.js <path-to-xlsx>');
  process.exit(1);
}

console.log('File:', file);
console.log('---');

console.log('isFeatureSectionLabel checks:');
[
  'General Features Complimentary',
  'general features complimentary',
  '  Recreation & Health Additional Cost  ',
  'Overview',
  'Restaurant #1 Description',
].forEach((s) => console.log(`  ${JSON.stringify(s)} → ${isFeatureSectionLabel(s)}`));
console.log('---');

console.log('splitFeatureCell("Wi-Fi\\nMinibar\\n\\nWi-Fi"):',
  splitFeatureCell('Wi-Fi\nMinibar\n\nWi-Fi'));
console.log('---');

const rows = readContentSheet(file);
console.log(`Loaded ${rows.length} content row(s).`);

for (const lang of ['ENG', 'GER']) {
  console.log(`\n=== Expected features for ${lang} ===`);
  const expected = buildExpectedFeatures(rows, lang);
  console.log(`Total: ${expected.length}`);
  expected.forEach((e, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. [${e.sourceLabel}] ${e.feature}`,
    );
  });
}

console.log('\n--- compareFeatures vs fake actualText ---');
const expectedEng = buildExpectedFeatures(rows, 'ENG');
const fakeActual = [
  'Concierge service',
  "Children's program",
  'Beach',
  'Wi-Fi',
  'Minibar',
  'Tea and coffee in the room',
  'Spa / Wellness / Longevity',
  'Swimming Pool',
  'Restaurant, Terraces and Bar',
].join('\n');
const cmp = compareFeatures(expectedEng, fakeActual);
console.log(`actualText length: ${fakeActual.length}, normalized = "${normalizeFeatureText(fakeActual).slice(0, 80)}…"`);
const found = cmp.filter((c) => c.found);
const missing = cmp.filter((c) => !c.found);
console.log(`Found  : ${found.length}`);
console.log(`Missing: ${missing.length}`);
missing.forEach((m) => console.log(`   - MISSING [${m.sourceLabel}] ${m.feature}`));
