/**
 * Reading what the engine clients print.
 *
 * Each client is asked for a format that says where a value ends no matter
 * what is in it, because the values are the owner's data and contain
 * everything: tabs, newlines, quotes, `NULL` spelled as a word, emoji.
 *
 *  - psql: `--csv`, with every row reduced by the query to one JSON array of
 *    text. CSV quoting carries the newlines; JSON keeps NULL apart from the
 *    string "NULL", which CSV alone does not.
 *  - mysql: `--batch`, whose escapes (`\t`, `\n`, `\\`, `\0`) are undone here,
 *    with rows again reduced to one JSON array; `--column-type-info` for the
 *    names and types of a query's columns; `--xml` for SHOW and EXPLAIN, the
 *    only one of its formats that marks a NULL as such.
 *
 * Zero imports: the unit suite loads this file directly.
 */

import type { BrowseCell } from "./types";

export interface CsvResult {
  records: string[][];
  /** False when the text ended inside a quoted field: it was cut. */
  complete: boolean;
}

/** RFC 4180, as psql writes it: `""` inside quotes, `\n` between records. */
export function parseCsv(text: string): CsvResult {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field) {
    record.push(field);
    records.push(record);
  }
  return { records, complete: !quoted };
}

/** A JSON array, or null when the text is not one. */
export function parseJsonArray(text: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** A row the query reduced to an array of text: every element a string or null. */
export function parseTextRow(text: string): BrowseCell[] | null {
  const values = parseJsonArray(text);
  if (!values) return null;
  const row: BrowseCell[] = [];
  for (const value of values) {
    if (value === null || typeof value === "string") row.push(value);
    else if (typeof value === "number" || typeof value === "boolean") row.push(String(value));
    else return null;
  }
  return row;
}

/** Undoes `mysql --batch`: `\0`, `\b`, `\n`, `\r`, `\t`, `\Z` and `\\`. */
export function unescapeMysqlBatch(field: string): string {
  if (!field.includes("\\")) return field;
  let out = "";
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    if (c !== "\\" || i + 1 >= field.length) {
      out += c;
      continue;
    }
    const next = field[++i];
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "0") out += "\u0000";
    else if (next === "b") out += "\b";
    else if (next === "Z") out += "\u001a";
    else out += next;
  }
  return out;
}

/** The lines of `mysql --batch --skip-column-names`, one row each, unescaped. */
export function mysqlBatchLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0)
    .map(unescapeMysqlBatch);
}

export interface MysqlField {
  name: string;
  /** The protocol's name: `LONG`, `VAR_STRING`, `BLOB`, `NEWDECIMAL`… */
  type: string;
  /** 63 is `binary`: bytes, not text. */
  charsetnr: number;
  flags: string[];
}

/** What `mysql --column-type-info` prints before a result. */
export function parseMysqlFieldTypes(text: string): MysqlField[] {
  const fields: MysqlField[] = [];
  let current: MysqlField | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const head = /^Field\s+\d+:\s+`(.*)`\s*$/.exec(line);
    if (head) {
      current = { name: head[1], type: "", charsetnr: 0, flags: [] };
      fields.push(current);
      continue;
    }
    if (!current) continue;
    const type = /^Type:\s+(\S+)/.exec(line);
    if (type) {
      current.type = type[1];
      continue;
    }
    const collation = /^Collation:\s+.*\((\d+)\)\s*$/.exec(line);
    if (collation) {
      current.charsetnr = Number(collation[1]);
      continue;
    }
    const flags = /^Flags:\s*(.*)$/.exec(line);
    if (flags) current.flags = flags[1].split(/\s+/).filter(Boolean);
  }
  return fields;
}

const STRING_TYPES = new Set(["STRING", "VAR_STRING", "VARCHAR", "TINY_BLOB", "MEDIUM_BLOB", "LONG_BLOB", "BLOB"]);

