/**
 * The SQL the data browser sends, built where it can be read and tested.
 *
 * Every statement here is a read, and every one that carries a name or a value
 * from the request quotes it as the engine requires: PostgreSQL identifiers in
 * double quotes, its strings with doubled apostrophes (the session forces
 * `standard_conforming_strings`, so a backslash is a backslash); MySQL
 * identifiers in backticks and its values as hex literals, which mean the same
 * thing in every `sql_mode`. What the person typed in the query box is never
 * quoted — it went through `sql-guard.ts` and is wrapped whole.
 *
 * Every value comes back as text and cut at a length the browser chose, in the
 * engine, before it is sent: a 200 MB blob in a row costs the engine a
 * `left()` and costs the panel two thousand characters. The length depends on
 * how many columns the page has, so a wide table and a narrow one weigh about
 * the same — see `cellLimit`.
 *
 * Zero imports: the unit suite loads this file directly.
 */

/** Rows per page, for tables and queries alike. */
export const PAGE_SIZE = 50;

/** Characters of values a page may carry, spread over its cells. */
const PAGE_BUDGET = 1_500_000;
const MIN_CELL = 40;
const MAX_CELL = 10_000;

/** A single value asked for on its own: "mostra tutto". */
export const FULL_VALUE_LIMIT = 1_048_576;

/** Tables listed at most; the rest are still there for a query. */
export const MAX_TABLES = 2000;

/** Characters per value for a page of `columns` columns. */
export function cellLimit(columns: number): number {
  const per = Math.floor(PAGE_BUDGET / (PAGE_SIZE * Math.max(1, columns)));
  return Math.max(MIN_CELL, Math.min(MAX_CELL, per));
}

/** One row more than the page, to know whether another page exists. */
function limitClause(offset: number): string {
  return `LIMIT ${PAGE_SIZE + 1} OFFSET ${Math.max(0, Math.floor(offset))}`;
}

function utf8Hex(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) out += byte.toString(16).padStart(2, "0");
  return out;
}

// --- PostgreSQL ------------------------------------------------------------------

export function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Only with `standard_conforming_strings` on, which the browser's session forces. */
export function pgLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Where a row of a table lives, to ask for one of its values again: `<tableoid>:(page,item)`. */
export const PG_ROW_KEY = /^(\d{1,10}):(\(\d{1,10},\d{1,5}\))$/;

/** Every relation a person would call a table, outside the system schemas. */
export const PG_TABLES_SQL = [
  "SELECT json_build_array(n.nspname, c.relname, c.relkind::text, c.reltuples::bigint,",
  "  c.relpages::bigint * current_setting('block_size')::bigint)",
  "FROM pg_catalog.pg_class c",
  "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
  "WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')",
  "  AND NOT c.relispartition",
  "  AND n.nspname <> 'information_schema'",
  "  AND n.nspname NOT LIKE 'pg\\_%'",
  "ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname",
  `LIMIT ${MAX_TABLES + 1}`,
].join("\n");

/**
 * The table and its columns, in two results told apart by their first
 * element: `["t", oid, relkind]` once, then `["c", name, type, keyPosition]`.
 */
export function pgTableMetaSql(schema: string, table: string): string[] {
  const where = `n.nspname = ${pgLiteral(schema)} AND c.relname = ${pgLiteral(table)}`;
  return [
    [
      "SELECT json_build_array('t', c.oid::bigint, c.relkind::text)",
      "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
      `WHERE ${where}`,
    ].join("\n"),
    [
      "SELECT json_build_array('c', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),",
      "  array_position(i.indkey::int2[], a.attnum))",
      "FROM pg_catalog.pg_attribute a",
      "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid",
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
      "LEFT JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisprimary",
      `WHERE ${where} AND a.attnum > 0 AND NOT a.attisdropped`,
      "ORDER BY a.attnum",
    ].join("\n"),
  ];
}

