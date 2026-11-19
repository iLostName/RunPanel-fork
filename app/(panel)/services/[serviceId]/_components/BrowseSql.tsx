"use client";

import { useMemo, useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useExpertMode } from "@/components/Providers";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint } from "@/components/ui/Hint";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Technical } from "@/components/ui/Technical";
import { formatBytes } from "@/lib/format";
import { guardQuery, type SqlDialect } from "@/lib/db-browser/sql-guard";
import type {
  BrowseCellValue,
  BrowseQueryResult,
  BrowseTable,
  BrowseTableKind,
  BrowseTablePage,
  BrowseTables,
} from "@/lib/db-browser/types";
import {
  BrowseFailureView,
  BrowseGrid,
  BrowsePager,
  Elapsed,
  ValueDialog,
  formatCount,
  useBrowseFetch,
  type BrowseCall,
  type OpenCell,
} from "./BrowseKit";

/**
 * PostgreSQL and MySQL: the tables of one database, a page of one of them, and
 * a box for a query. The same rows either way — a table's preview is the
 * query someone would have typed for it, written by the panel.
 */

const PAGE_SIZE = 50;

const KIND_LABEL: Record<BrowseTableKind, string | null> = {
  table: null,
  partitioned: "tabella partizionata",
  view: "vista",
  materialized: "vista materializzata",
  foreign: "tabella esterna",
  system: "vista di sistema",
};

function estimate(table: BrowseTable): string {
  if (table.rowsEstimate === null) return table.kind === "view" || table.kind === "system" ? "" : "righe non ancora stimate";
  return table.rowsEstimate === 1 ? "circa 1 riga" : `circa ${formatCount(table.rowsEstimate)} righe`;
}

function label(table: { schema: string | null; name: string }): string {
  return table.schema && table.schema !== "public" ? `${table.schema}.${table.name}` : table.name;
}

export function BrowseSql({ engine, database, call }: { engine: SqlDialect; database: string; call: BrowseCall }) {
  const [mode, setMode] = useState<"tables" | "query">("tables");
  const [table, setTable] = useState<BrowseTable | null>(null);

  return (
    <div className="space-y-4">
      <Segmented
        label="Cosa guardare"
        value={mode}
        onChange={setMode}
        options={[
          { value: "tables", label: "Tabelle", icon: "solar:list-check-minimalistic-linear" },
          { value: "query", label: "Query", icon: "solar:code-linear" },
        ]}
      />
      <div hidden={mode !== "tables"}>
        {table ? (
          <TableView call={call} database={database} table={table} onBack={() => setTable(null)} />
        ) : (
          <TableList call={call} database={database} onPick={setTable} />
        )}
      </div>
      <div hidden={mode !== "query"}>
        <QueryView call={call} database={database} engine={engine} />
      </div>
    </div>
  );
}