/** How a query's column has to be read, from its protocol type. */
export function mysqlFieldKind(field: MysqlField): "text" | "binary" | "bit" | "geometry" | "vector" {
  if (field.type === "BIT") return "bit";
  if (field.type === "GEOMETRY") return "geometry";
  if (field.type === "VECTOR") return "vector";
  if (STRING_TYPES.has(field.type) && field.charsetnr === 63) return "binary";
  return "text";
}

const MYSQL_TYPE_NAMES: Record<string, string> = {
  DECIMAL: "decimal",
  NEWDECIMAL: "decimal",
  TINY: "tinyint",
  SHORT: "smallint",
  LONG: "int",
  INT24: "mediumint",
  LONGLONG: "bigint",
  FLOAT: "float",
  DOUBLE: "double",
  NULL: "null",
  TIMESTAMP: "timestamp",
  TIMESTAMP2: "timestamp",
  DATE: "date",
  NEWDATE: "date",
  TIME: "time",
  TIME2: "time",
  DATETIME: "datetime",
  DATETIME2: "datetime",
  YEAR: "year",
  BIT: "bit",
  JSON: "json",
  ENUM: "enum",
  SET: "set",
  GEOMETRY: "geometry",
  VECTOR: "vector",
};

/** A name a person recognises, for a query's column header. */
export function mysqlFieldTypeName(field: MysqlField): string {
  if (field.flags.includes("ENUM")) return "enum";
  if (field.flags.includes("SET")) return "set";
  const binary = field.charsetnr === 63;
  switch (field.type) {
    case "STRING":
      return binary ? "binary" : "char";
    case "VAR_STRING":
    case "VARCHAR":
      return binary ? "varbinary" : "varchar";
    case "TINY_BLOB":
    case "MEDIUM_BLOB":
    case "LONG_BLOB":
    case "BLOB":
      return binary ? "blob" : "text";
    default:
      return MYSQL_TYPE_NAMES[field.type] ?? field.type.toLowerCase();
  }
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export interface XmlResult {
  columns: string[];
  rows: BrowseCell[][];
}

const FIELD_OPEN = '<field name="';
const NIL = ' xsi:nil="true" />';

/**
 * What `mysql --xml` prints. The client escapes `<`, `>`, `&` and `"` in names
 * and values and nothing else, so a value runs exactly to the next `</field>`;
 * a NULL is an element with `xsi:nil`. A result with no rows names no columns.
 */
export function parseMysqlXml(text: string): XmlResult {
  const rows: BrowseCell[][] = [];
  let columns: string[] | null = null;
  let at = text.indexOf("<row>");
  while (at >= 0) {
    const end = text.indexOf("</row>", at);
    if (end < 0) break;
    const body = text.slice(at + 5, end);
    const names: string[] = [];
    const values: BrowseCell[] = [];
    let field = body.indexOf(FIELD_OPEN);
    while (field >= 0) {
      const nameStart = field + FIELD_OPEN.length;
      const nameEnd = body.indexOf('"', nameStart);
      if (nameEnd < 0) break;
      names.push(decodeXml(body.slice(nameStart, nameEnd)));
      if (body.startsWith(NIL, nameEnd + 1)) {
        values.push(null);
        field = body.indexOf(FIELD_OPEN, nameEnd + 1 + NIL.length);
      } else if (body[nameEnd + 1] === ">") {
        const close = body.indexOf("</field>", nameEnd + 2);
        if (close < 0) break;
        values.push(decodeXml(body.slice(nameEnd + 2, close)));
        field = body.indexOf(FIELD_OPEN, close);
      } else break;
    }
    if (!columns) columns = names;
    rows.push(values);
    at = text.indexOf("<row>", end);
  }
  return { columns: columns ?? [], rows };
}

/** Characters, as the engine counts them: a code point, not a UTF-16 unit. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const previous = text.charCodeAt(i - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) continue;
    }
    count++;
  }
  return count;
}

function sliceCodePoints(text: string, limit: number): string {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
    if (count === limit) return text.slice(0, i);
    count++;
    if (pair) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) i++;
    }
  }
  return text;
}

/**
 * A value the engine was asked for at `limit + 1` characters: whether it is
 * longer than `limit`, and the part to show.
 */
export function cutCell(value: BrowseCell, limit: number): { value: BrowseCell; cut: boolean } {
  if (value === null || value.length <= limit) return { value, cut: false };
  if (codePointLength(value) <= limit) return { value, cut: false };
  return { value: sliceCodePoints(value, limit), cut: true };
}

/** The same for a binary value written as `0x` and two hex digits per byte. */
export function cutHexCell(value: BrowseCell, byteLimit: number): { value: BrowseCell; cut: boolean } {
  if (value === null || !value.startsWith("0x")) return { value, cut: false };
  const max = 2 + byteLimit * 2;
  return value.length > max ? { value: value.slice(0, max), cut: true } : { value, cut: false };
}

/**
 * The part of psql's stderr a person should read: the message, its DETAIL and
 * HINT. `LINE n:` and the caret point into the browser's wrapper rather than
 * into what was typed, so they are dropped.
 */
export function cleanPgError(stderr: string): string {
  const kept: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(/^psql:[^:]*:\d+:\s*/, "");
    if (!line.trim()) continue;
    if (/^LINE \d+:/.test(line) || /^\s*\^\s*$/.test(line) || /^\s{2,}\S/.test(line)) continue;
    if (/^(QUERY|CONTEXT|STATEMENT):/.test(line)) continue;
    kept.push(line.replace(/^(psql: )?(error: )?/, "").replace(/^(ERROR|FATAL):\s+/, "").trim());
  }
  return kept.join("\n");
}

