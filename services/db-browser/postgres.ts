import { execArgs, type ServiceTarget } from "@/lib/service-exec";
import { cleanPgError, cutCell, parseCsv, parseJsonArray, parseTextRow } from "@/lib/db-browser/output";
import { guardQuery } from "@/lib/db-browser/sql-guard";
import {
  FULL_VALUE_LIMIT,
  MAX_TABLES,
  PAGE_SIZE,
  PG_TABLES_SQL,
  PG_TYPES_MARK,
  cellLimit,
  pgAddressable,
  pgCellSql,
  pgDescribeSql,
  pgPreviewSql,
  pgQueryRowsSql,
  pgTableMetaSql,
  pgTypesSql,
} from "@/lib/db-browser/sql-build";
import type {
  BrowseCell,
  BrowseCellValue,
  BrowseColumn,
  BrowseQueryResult,
  BrowseTableKind,
  BrowseTablePage,
  BrowseTables,
} from "@/lib/db-browser/types";
import { runInContainer } from "./exec";
import { BrowseError, missingClient, runFailure } from "./errors";

/**
 * PostgreSQL, through `psql` in its own container — the client the console
 * already uses, and the one way in that works whatever the port, the access
 * restriction or the network the panel itself runs on.
 *
 * Read-only on three levels, any one of which would refuse a write:
 *  - `default_transaction_read_only`, set for the whole session at connection
 *    time through PGOPTIONS, before any statement runs;
 *  - `BEGIN READ ONLY` around the statements;
 *  - for what someone typed, `guardQuery` and the wrapper, which make it a
 *    single SELECT with the browser's LIMIT.
 *
 * Each statement travels as its own `-c`, which psql sends to the server as
 * it is: a `-c` that does not start with a backslash is never read for psql's
 * own commands (`\!`, `\o`, `\gexec`), which a script on stdin would be.
 * PGOPTIONS also sets the time limits, and `standard_conforming_strings`,
 * which `sql-guard.ts` and `pgLiteral` rely on.
 */

const STATEMENT_MS = 10_000;
const DESCRIBE_MS = 5_000;
const LOCK_MS = 3_000;
/** Extra time the process gets past the statement's, to bring back the engine's own message. */
const GRACE_MS = 5_000;

const PAGE_BYTES = 8 * 1024 * 1024;
const SMALL_BYTES = 2 * 1024 * 1024;
/** Rows of a SHOW or an EXPLAIN shown at most. */
const DIRECT_ROWS = 1000;

/** psql prints a NULL as this in the one format with no JSON around it: SHOW and EXPLAIN. */
const NULL_MARK = "\\N";

interface PsqlRun {
  records: string[][];
  elapsedMs: number;
}

async function psql(
  target: ServiceTarget,
  database: string,
  statements: string[],
  opts: { header: boolean; statementMs: number; maxBytes: number }
): Promise<PsqlRun> {
  const env = {
    PGPASSWORD: target.credentials.password,
    PGCLIENTENCODING: "UTF8",
    PGAPPNAME: "runpanel-browser",
    PGOPTIONS: [
      "-c default_transaction_read_only=on",
      `-c statement_timeout=${opts.statementMs}`,
      `-c lock_timeout=${LOCK_MS}`,
      "-c standard_conforming_strings=on",
    ].join(" "),
  };
  const args = [
    ...execArgs(target, env),
    "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "--csv",
    "-P", "pager=off", "-P", `null=${NULL_MARK}`,
    ...(opts.header ? [] : ["-t"]),
    "-U", target.credentials.user, "-d", database,
    "-c", "BEGIN READ ONLY",
    ...statements.flatMap((statement) => ["-c", statement]),
    "-c", "ROLLBACK",
  ];
  const run = await runInContainer(args, { env, timeoutMs: opts.statementMs + GRACE_MS, maxBytes: opts.maxBytes });
  if (missingClient(run)) throw new BrowseError("psql non è disponibile nel container del database.", 501);
  if (run.code !== 0 || run.timedOut || run.overflow) {
    throw runFailure(run, cleanPgError(run.stderr), Math.round(opts.statementMs / 1000));
  }
  const csv = parseCsv(run.stdout.toString("utf8"));
  if (!csv.complete) throw new BrowseError("La risposta del database è arrivata incompleta.", 502);
  return { records: csv.records, elapsedMs: run.elapsedMs };
}

