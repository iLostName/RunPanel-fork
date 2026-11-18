/**
 * The activity log as a spreadsheet: how a value becomes a CSV cell.
 *
 * Two things go wrong with a naive `join(",")`. A detail with a comma, a quote
 * or a line break in it shifts every column after it (RFC 4180 quoting fixes
 * that). And a cell that starts with `=`, `+`, `-` or `@` is a formula to
 * Excel and LibreOffice: a project named `=HYPERLINK(...)`, or an IP address
 * someone typed into a form, would run when the file is opened by whoever
 * exports the log. Such a cell is written with a leading apostrophe, which the
 * spreadsheet shows as text (OWASP's advice for CSV injection; tab and carriage
 * return are on its list too).
 *
 * Zero imports: the unit suite loads this file directly.
 */

export type CsvSeparator = "," | ";";

/**
 * `;` is what a spreadsheet in Italian expects by default, because `,` is the
 * decimal separator there: a comma-separated file opened with a double click
 * lands in one column. `,` is the RFC's, for scripts and other tools.
 */
export const DEFAULT_SEPARATOR: CsvSeparator = ";";

/** Byte order mark: without it Excel reads UTF-8 as the local code page and "attività" arrives mangled. */
export const CSV_BOM = "﻿";

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined, separator: CsvSeparator = DEFAULT_SEPARATOR): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  const quote = text.includes('"') || text.includes(separator) || text.includes("\n") || text.includes("\r") || text !== text.trim();
  return quote ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record, CRLF-terminated as RFC 4180 says. */
export function csvLine(values: ReadonlyArray<string | number | null | undefined>, separator: CsvSeparator = DEFAULT_SEPARATOR): string {
  return `${values.map((value) => csvCell(value, separator)).join(separator)}\r\n`;
}

/**
 * `2026-11-18 10:04:59` in the panel's time zone: a form every spreadsheet
 * reads as a date and that sorts as text too. `sv-SE` is the locale that
 * writes exactly ISO's order with a space.
 */
export function localTimestamp(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return iso;
  }
}

/** The download's name: `registro-attivita-2026-11-18.csv`. */
export function exportFileName(now: Date = new Date()): string {
  return `registro-attivita-${now.toISOString().slice(0, 10)}.csv`;
}