/** mysql's: `ERROR 1146 (42S02) at line 8: Table 'app.x' doesn't exist`, without the line. */
export function cleanMysqlError(stderr: string): string {
  const kept: string[] = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || /^mysql: \[Warning\]/.test(line)) continue;
    kept.push(line.replace(/^ERROR (\d+) \(([0-9A-Z]+)\)(?: at line \d+)?:\s*/, "$1 ($2): "));
  }
  return kept.join("\n");
}

/** The engine's own words turned into the panel's, where there is something to add. */
export function explainEngineError(message: string): string | null {
  const text = message.toLowerCase();
  if (text.includes("statement timeout") || text.includes("maximum statement execution time exceeded") || text.includes("operation exceeded time limit")) {
    return "La lettura ha superato il tempo massimo ed è stata interrotta. Restringi la query, per esempio con un WHERE.";
  }
  if (text.includes("lock timeout") || text.includes("lock wait timeout")) {
    return "La tabella è bloccata da un'altra operazione in corso: riprova tra poco.";
  }
  if (text.includes("read-only transaction") || text.includes("read only transaction")) {
    return "Il browser è in sola lettura e il database ha rifiutato una scrittura. Per modificare i dati usa la console.";
  }
  if (text.includes("duplicate column name")) {
    return "Due colonne della query hanno lo stesso nome: dai a una delle due un nome diverso con AS.";
  }
  if (text.includes("not supported in the prepared statement protocol")) {
    return "MySQL non permette di eseguire questa istruzione dal browser: usa la console.";
  }
  if (
    text.includes("password authentication failed") ||
    text.includes("access denied for user") ||
    text.includes("authentication failed") ||
    text.includes("noauth") ||
    text.includes("wrongpass")
  ) {
    return "Le credenziali salvate nel pannello non aprono più il database: sono state cambiate fuori dal pannello?";
  }
  return null;
}

/** `INFO keyspace`: `db0:keys=12,expires=1,avg_ttl=0`. */
export function parseRedisKeyspace(info: string): { index: number; keys: number; expires: number }[] {
  const out: { index: number; keys: number; expires: number }[] = [];
  for (const match of info.matchAll(/^db(\d+):keys=(\d+),expires=(\d+)/gm)) {
    out.push({ index: Number(match[1]), keys: Number(match[2]), expires: Number(match[3]) });
  }
  return out;
}