const KINDS: Record<string, BrowseTableKind> = {
  r: "table",
  p: "partitioned",
  v: "view",
  m: "materialized",
  f: "foreign",
};

export async function pgTables(target: ServiceTarget, database: string): Promise<BrowseTables> {
  const { records } = await psql(target, database, [PG_TABLES_SQL], { header: false, statementMs: STATEMENT_MS, maxBytes: SMALL_BYTES });
  const tables = records.flatMap((record) => {
    const row = parseJsonArray(record[0] ?? "");
    if (!row || typeof row[0] !== "string" || typeof row[1] !== "string") return [];
    const kind = KINDS[String(row[2])] ?? "table";
    const estimate = typeof row[3] === "number" && row[3] >= 0 && kind !== "view" ? row[3] : null;
    const bytes = typeof row[4] === "number" && kind !== "view" && kind !== "foreign" ? row[4] : null;
    return [{ schema: row[0], name: row[1], kind, rowsEstimate: estimate, bytes }];
  });
  return { tables: tables.slice(0, MAX_TABLES), truncated: tables.length > MAX_TABLES };
}

interface PgTableMeta {
  relkind: string;
  columns: BrowseColumn[];
}

async function tableMeta(target: ServiceTarget, database: string, schema: string, table: string): Promise<PgTableMeta> {
  const { records } = await psql(target, database, pgTableMetaSql(schema, table), {
    header: false,
    statementMs: DESCRIBE_MS,
    maxBytes: SMALL_BYTES,
  });
  let relkind: string | null = null;
  const columns: BrowseColumn[] = [];
  for (const record of records) {
    const row = parseJsonArray(record[0] ?? "");
    if (!row) continue;
    if (row[0] === "t") relkind = String(row[2]);
    else if (row[0] === "c" && typeof row[1] === "string") {
      columns.push({ name: row[1], type: typeof row[2] === "string" ? row[2] : null, key: typeof row[3] === "number" ? row[3] : null });
    }
  }
  if (relkind === null) throw new BrowseError("Tabella non trovata: potrebbe essere stata eliminata o rinominata.", 404);
  return { relkind, columns };
}

function cutRows(rows: BrowseCell[][], limit: number): { rows: BrowseCell[][]; cut: [number, number][] } {
  const cut: [number, number][] = [];
  const out = rows.map((row, r) =>
    row.map((value, c) => {
      const result = cutCell(value, limit);
      if (result.cut) cut.push([r, c]);
      return result.value;
    })
  );
  return { rows: out, cut };
}

export async function pgTablePage(
  target: ServiceTarget,
  database: string,
  schema: string,
  table: string,
  offset: number
): Promise<BrowseTablePage> {
  const meta = await tableMeta(target, database, schema, table);
  const limit = cellLimit(meta.columns.length);
  const addressable = pgAddressable(meta.relkind);
  const key = meta.columns
    .filter((column) => typeof column.key === "number")
    .sort((a, b) => (a.key ?? 0) - (b.key ?? 0))
    .map((column) => column.name);
  const sql = pgPreviewSql({ schema, table, columns: meta.columns.map((c) => c.name), key, addressable, offset, limit });
  const run = await psql(target, database, [sql], { header: false, statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });

  const raw: BrowseCell[][] = [];
  const rowKeys: string[] = [];
  for (const record of run.records.slice(0, PAGE_SIZE)) {
    const row = parseTextRow(record[0] ?? "");
    if (!row) throw new BrowseError("La risposta del database non è leggibile.", 502);
    if (addressable) rowKeys.push(row.pop() ?? "");
    raw.push(row);
  }
  const { rows, cut } = cutRows(raw, limit);
  return {
    table: { schema, name: table, kind: KINDS[meta.relkind] ?? "table" },
    columns: meta.columns,
    rows,
    cut,
    cellLimit: limit,
    rowKeys: addressable ? rowKeys : null,
    offset,
    hasMore: run.records.length > PAGE_SIZE,
    elapsedMs: run.elapsedMs,
  };
}

