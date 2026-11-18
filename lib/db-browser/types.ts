/**
 * What the data browser hands the page, engine by engine.
 *
 * Types only, shared by the route, the engine code under `services/db-browser`
 * and the `Browse*` components on the database page. Every value arrives as
 * text: a bigint, a numeric or a timestamp parsed into a JavaScript number or
 * Date on the way would come back as something the database never said.
 */

/** One value as the browser shows it. `null` is SQL NULL, not an empty string. */
export type BrowseCell = string | null;

export interface BrowseColumn {
  name: string;
  /** The engine's own spelling: `integer`, `varchar(255)`. Null when it did not say. */
  type: string | null;
  /** Position in the primary key, from 1. Rows are ordered by it. */
  key?: number | null;
}

export type BrowseTableKind = "table" | "partitioned" | "view" | "materialized" | "foreign" | "system";

export interface BrowseTable {
  /** The PostgreSQL schema. Null for MySQL, where the database is the schema. */
  schema: string | null;
  name: string;
  kind: BrowseTableKind;
  /** The engine's estimate, which is not a count. Null when it has none yet. */
  rowsEstimate: number | null;
  /** On disk, as of the engine's last look. Null when unknown. */
  bytes: number | null;
}

export interface BrowseTables {
  tables: BrowseTable[];
  /** More tables than the list carries: the rest are still reachable from a query. */
  truncated: boolean;
}

/** A page of rows, from a table or from a query. */
export interface BrowseRows {
  columns: BrowseColumn[];
  rows: BrowseCell[][];
  /** `[row, column]` of every value cut at `cellLimit` characters. */
  cut: [number, number][];
  cellLimit: number;
  offset: number;
  /** There is at least one row after these. */
  hasMore: boolean;
  /** Time spent waiting for the engine, in milliseconds. */
  elapsedMs: number;
}

export interface BrowseTablePage extends BrowseRows {
  table: { schema: string | null; name: string; kind: BrowseTableKind };
  /**
   * Per row, what to ask for one of its values in full with. Null when the
   * table cannot address a row: a view, or a MySQL table with no primary key.
   */
  rowKeys: string[] | null;
}

export interface BrowseQueryResult extends BrowseRows {
  /** `rows` for a SELECT the browser wrapped, `direct` for SHOW, EXPLAIN, DESCRIBE. */
  mode: "rows" | "direct";
}

export interface BrowseCellValue {
  value: BrowseCell;
  /** Still cut, at `limit` characters. */
  truncated: boolean;
  limit: number;
}

// --- Redis ---------------------------------------------------------------------

/** A byte string as it can be shown, and as it can be asked for again. */
export interface BrowseBytes {
  /** Readable text; bytes that are not UTF-8 are written as `\xHH`. */
  text: string;
  /** The exact bytes, base64. */
  raw: string;
  /** The bytes were not text. */
  binary: boolean;
  /** Bytes the value really has, when more than the ones sent. */
  length?: number;
}

export interface RedisKeyspaceEntry {
  index: number;
  keys: number;
  expires: number;
}

export interface RedisKeyItem {
  key: BrowseBytes;
  type: string;
  /** Milliseconds left, -1 for no expiry, -2 for gone in the meantime. */
  ttlMs: number;
  /** Bytes for a string, members for everything else. Null when unknown. */
  size: number | null;
}

export interface RedisKeyPage {
  cursor: string;
  /** The scan went round the whole keyspace. */
  done: boolean;
  keys: RedisKeyItem[];
  /** Keys in the database, matching or not. */
  dbSize: number;
  /** Roughly how many keys the scan looked at for this page. */
  examined: number;
}

export type RedisValue =
  | { kind: "string"; value: BrowseBytes }
  | { kind: "list" | "set"; items: BrowseBytes[] }
  | { kind: "zset"; items: { member: BrowseBytes; score: string }[] }
  | { kind: "hash"; items: { field: BrowseBytes; value: BrowseBytes }[] }
  | { kind: "stream"; items: { id: string; fields: { field: BrowseBytes; value: BrowseBytes }[] }[] }
  | { kind: "none" }
  | { kind: "other" };

export interface RedisKeyDetail {
  key: BrowseBytes;
  type: string;
  ttlMs: number;
  size: number | null;
  value: RedisValue;
  /** Items shown, when the key has more. */
  shown: number;
  /** Bytes a single value is cut at. */
  limit: number;
}

// --- MongoDB -------------------------------------------------------------------

export interface MongoCollection {
  name: string;
  /** `collection`, `view`, `timeseries`. */
  type: string;
  /** From the collection's metadata, not a count. */
  count: number | null;
}

export interface MongoDocument {
  /** `_id` as Extended JSON, to ask for the whole document with. */
  id: string | null;
  /** The document as relaxed Extended JSON, on one line. */
  json: string;
  truncated: boolean;
}

export interface MongoDocumentPage {
  docs: MongoDocument[];
  offset: number;
  hasMore: boolean;
  /** Characters a document is cut at in the list. */
  limit: number;
  elapsedMs: number;
}

export interface MongoDocumentFull {
  json: string | null;
  truncated: boolean;
  limit: number;
}
