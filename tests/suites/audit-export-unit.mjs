import { createReporter } from "../harness.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The activity log leaves the panel as a CSV file, and is opened in a
 * spreadsheet by someone who trusts it.
 *
 * Every value in it was typed by somebody — a project name, a detail, an
 * address in a form — so a cell has to arrive as the text it was: quoted when
 * it holds the separator, a quote or a line break, and never as a formula. A
 * project called `=HYPERLINK("http://evil","clic")` must not become a link in
 * the operator's Excel.
 */
export const meta = { name: "audit-export-unit", needsDocker: false, drivers: [], standalone: true };

/** A minimal RFC 4180 reader, to check that what is written reads back. */
function parse(text, separator) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return rows;
}

export async function run({ repoRoot }) {
  const r = createReporter("audit-export-unit");
  const csv = await import(pathToFileURL(join(repoRoot, "lib", "audit-csv.ts")).href);

  // --- quoting -------------------------------------------------------------------
  r.check("a plain value is written as it is", csv.csvCell("Deploy", ";") === "Deploy");
  r.check("empty values are empty cells", csv.csvCell(null) === "" && csv.csvCell(undefined) === "" && csv.csvCell("") === "");
  r.check("the separator in a value quotes it", csv.csvCell("a;b", ";") === '"a;b"' && csv.csvCell("a,b", ",") === '"a,b"');
  r.check("the other separator does not", csv.csvCell("a,b", ";") === "a,b");
  r.check("a quote is doubled inside quotes", csv.csvCell('di "prova"', ";") === '"di ""prova"""');
  r.check("a line break is kept, quoted", csv.csvCell("riga 1\nriga 2", ";") === '"riga 1\nriga 2"');
  r.check("leading or trailing spaces are quoted so they survive", csv.csvCell(" x ", ";") === '" x "');
  r.check("numbers become text", csv.csvCell(42, ";") === "42");

  // --- formulas ------------------------------------------------------------------
  for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
    const cell = csv.csvCell(`${start}1+1`, ";");
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1) : cell;
    r.check(`a value starting with ${JSON.stringify(start)} is written as text`, unquoted.startsWith(`'${start}`), cell);
  }
  const link = csv.csvCell('=HYPERLINK("http://evil.example","clic")', ";");
  r.check("a formula with quotes is neutralised and still quoted", link === `"'=HYPERLINK(""http://evil.example"",""clic"")"`, link);
  r.check("a formula after the start is left alone", csv.csvCell("a=1", ";") === "a=1");

  // --- whole lines -------------------------------------------------------------------
  const line = csv.csvLine(["2026-11-18 10:00:00", "owner@example.com", "Deploy; riuscito", '=cmd|" /C calc"!A0', null], ";");
  r.check("a line ends with CRLF", line.endsWith("\r\n"));
  const back = parse(line, ";")[0];
  r.check("a line reads back cell for cell", back.length === 5 && back[2] === "Deploy; riuscito" && back[3] === `'=cmd|" /C calc"!A0` && back[4] === "", JSON.stringify(back));
  const comma = parse(csv.csvLine(["a,b", "c"], ","), ",")[0];
  r.check("the comma separator reads back too", comma.length === 2 && comma[0] === "a,b", JSON.stringify(comma));
  r.check("the default separator is the one Italian spreadsheets expect", csv.DEFAULT_SEPARATOR === ";");
  r.check("the file starts with a byte order mark for Excel", csv.CSV_BOM === "﻿");

  // --- dates -----------------------------------------------------------------------
  r.check("a time in the panel's zone reads as a spreadsheet date", csv.localTimestamp("2026-07-01T10:04:59.123Z", "Europe/Rome") === "2026-07-01 12:04:59", csv.localTimestamp("2026-07-01T10:04:59.123Z", "Europe/Rome"));
  r.check("UTC stays UTC", csv.localTimestamp("2026-01-01T00:00:00.000Z", "UTC") === "2026-01-01 00:00:00");
  r.check("midnight is 00, not 24", csv.localTimestamp("2026-01-01T23:00:00.000Z", "Europe/Rome") === "2026-01-02 00:00:00", csv.localTimestamp("2026-01-01T23:00:00.000Z", "Europe/Rome"));
  r.check("an unreadable time is passed through", csv.localTimestamp("garbage", "UTC") === "garbage");
  r.check("the file is named after the day", csv.exportFileName(new Date("2026-11-18T08:00:00Z")) === "registro-attivita-2026-11-18.csv");

  // --- the route ---------------------------------------------------------------------
  const route = readFileSync(join(repoRoot, "app", "api", "audit", "export", "route.ts"), "utf8");
  r.check("the export asks for the same permission as the log", /requirePermission\("audit\.view"\)/.test(route));
  r.check("and filters entry by entry for the reader", /exportAudit\(denied\.principal,/.test(route));
  r.check("every cell goes through the escaping", !/\.join\((";"|",")\)/.test(route) && /csvLine\(/.test(route));
  const exporter = readFileSync(join(repoRoot, "lib", "audit-export.ts"), "utf8");
  r.check("entries are checked with the log's own visibility rule", /canSeeEntry\(principal,/.test(exporter));
  r.check("pages are cut on time and id, so none falls between two", /eb\("audit_log\.id", "<", id\)/.test(exporter));

  return r.result();
}