/** Relations whose rows have a `ctid` a value can be fetched by. */
export function pgAddressable(relkind: string): boolean {
  return relkind === "r" || relkind === "p" || relkind === "m";
}

export interface PgPreviewPlan {
  schema: string;
  table: string;
  columns: string[];
  /** Primary key columns, in key order. */
  key: string[];
  addressable: boolean;
  offset: number;
  limit: number;
}

/**
 * A page of a table: one JSON array of text per row, the row's address last
 * when it has one. Ordered by the primary key when there is one, so a page is
 * the same page twice; a table without one comes in the order it is stored.
 */
export function pgPreviewSql(plan: PgPreviewPlan): string {
  const values = plan.columns.map((column) => `left(rp_t.${pgIdent(column)}::text, ${plan.limit + 1})`);
  if (plan.addressable) values.push("rp_t.tableoid::text || ':' || rp_t.ctid::text");
  const order = plan.key.length ? `ORDER BY ${plan.key.map((column) => `rp_t.${pgIdent(column)}`).join(", ")}\n` : "";
  return (
    `SELECT array_to_json(ARRAY[${values.join(", ")}]::text[])\n` +
    `FROM ${pgIdent(plan.schema)}.${pgIdent(plan.table)} AS rp_t\n` +
    `${order}${limitClause(plan.offset)}`
  );
}

export function pgCellSql(schema: string, table: string, column: string, rowKey: string): string | null {
  const match = PG_ROW_KEY.exec(rowKey);
  if (!match) return null;
  return (
    `SELECT array_to_json(ARRAY[left(rp_t.${pgIdent(column)}::text, ${FULL_VALUE_LIMIT + 1})]::text[])\n` +
    `FROM ${pgIdent(schema)}.${pgIdent(table)} AS rp_t\n` +
    `WHERE rp_t.tableoid = ${match[1]} AND rp_t.ctid = ${pgLiteral(match[2])}::tid`
  );
}

/**
 * The query's columns, from its header alone: no row is fetched. The query is
 * on lines of its own so that a trailing `--` comment ends before the wrapper.
 */
export function pgDescribeSql(query: string): string {
  return `SELECT * FROM (\n${query}\n) AS rp_q LIMIT 0`;
}

function positional(count: number): string {
  return Array.from({ length: count }, (_, i) => `c${i + 1}`).join(", ");
}

/** First element of the types row, so it cannot be taken for a row of data. */
export const PG_TYPES_MARK = "rp:types";

/**
 * The column types, as one row even when the query has none: the query with
 * no rows, joined to a single row of its own.
 */
export function pgTypesSql(query: string, count: number): string {
  const types = Array.from({ length: count }, (_, i) => `pg_catalog.pg_typeof(rp_q.c${i + 1})::text`);
  return (
    `SELECT array_to_json(ARRAY[${[pgLiteral(PG_TYPES_MARK), ...types].join(", ")}]::text[])\n` +
    `FROM (SELECT * FROM (\n${query}\n) AS rp_i LIMIT 0) AS rp_q(${positional(count)})\n` +
    "RIGHT JOIN (VALUES (1)) AS rp_d(x) ON true"
  );
}

/**
 * The rows, by position: the column list renames them `c1…cN`, so two columns
 * with the same name, or one with no name, are still two columns.
 */
export function pgQueryRowsSql(query: string, count: number, offset: number, limit: number): string {
  const values = Array.from({ length: count }, (_, i) => `left(rp_q.c${i + 1}::text, ${limit + 1})`);
  return (
    `SELECT array_to_json(ARRAY[${values.join(", ")}]::text[])\n` +
    `FROM (\n${query}\n) AS rp_q(${positional(count)})\n` +
    limitClause(offset)
  );
}

// --- MySQL ---------------------------------------------------------------------------

export function myIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

/** A string value, as hex: no quote and no backslash for any `sql_mode` to read. */
export function myText(value: string): string {
  return `CONVERT(X'${utf8Hex(value)}' USING utf8mb4) COLLATE utf8mb4_bin`;
}

