// Reading and writing CSV files, keeping the file's byte order mark and line endings.

export function parseCsv(text) {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const rows = [];
  let row = [""];
  let quoted = false;
  for (let i = bom.length; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        row[row.length - 1] += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        row[row.length - 1] += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push("");
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      rows.push(row);
      row = [""];
    } else {
      row[row.length - 1] += char;
    }
  }
  if (row.length > 1 || row[0] !== "") rows.push(row);
  const nonEmpty = rows.filter((cells) => cells.length > 1 || cells[0].trim() !== "");
  const header = (nonEmpty.shift() ?? []).map((column) => column.trim());
  const records = nonEmpty.map((cells) => Object.fromEntries(header.map((column, i) => [column, unguard(cells[i] ?? "")])));
  return { header, records, bom, newline };
}

export function stringifyCsv({ header, records, bom = "", newline = "\n" }) {
  const lines = [header.map(toCsvField), ...records.map((record) => header.map((column) => toCsvField(record[column] ?? "")))];
  return bom + lines.map((cells) => cells.join(",")).join(newline) + newline;
}

export function toCsvField(value) {
  value = String(value);
  // Stop spreadsheet apps from treating the value as a formula.
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// Undoes toCsvField's formula guard, so rewriting the file doesn't add a second apostrophe.
function unguard(value) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
