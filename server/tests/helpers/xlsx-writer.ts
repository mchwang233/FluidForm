// Writing a one-sheet .xlsx for tests (what the Python tests make with openpyxl): text as shared
// strings, numbers as numbers, Dates as serial days in a date style.
import { zipOf } from "./zip-writer.js";

export type Value = string | number | Date | null;

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const letters = (index: number) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const serial = (when: Date) => {
  const days = (when.getTime() - Date.UTC(1899, 11, 31)) / 86_400_000;
  return days >= 60 ? days + 1 : days;
};

export function workbookOf(sheet: string, rows: Value[][]): Buffer {
  const strings: string[] = [];
  const index = (text: string) => (strings.includes(text) ? strings.indexOf(text) : strings.push(text) - 1);
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const ref = `${letters(c)}${r + 1}`;
    if (value === null) return "";
    if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
    if (value instanceof Date) return `<c r="${ref}" s="1"><v>${serial(value)}</v></c>`;
    return `<c r="${ref}" t="s"><v>${index(value)}</v></c>`;
  }).join("")}</row>`).join("");
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return zipOf([
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: "xl/workbook.xml", data: `<?xml version="1.0"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="${escape(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`, deflate: true },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: `<?xml version="1.0"?><worksheet ${ns}><sheetData>${body}</sheetData></worksheet>`, deflate: true },
    { name: "xl/sharedStrings.xml", data: `<?xml version="1.0"?><sst ${ns}>${strings.map((text) => `<si><t>${escape(text)}</t></si>`).join("")}</sst>`, deflate: true },
    { name: "xl/styles.xml", data: `<?xml version="1.0"?><styleSheet ${ns}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>` },
  ]);
}