function TableList({ call, database, onPick }: { call: BrowseCall; database: string; onPick: (table: BrowseTable) => void }) {
  const { data, failure, loading, refresh } = useBrowseFetch<BrowseTables>(call, { action: "tables", database });
  const [search, setSearch] = useState("");
  const { expert } = useExpertMode();

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const tables = data?.tables ?? [];
    return needle ? tables.filter((t) => label(t).toLowerCase().includes(needle)) : tables;
  }, [data, search]);

  if (failure) return <BrowseFailureView failure={failure} onRetry={refresh} />;
  if (loading && !data) {
    return (
      <div className="space-y-2">
        <SkeletonBlock className="h-10" />
        <SkeletonBlock className="h-10" />
        <SkeletonBlock className="h-10" />
      </div>
    );
  }
  if (!data || data.tables.length === 0) {
    return (
      <EmptyState
        icon="solar:database-linear"
        title="Nessuna tabella"
        description="Questo database è vuoto, oppure le tabelle stanno in un altro database dello stesso motore."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <TextField value={search} onChange={setSearch} aria-label="Cerca una tabella" className="flex-1">
          <Input placeholder={`Cerca tra ${formatCount(data.tables.length)} tabelle`} />
        </TextField>
        <Button size="sm" variant="ghost" isPending={loading} onPress={refresh} aria-label="Aggiorna l'elenco">
          <Icon icon="solar:refresh-linear" width={16} aria-hidden />
        </Button>
      </div>
      <ul className="border-border divide-border max-h-[60vh] divide-y overflow-auto rounded-[var(--radius)] border">
        {shown.map((table) => (
          <li key={`${table.schema}.${table.name}`}>
            <button
              type="button"
              onClick={() => onPick(table)}
              className="hover:bg-surface-hover flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
            >
              <Icon
                icon={table.kind === "view" || table.kind === "materialized" || table.kind === "system" ? "solar:eye-linear" : "solar:document-text-linear"}
                width={16}
                className="text-muted shrink-0"
                aria-hidden
              />
              {/* On a phone what kind of table and how big go under the name:
                  beside it they left "indirizzi_di_s…" of a name, or nothing. */}
              <span className="min-w-0 flex-1 md:contents">
                <span className="text-foreground block min-w-0 flex-1 truncate font-mono text-sm">{label(table)}</span>
                <span className="text-muted text-meta block truncate tabular-nums md:hidden">
                  {[KIND_LABEL[table.kind], estimate(table), expert && table.bytes !== null ? formatBytes(table.bytes) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {KIND_LABEL[table.kind] && <span className="text-muted text-meta shrink-0 max-md:hidden">{KIND_LABEL[table.kind]}</span>}
              <span className="text-muted text-meta shrink-0 tabular-nums max-md:hidden">{estimate(table)}</span>
              {expert && table.bytes !== null && (
                <span className="text-muted text-meta w-16 shrink-0 text-right tabular-nums max-md:hidden">{formatBytes(table.bytes)}</span>
              )}
              <Icon icon="solar:alt-arrow-right-linear" width={15} className="text-muted shrink-0" aria-hidden />
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="text-muted px-3 py-3 text-sm">Nessuna tabella con questo nome.</li>}
      </ul>
      {data.truncated && (
        <FieldHint>Sono elencate le prime {formatCount(data.tables.length)} tabelle: le altre si leggono con una query.</FieldHint>
      )}
    </div>
  );
}

function TableView({ call, database, table, onBack }: { call: BrowseCall; database: string; table: BrowseTable; onBack: () => void }) {
  const [offset, setOffset] = useState(0);
  const { data, failure, loading, refresh } = useBrowseFetch<BrowseTablePage>(call, {
    action: "rows",
    database,
    schema: table.schema,
    table: table.name,
    offset,
  });
  const [open, setOpen] = useState<OpenCell | null>(null);
  const [full, setFull] = useState<{ at: string; value: BrowseCellValue } | null>(null);
  // The page on screen stays there while the next one loads, rather than
  // blinking to a skeleton on every "Successive".
  const [last, setLast] = useState<BrowseTablePage | null>(null);
  if (data && data !== last) setLast(data);
  const page = data ?? last;

  const shownOffset = page?.offset ?? offset;
  const at = open ? `${shownOffset}:${open.row}:${open.column}` : "";
  const loaded = full && full.at === at ? full.value : null;
  const cutSet = new Set((page?.cut ?? []).map(([r, c]) => `${r}:${c}`));

  async function loadFull(): Promise<null | { error: string; detail: string | null }> {
    if (!open || !page?.rowKeys) return null;
    const result = await call<BrowseCellValue>({
      action: "cell",
      database,
      schema: table.schema,
      table: table.name,
      column: page.columns[open.column]?.name ?? "",
      row: page.rowKeys[open.row] ?? "",
    });
    if (!result.ok) return result.failure;
    setFull({ at, value: result.data });
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onPress={onBack}>
          <Icon icon="solar:arrow-left-linear" width={15} aria-hidden />
          Tutte le tabelle
        </Button>
        <span className="text-foreground min-w-0 truncate font-mono text-sm font-medium">{label(table)}</span>
        {KIND_LABEL[table.kind] && <span className="text-muted text-meta">{KIND_LABEL[table.kind]}</span>}
        <span className="ml-auto flex items-center gap-2">
          <Elapsed ms={page?.elapsedMs} />
          <Button size="sm" variant="ghost" isPending={loading} onPress={refresh} aria-label="Ricarica le righe">
            <Icon icon="solar:refresh-linear" width={16} aria-hidden />
          </Button>
        </span>
      </div>

      <p className="text-muted text-sm">
        {shownOffset === 0 ? `Anteprima: le prime ${PAGE_SIZE} righe.` : `Righe dalla ${formatCount(shownOffset + 1)}.`}
        {table.rowsEstimate !== null && ` In tutto ${estimate(table)}.`}{" "}
        <Technical>
          {page?.columns.some((c) => typeof c.key === "number") ? "In ordine di chiave primaria." : "Nell'ordine in cui le restituisce il database."}
        </Technical>
      </p>

      {failure ? (
        <BrowseFailureView failure={failure} onRetry={refresh} />
      ) : !page ? (
        <SkeletonBlock className="h-64" />
      ) : page.rows.length === 0 ? (
        <EmptyState icon="solar:document-text-linear" title={shownOffset === 0 ? "La tabella è vuota" : "Nessuna riga qui"} />
      ) : (
        <BrowseGrid
          columns={page.columns}
          rows={page.rows}
          cut={page.cut}
          offset={shownOffset}
          onOpen={setOpen}
          ariaLabel={`Righe di ${label(table)}`}
        />
      )}

      {page && !failure && (
        <BrowsePager offset={shownOffset} count={page.rows.length} pageSize={PAGE_SIZE} hasMore={page.hasMore} onChange={setOffset} busy={loading} />
      )}
      {page && page.cut.length > 0 && (
        <FieldHint>I valori lunghi sono accorciati: apri una cella per leggerla tutta.</FieldHint>
      )}

      {open && page && (
        <ValueDialog
          title={page.columns[open.column]?.name ?? ""}
          subtitle={`Riga ${formatCount(shownOffset + open.row + 1)} di ${label(table)}`}
          value={loaded ? loaded.value : (page.rows[open.row]?.[open.column] ?? null)}
          truncated={loaded ? loaded.truncated : cutSet.has(`${open.row}:${open.column}`)}
          limitNote={loaded ? `i primi ${formatCount(loaded.limit)} caratteri` : `i primi ${formatCount(page.cellLimit)} caratteri`}
          onLoadFull={page.rowKeys && !loaded ? loadFull : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

const PLACEHOLDER: Record<SqlDialect, string> = {
  postgresql: "SELECT * FROM utenti WHERE attivo = true ORDER BY creato_il DESC",
  mysql: "SELECT * FROM utenti WHERE attivo = 1 ORDER BY creato_il DESC",
};

function QueryView({ call, database, engine }: { call: BrowseCall; database: string; engine: SqlDialect }) {
  const [text, setText] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [submitted, setSubmitted] = useState<{ sql: string; offset: number } | null>(null);
  const [open, setOpen] = useState<OpenCell | null>(null);
  const { data, failure, loading, refresh } = useBrowseFetch<BrowseQueryResult>(
    call,
    submitted ? { action: "query", database, sql: submitted.sql, offset: submitted.offset } : null
  );

  // The previous page of the same query stays on screen while the next loads;
  // a different query never shows the old one's rows as if they were its own.
  const [last, setLast] = useState<{ sql: string; data: BrowseQueryResult } | null>(null);
  if (data && submitted && data !== last?.data) setLast({ sql: submitted.sql, data });

  const guard = text.trim() ? guardQuery(text, engine) : null;
  const problem = attempted && guard && !guard.ok ? guard.reason : undefined;
  const result = data ?? (last && submitted && last.sql === submitted.sql ? last.data : null);
  const cutSet = new Set((result?.cut ?? []).map(([r, c]) => `${r}:${c}`));

  function run() {
    setAttempted(true);
    if (!guard?.ok) return;
    setOpen(null);
    if (submitted && submitted.sql === text && submitted.offset === 0) refresh();
    else setSubmitted({ sql: text, offset: 0 });
  }

  return (
    <div className="space-y-3">
      <Field
        label="Query"
        htmlFor="browse-query"
        error={problem}
        hint={`Solo letture. Si vedono ${PAGE_SIZE} righe per volta e la query si ferma dopo 10 secondi.`}
        explain={
          <>
            SELECT, WITH, VALUES e TABLE vengono racchiuse in una SELECT con LIMIT {PAGE_SIZE + 1}; SHOW, EXPLAIN
            {engine === "mysql" ? " e DESCRIBE" : ""} si eseguono così come sono. Tutto gira in una transazione READ ONLY, con un
            limite di tempo per la query e per le attese sui lock: il database stesso rifiuterebbe una scrittura.
          </>
        }
      >
        <textarea
          id="browse-query"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              run();
            }
          }}
          rows={5}
          spellCheck={false}
          placeholder={PLACEHOLDER[engine]}
          className="border-border bg-background text-foreground focus:border-accent/60 w-full resize-y rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" isPending={loading} isDisabled={!text.trim()} onPress={run}>
          <Icon icon="solar:play-linear" width={16} aria-hidden />
          Esegui
        </Button>
        <span className="text-muted text-meta">
          oppure <Code>Ctrl</Code>+<Code>Invio</Code>
        </span>
        <Elapsed ms={result?.elapsedMs} className="ml-auto" />
      </div>

      {failure ? (
        <BrowseFailureView failure={failure} />
      ) : loading && !result ? (
        <SkeletonBlock className="h-40" />
      ) : result ? (
        result.rows.length === 0 ? (
          <p className="text-muted text-sm">
            {result.offset > 0 ? "Nessuna riga oltre queste." : "La query non ha restituito righe."}
          </p>
        ) : (
          <>
            <BrowseGrid
              columns={result.columns}
              rows={result.rows}
              cut={result.cut}
              offset={result.offset}
              onOpen={setOpen}
              ariaLabel="Risultato della query"
            />
            {result.mode === "rows" ? (
              <BrowsePager
                offset={result.offset}
                count={result.rows.length}
                pageSize={PAGE_SIZE}
                hasMore={result.hasMore}
                onChange={(offset) => submitted && setSubmitted({ ...submitted, offset })}
                busy={loading}
              />
            ) : (
              result.hasMore && <FieldHint>Sono mostrate le prime {formatCount(result.rows.length)} righe.</FieldHint>
            )}
          </>
        )
      ) : null}

      {open && result && (
        <ValueDialog
          title={result.columns[open.column]?.name ?? ""}
          subtitle={`Riga ${formatCount(result.offset + open.row + 1)} del risultato`}
          value={result.rows[open.row]?.[open.column] ?? null}
          truncated={cutSet.has(`${open.row}:${open.column}`)}
          limitNote={`i primi ${formatCount(result.cellLimit)} caratteri`}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