/** Bytes, for a binary column: `hex` is what the browser received. */
export function myBytes(hex: string): string | null {
  return /^(?:[0-9a-fA-F]{2})*$/.test(hex) ? `X'${hex}'` : null;
}

/**
 * The session around every statement: read-only twice — for the session, so
 * that nothing after an implicit commit is writable either, and for the
 * transaction — and a time limit for reads and for locks.
 */
export function mysqlScript(statements: string[], timeoutMs: number): string {
  return [
    "SET SESSION TRANSACTION READ ONLY;",
    `SET SESSION max_execution_time = ${Math.floor(timeoutMs)};`,
    "SET SESSION lock_wait_timeout = 5;",
    "SET SESSION innodb_lock_wait_timeout = 5;",
    "START TRANSACTION READ ONLY;",
    ...statements,
    "ROLLBACK;",
    "",
  ].join("\n");
}

/**
 * A statement that reaches the server as hex and is parsed there, once.
 *
 * Two things at once. The mysql client never reads it, so a name with a
 * backslash or a quote in it cannot change where the client thinks a statement
 * ends. And PREPARE takes exactly one statement: a second one hidden in the
 * text is a syntax error in the server, not a second statement.
 */
export function mysqlPrepared(sql: string): string {
  return [
    `SET @rp_q = CONVERT(X'${utf8Hex(sql)}' USING utf8mb4);`,
    "PREPARE rp_s FROM @rp_q;",
    "EXECUTE rp_s;",
    "DEALLOCATE PREPARE rp_s;",
  ].join("\n");
}

/** The statement as typed, for SHOW, EXPLAIN and DESCRIBE, which cannot be prepared. */
export function mysqlDirect(sql: string): string {
  // On its own line: a trailing `#` or `--` comment ends before the semicolon.
  return `${sql}\n;`;
}

export const MYSQL_TABLES_SQL = [
  // Fresh estimates on 8.0 and later, which otherwise cache them for a day: a
  // table loaded this morning would read as empty. Inside a statement that
  // still sets something on 5.7, where an empty one would be an error.
  "SET SESSION /*!80000 information_schema_stats_expiry = 0, */ lock_wait_timeout = 5;",
  "SELECT JSON_ARRAY(TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH)",
  "FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  `ORDER BY TABLE_NAME LIMIT ${MAX_TABLES + 1};`,
].join("\n");

/** `[name, columnType, dataType, keyPosition, tableType]` per column. */
export function mysqlTableMetaSql(table: string): string {
  return [
    "SELECT JSON_ARRAY(c.COLUMN_NAME, c.COLUMN_TYPE, c.DATA_TYPE, s.SEQ_IN_INDEX, t.TABLE_TYPE)",
    "FROM information_schema.COLUMNS c",
    "JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME",
    "LEFT JOIN information_schema.STATISTICS s ON s.TABLE_SCHEMA = c.TABLE_SCHEMA AND s.TABLE_NAME = c.TABLE_NAME",
    "  AND s.COLUMN_NAME = c.COLUMN_NAME AND s.INDEX_NAME = 'PRIMARY'",
    `WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ${myText(table)}`,
    "ORDER BY c.ORDINAL_POSITION",
  ].join("\n");
}

/** How MySQL stores a column, as far as showing it is concerned. */
export type MyValueKind = "text" | "binary" | "bit" | "geometry" | "vector";

const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob"]);
const GEOMETRY_TYPES = new Set([
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
  "geomcollection",
]);

/** From `information_schema.COLUMNS.DATA_TYPE`. */
export function myKindOfDataType(dataType: string): MyValueKind {
  const type = dataType.toLowerCase();
  if (BINARY_TYPES.has(type)) return "binary";
  if (type === "bit") return "bit";
  if (GEOMETRY_TYPES.has(type)) return "geometry";
  if (type === "vector") return "vector";
  return "text";
}

