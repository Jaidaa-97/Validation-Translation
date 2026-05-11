const XLSX = require('xlsx');
const fs = require('fs');

/**
 * Column indices for sheet CONTENT (0-based):
 * A=0 label, B=1 ENG, C=2 GER, D=3 ITA, E=4 FRE, F=5 JAP, G=6 SPA
 */
const COL = {
  LABEL: 0,
  ENG: 1,
  GER: 2,
  ITA: 3,
  FRE: 4,
  JAP: 5,
  SPA: 6,
};

/** @type {Record<string, number>} */
const LANG_TO_COL = {
  ENG: COL.ENG,
  GER: COL.GER,
  ITA: COL.ITA,
  FRE: COL.FRE,
  JAP: COL.JAP,
  SPA: COL.SPA,
};

/**
 * Read the CONTENT sheet from an .xlsx file and return data rows.
 * Skips a header row when column B looks like "ENG".
 *
 * @param {string} filePath Absolute path to the workbook
 * @returns {{ section: string, byLang: Record<string, string> }[]}
 */
function readContentSheet(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Excel file not found: ${filePath}`);
  }

  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets['CONTENT'];
  if (!sheet) {
    throw new Error('Missing sheet named "CONTENT". Check the Excel file.');
  }

  /** @type {any[][]} */
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  let start = 0;
  const first = rows[0] || [];
  const b0 = String(first[COL.ENG] || '')
    .trim()
    .toUpperCase();
  if (b0 === 'ENG' || b0 === 'ENGLISH') {
    start = 1;
  }

  /** @type {{ section: string, byLang: Record<string, string> }[]} */
  const out = [];

  for (let i = start; i < rows.length; i++) {
    const row = rows[i] || [];
    const section = String(row[COL.LABEL] || '').trim();
    if (!section) {
      continue;
    }

    const byLang = {};
    for (const code of Object.keys(LANG_TO_COL)) {
      const colIdx = LANG_TO_COL[code];
      byLang[code] = String(row[colIdx] ?? '').trim();
    }

    out.push({ section, byLang });
  }

  return out;
}

module.exports = {
  readContentSheet,
  LANG_TO_COL,
};
