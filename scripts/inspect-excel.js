const X = require('xlsx');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/inspect-excel.js <path-to-xlsx>');
  process.exit(1);
}

const wb = X.readFile(file);
console.log('File:', path.resolve(file));
console.log('Sheets:', wb.SheetNames);

const s = wb.Sheets['CONTENT'];
if (!s) {
  console.log('No CONTENT sheet.');
  process.exit(0);
}

const rows = X.utils.sheet_to_json(s, { header: 1, defval: '', raw: false });
console.log('Total rows:', rows.length);

console.log('\nFirst 25 rows (columns A-H):');
rows.slice(0, 25).forEach((r, i) => {
  console.log(String(i).padStart(3), JSON.stringify(r.slice(0, 8)));
});

console.log('\nRows containing "property" or "search":');
rows.forEach((r, i) => {
  const joined = r.map((c) => String(c || '')).join(' || ').toLowerCase();
  if (joined.includes('property') || joined.includes('search')) {
    console.log(String(i).padStart(3), JSON.stringify(r.slice(0, 8)));
  }
});