/** Binary values travel as `0x…`: each byte is two characters. */
export function binaryByteLimit(limit: number): number {
  return Math.max(1, Math.floor((limit - 2) / 2));
}

/** One value as text, cut at `limit` characters (`limit` + 1 are fetched, to know). */
export function myValueExpr(ref: string, kind: MyValueKind, limit: number): string {
  switch (kind) {
    case "binary":
      return `IF(${ref} IS NULL, NULL, CONCAT('0x', HEX(LEFT(${ref}, ${binaryByteLimit(limit) + 1}))))`;
    case "bit":
      return `IF(${ref} IS NULL, NULL, CONCAT('b''', BIN(${ref} + 0), ''''))`;
    case "geometry":
      return `LEFT(ST_AsText(${ref}), ${limit + 1})`;
    case "vector":
      return `LEFT(VECTOR_TO_STRING(${ref}), ${limit + 1})`;
    default:
      return `LEFT(CAST(${ref} AS CHAR), ${limit + 1})`;
  }
}

/** A key column whole, to find its row again: hex for bytes, text otherwise. */
function myKeyExpr(ref: string, kind: MyValueKind): string {
  return kind === "binary" ? `HEX(${ref})` : `CAST(${ref} AS CHAR)`;
}

export interface MyColumnPlan {
  name: string;
  kind: MyValueKind;
}

export interface MyPreviewPlan {
  table: string;
  columns: MyColumnPlan[];
  /** Primary key columns, in key order. Empty when the table has none. */
  key: MyColumnPlan[];
  offset: number;
  limit: number;
  timeoutMs: number;
}

/** The optimizer hint holds even if the session's limit were changed. */
function myHint(timeoutMs: number): string {
  return `/*+ MAX_EXECUTION_TIME(${Math.floor(timeoutMs)}) */`;
}

export function myPreviewSql(plan: MyPreviewPlan): string {
  const values = plan.columns.map((column) => myValueExpr(myIdent(column.name), column.kind, plan.limit));
  for (const column of plan.key) values.push(myKeyExpr(myIdent(column.name), column.kind));
  const order = plan.key.length ? ` ORDER BY ${plan.key.map((column) => myIdent(column.name)).join(", ")}` : "";
  return `SELECT ${myHint(plan.timeoutMs)} JSON_ARRAY(${values.join(", ")}) FROM ${myIdent(plan.table)}${order} ${limitClause(plan.offset)}`;
}

/**
 * One value, found again by its primary key. Null when the key handed back is
 * not the one the page was given.
 */
export function myCellSql(
  table: string,
  column: MyColumnPlan,
  key: MyColumnPlan[],
  values: unknown,
  timeoutMs: number
): string | null {
  if (!Array.isArray(values) || values.length !== key.length || key.length === 0) return null;
  const conditions: string[] = [];
  for (let i = 0; i < key.length; i++) {
    const value = values[i];
    if (typeof value !== "string") return null;
    const literal = key[i].kind === "binary" ? myBytes(value) : myText(value);
    if (!literal) return null;
    conditions.push(`${myIdent(key[i].name)} = ${literal}`);
  }
  const expr = myValueExpr(myIdent(column.name), column.kind, FULL_VALUE_LIMIT);
  return `SELECT ${myHint(timeoutMs)} JSON_ARRAY(${expr}) FROM ${myIdent(table)} WHERE ${conditions.join(" AND ")} LIMIT 1`;
}

export function myDescribeSql(query: string): string {
  return `SELECT * FROM (\n${query}\n) AS rp_q LIMIT 0`;
}

export function myQueryRowsSql(query: string, columns: MyColumnPlan[], offset: number, limit: number, timeoutMs: number): string {
  const values = columns.map((column) => myValueExpr(`rp_q.${myIdent(column.name)}`, column.kind, limit));
  return `SELECT ${myHint(timeoutMs)} JSON_ARRAY(${values.join(", ")}) FROM (\n${query}\n) AS rp_q ${limitClause(offset)}`;
}