export async function pgCell(
  target: ServiceTarget,
  database: string,
  schema: string,
  table: string,
  column: string,
  rowKey: string
): Promise<BrowseCellValue> {
  const sql = pgCellSql(schema, table, column, rowKey);
  if (!sql) throw new BrowseError("Riga non valida: ricarica l'anteprima.", 400);
  const { records } = await psql(target, database, [sql], { header: false, statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });
  const row = records.length ? parseTextRow(records[0][0] ?? "") : null;
  if (!row) {
    // A row that was updated has moved: its old address now points nowhere.
    throw new BrowseError("La riga non è più dov'era: è stata modificata o eliminata. Ricarica l'anteprima.", 404);
  }
  const { value, cut } = cutCell(row[0] ?? null, FULL_VALUE_LIMIT);
  return { value, truncated: cut, limit: FULL_VALUE_LIMIT };
}

export async function pgQuery(target: ServiceTarget, database: string, text: string, offset: number): Promise<BrowseQueryResult> {
  const guard = guardQuery(text, "postgresql");
  if (!guard.ok) throw new BrowseError(guard.reason, 400);

  if (guard.mode === "direct") {
    const run = await psql(target, database, [guard.sql], { header: true, statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });
    const [header = [], ...records] = run.records;
    const columns = header.map((name) => ({ name, type: null }));
    const limit = cellLimit(columns.length);
    const raw = records.slice(0, DIRECT_ROWS).map((record) => record.map((value) => (value === NULL_MARK ? null : value)));
    const { rows, cut } = cutRows(raw, limit);
    return { mode: "direct", columns, rows, cut, cellLimit: limit, offset: 0, hasMore: records.length > DIRECT_ROWS, elapsedMs: run.elapsedMs };
  }

  const described = await psql(target, database, [pgDescribeSql(guard.sql)], {
    header: true,
    statementMs: DESCRIBE_MS,
    maxBytes: SMALL_BYTES,
  });
  const names = described.records[0] ?? [];
  // No column at all prints an empty header line. PostgreSQL has no column
  // with an empty name, so this cannot be one column called "".
  if (names.length === 0 || (names.length === 1 && names[0] === "")) {
    return { mode: "rows", columns: [], rows: [], cut: [], cellLimit: 0, offset, hasMore: false, elapsedMs: described.elapsedMs };
  }

  const limit = cellLimit(names.length);
  const fetched = await psql(
    target,
    database,
    [pgTypesSql(guard.sql, names.length), pgQueryRowsSql(guard.sql, names.length, offset, limit)],
    { header: false, statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES }
  );
  let records = fetched.records;
  let types: BrowseCell[] = [];
  const first = records.length ? parseTextRow(records[0][0] ?? "") : null;
  if (first && first[0] === PG_TYPES_MARK) {
    types = first.slice(1);
    records = records.slice(1);
  }

  const raw: BrowseCell[][] = [];
  for (const record of records.slice(0, PAGE_SIZE)) {
    const row = parseTextRow(record[0] ?? "");
    if (!row) throw new BrowseError("La risposta del database non è leggibile.", 502);
    raw.push(row);
  }
  const { rows, cut } = cutRows(raw, limit);
  return {
    mode: "rows",
    columns: names.map((name, i) => ({ name, type: types[i] ?? null })),
    rows,
    cut,
    cellLimit: limit,
    offset,
    hasMore: records.length > PAGE_SIZE,
    elapsedMs: described.elapsedMs + fetched.elapsedMs,
  };
}
