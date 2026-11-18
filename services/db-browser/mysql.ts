import { execArgs, type ServiceTarget } from "@/lib/service-exec";
import {
  cleanMysqlError,
  cutCell,
  cutHexCell,
  mysqlBatchLines,
  mysqlFieldKind,
  mysqlFieldTypeName,
  parseJsonArray,
  parseMysqlFieldTypes,
  parseMysqlXml,
  parseTextRow,
} from "@/lib/db-browser/output";
import { guardQuery } from "@/lib/db-browser/sql-guard";
import {
  FULL_VALUE_LIMIT,
  MAX_TABLES,
  MYSQL_TABLES_SQL,
  PAGE_SIZE,
  binaryByteLimit,
  cellLimit,
  myCellSql,
  myDescribeSql,
  myKindOfDataType,
  myPreviewSql,
  myQueryRowsSql,
  mysqlTableMetaSql,
  mysqlDirect,
  mysqlPrepared,
  mysqlScript,
  type MyColumnPlan,
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
 * MySQL, through the `mysql` client in its own container, as `root` â€” the
 * identity the panel's database operations and the console already use.
 *
 * The script goes in on stdin, and everything in it that carries a name or a
 * typed query reaches the server as a hex literal through PREPARE: the client
 * never reads it, so it cannot see a statement end or a client command where
 * the server would not, and PREPARE parses exactly one statement. Only SHOW,
 * EXPLAIN and DESCRIBE, which cannot be prepared, are sent as typed, after
 * `guardQuery` has refused any backslash and any second statement in them.
 * `--binary-mode` turns the client's own commands off besides.
 *
 * Read-only twice in the server: `SET SESSION TRANSACTION READ ONLY`, which
 * covers whatever an implicit commit would start afterwards, and
 * `START TRANSACTION READ ONLY`. Reads have a time limit in the session and
 * again as an optimizer hint on each statement; waiting for a lock has its own.
 */

const STATEMENT_MS = 10_000;
const DESCRIBE_MS = 5_000;
const GRACE_MS = 5_000;
const PAGE_BYTES = 8 * 1024 * 1024;
const SMALL_BYTES = 2 * 1024 * 1024;
const DIRECT_ROWS = 1000;

type Format = "batch" | "types" | "xml";

const FORMAT_FLAGS: Record<Format, string[]> = {
  batch: ["--batch", "--skip-column-names"],
  // The table printer is the one that prints column metadata, even for an
  // empty result: the LIMIT 0 the documentation suggests for this.
  types: ["--table", "--column-type-info"],
  xml: ["--xml"],
};

async function mysql(
  target: ServiceTarget,
  database: string,
  statements: string[],
  opts: { format: Format; statementMs: number; maxBytes: number }
): Promise<{ stdout: string; elapsedMs: number }> {
  const env = { MYSQL_PWD: target.credentials.password };
  const args = [
    ...execArgs(target, env, { interactive: true }),
    "mysql", "-u", "root",
    "--default-character-set=utf8mb4", "--binary-mode", "--connect-timeout=5",
    ...FORMAT_FLAGS[opts.format],
    "-D", database,
  ];
  const input = mysqlScript(statements, opts.statementMs);
  const run = await runInContainer(args, { env, input, timeoutMs: opts.statementMs + GRACE_MS, maxBytes: opts.maxBytes });
  if (missingClient(run)) throw new BrowseError("Il client mysql non Ã¨ disponibile nel container del database.", 501);
  if (run.code !== 0 || run.timedOut || run.overflow) {
    throw runFailure(run, cleanMysqlError(run.stderr), Math.round(opts.statementMs / 1000));
  }
  return { stdout: run.stdout.toString("utf8"), elapsedMs: run.elapsedMs };
}

function rowsOf(stdout: string): unknown[][] {
  return mysqlBatchLines(stdout).flatMap((line) => {
    const row = parseJsonArray(line);
    return row ? [row] : [];
  });
}

const KINDS: Record<string, BrowseTableKind> = {
  "BASE TABLE": "table",
  VIEW: "view",
  "SYSTEM VIEW": "system",
};

export async function myTables(target: ServiceTarget, database: string): Promise<BrowseTables> {
  const { stdout } = await mysql(target, database, [MYSQL_TABLES_SQL], { format: "batch", statementMs: STATEMENT_MS, maxBytes: SMALL_BYTES });
  const tables = rowsOf(stdout).flatMap((row) => {
    if (typeof row[0] !== "string") return [];
    const kind = KINDS[String(row[1])] ?? "table";
    return [
      {
        schema: null,
        name: row[0],
        kind,
        rowsEstimate: typeof row[2] === "number" && kind !== "view" ? row[2] : null,
        bytes: typeof row[3] === "number" && kind !== "view" ? row[3] : null,
      },
    ];
  });
  return { tables: tables.slice(0, MAX_TABLES), truncated: tables.length > MAX_TABLES };
}

interface MyTableMeta {
  kind: BrowseTableKind;
  columns: BrowseColumn[];
  plans: MyColumnPlan[];
  key: MyColumnPlan[];
}

async function tableMeta(target: ServiceTarget, database: string, table: string): Promise<MyTableMeta> {
  const { stdout } = await mysql(target, database, [mysqlPrepared(mysqlTableMetaSql(table))], {
    format: "batch",
    statementMs: DESCRIBE_MS,
    maxBytes: SMALL_BYTES,
  });
  const rows = rowsOf(stdout).filter((row) => typeof row[0] === "string");
  if (rows.length === 0) throw new BrowseError("Tabella non trovata: potrebbe essere stata eliminata o rinominata.", 404);

  const columns: BrowseColumn[] = rows.map((row) => ({
    name: String(row[0]),
    type: typeof row[1] === "string" ? row[1] : null,
    key: typeof row[3] === "number" ? row[3] : null,
  }));
  const plans = rows.map((row) => ({ name: String(row[0]), kind: myKindOfDataType(String(row[2] ?? "")) }));
  const key = columns
    .map((column, i) => ({ column, plan: plans[i] }))
    .filter(({ column }) => typeof column.key === "number")
    .sort((a, b) => (a.column.key ?? 0) - (b.column.key ?? 0))
    .map(({ plan }) => plan);
  // A primary key on a column of a kind the browser cannot spell as a literal
  // is not one it can find a row by.
  const usable = key.every((plan) => plan.kind === "text" || plan.kind === "binary");
  return { kind: KINDS[String(rows[0][4])] ?? "table", columns, plans, key: usable ? key : [] };
}

function cutValues(rows: BrowseCell[][], plans: MyColumnPlan[], limit: number): { rows: BrowseCell[][]; cut: [number, number][] } {
  const cut: [number, number][] = [];
  const out = rows.map((row, r) =>
    row.map((value, c) => {
      const result = plans[c]?.kind === "binary" ? cutHexCell(value, binaryByteLimit(limit)) : cutCell(value, limit);
      if (result.cut) cut.push([r, c]);
      return result.value;
    })
  );
  return { rows: out, cut };
}

export async function myTablePage(target: ServiceTarget, database: string, table: string, offset: number): Promise<BrowseTablePage> {
  const meta = await tableMeta(target, database, table);
  const limit = cellLimit(meta.columns.length);
  const sql = myPreviewSql({ table, columns: meta.plans, key: meta.key, offset, limit, timeoutMs: STATEMENT_MS });
  const run = await mysql(target, database, [mysqlPrepared(sql)], { format: "batch", statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });

  const lines = mysqlBatchLines(run.stdout);
  const raw: BrowseCell[][] = [];
  const rowKeys: string[] = [];
  for (const line of lines.slice(0, PAGE_SIZE)) {
    const row = parseTextRow(line);
    if (!row) throw new BrowseError("La risposta del database non Ã¨ leggibile.", 502);
    raw.push(row.slice(0, meta.columns.length));
    if (meta.key.length) rowKeys.push(JSON.stringify(row.slice(meta.columns.length)));
  }
  const { rows, cut } = cutValues(raw, meta.plans, limit);
  return {
    table: { schema: null, name: table, kind: meta.kind },
    columns: meta.columns,
    rows,
    cut,
    cellLimit: limit,
    rowKeys: meta.key.length ? rowKeys : null,
    offset,
    hasMore: lines.length > PAGE_SIZE,
    elapsedMs: run.elapsedMs,
  };
}

export async function myCell(
  target: ServiceTarget,
  database: string,
  table: string,
  column: string,
  rowKey: string
): Promise<BrowseCellValue> {
  const meta = await tableMeta(target, database, table);
  const index = meta.plans.findIndex((plan) => plan.name === column);
  if (index < 0) throw new BrowseError("Colonna non trovata: ricarica l'anteprima.", 404);
  let values: unknown;
  try {
    values = JSON.parse(rowKey);
  } catch {
    values = null;
  }
  const sql = myCellSql(table, meta.plans[index], meta.key, values, STATEMENT_MS);
  if (!sql) throw new BrowseError("Riga non valida: ricarica l'anteprima.", 400);

  const run = await mysql(target, database, [mysqlPrepared(sql)], { format: "batch", statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });
  const line = mysqlBatchLines(run.stdout)[0];
  const row = line ? parseTextRow(line) : null;
  if (!row) throw new BrowseError("La riga non c'Ã¨ piÃ¹: Ã¨ stata modificata o eliminata. Ricarica l'anteprima.", 404);
  const result =
    meta.plans[index].kind === "binary" ? cutHexCell(row[0] ?? null, binaryByteLimit(FULL_VALUE_LIMIT)) : cutCell(row[0] ?? null, FULL_VALUE_LIMIT);
  return { value: result.value, truncated: result.cut, limit: FULL_VALUE_LIMIT };
}

export async function myQuery(target: ServiceTarget, database: string, text: string, offset: number): Promise<BrowseQueryResult> {
  const guard = guardQuery(text, "mysql");
  if (!guard.ok) throw new BrowseError(guard.reason, 400);

  if (guard.mode === "direct") {
    const run = await mysql(target, database, [mysqlDirect(guard.sql)], { format: "xml", statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });
    const parsed = parseMysqlXml(run.stdout);
    const columns = parsed.columns.map((name) => ({ name, type: null }));
    const limit = cellLimit(columns.length);
    const plans = columns.map((column) => ({ name: column.name, kind: "text" as const }));
    const { rows, cut } = cutValues(parsed.rows.slice(0, DIRECT_ROWS), plans, limit);
    return { mode: "direct", columns, rows, cut, cellLimit: limit, offset: 0, hasMore: parsed.rows.length > DIRECT_ROWS, elapsedMs: run.elapsedMs };
  }

  const described = await mysql(target, database, [mysqlPrepared(myDescribeSql(guard.sql))], {
    format: "types",
    statementMs: DESCRIBE_MS,
    maxBytes: SMALL_BYTES,
  });
  const fields = parseMysqlFieldTypes(described.stdout);
  if (fields.length === 0) throw new BrowseError("Non riesco a leggere le colonne della query.", 502);

  const plans = fields.map((field) => ({ name: field.name, kind: mysqlFieldKind(field) }));
  const limit = cellLimit(plans.length);
  const sql = myQueryRowsSql(guard.sql, plans, offset, limit, STATEMENT_MS);
  const fetched = await mysql(target, database, [mysqlPrepared(sql)], { format: "batch", statementMs: STATEMENT_MS, maxBytes: PAGE_BYTES });

  const lines = mysqlBatchLines(fetched.stdout);
  const raw: BrowseCell[][] = [];
  for (const line of lines.slice(0, PAGE_SIZE)) {
    const row = parseTextRow(line);
    if (!row) throw new BrowseError("La risposta del database non Ã¨ leggibile.", 502);
    raw.push(row);
  }
  const { rows, cut } = cutValues(raw, plans, limit);
  return {
    mode: "rows",
    columns: fields.map((field) => ({ name: field.name, type: mysqlFieldTypeName(field) })),
    rows,
    cut,
    cellLimit: limit,
    offset,
    hasMore: lines.length > PAGE_SIZE,
    elapsedMs: described.elapsedMs + fetched.elapsedMs,
  };
}
