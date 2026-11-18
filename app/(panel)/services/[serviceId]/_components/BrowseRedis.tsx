"use client";

import { useState } from "react";
import { Button, Input, Modal, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Technical } from "@/components/ui/Technical";
import { formatBytes } from "@/lib/format";
import { outsideToasts } from "@/lib/toast";
import { SheetGrip } from "@/components/ui/SheetGrip";
import type { BrowseBytes, RedisKeyDetail, RedisKeyItem, RedisKeyPage, RedisKeyspaceEntry } from "@/lib/db-browser/types";
import { BrowseFailureView, formatCount, useBrowseFetch, type BrowseCall, type BrowseFailure } from "./BrowseKit";

/**
 * Redis: the keys of one of its numbered databases, found with SCAN a slice at
 * a time, and what one key holds. A pattern that matches little in a large
 * keyspace takes several slices — "Continua a cercare" asks for the next one,
 * instead of the server walking every key at once.
 */

const TYPE_LABEL: Record<string, string> = {
  string: "stringa",
  list: "lista",
  set: "insieme",
  zset: "insieme ordinato",
  hash: "hash",
  stream: "stream",
  none: "scomparsa",
};

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

/** "tra 5 min", "senza scadenza". */
function formatTtl(ms: number): string {
  if (ms === -1) return "senza scadenza";
  if (ms < 0) return "scaduta";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `scade tra ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `scade tra ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `scade tra ${hours} ${hours === 1 ? "ora" : "ore"}`;
  return `scade tra ${formatCount(Math.round(hours / 24))} giorni`;
}

function formatSize(type: string, size: number | null): string {
  if (size === null) return "";
  if (type === "string") return formatBytes(size);
  return size === 1 ? "1 elemento" : `${formatCount(size)} elementi`;
}

export function BrowseRedis({ call }: { call: BrowseCall }) {
  const keyspace = useBrowseFetch<{ databases: RedisKeyspaceEntry[] }>(call, { action: "keyspace" });
  const [database, setDatabase] = useState("0");
  const [pattern, setPattern] = useState("*");
  const [search, setSearch] = useState({ database: "0", pattern: "*" });
  const first = useBrowseFetch<RedisKeyPage>(call, { action: "keys", database: search.database, pattern: search.pattern, cursor: "0" });

  // Further slices of the same search, appended. A new search starts over.
  const base = `${search.database}\u0000${search.pattern}`;
  const [more, setMore] = useState<{ base: string; pages: RedisKeyPage[] }>({ base, pages: [] });
  const [moreFailure, setMoreFailure] = useState<BrowseFailure | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [selected, setSelected] = useState<RedisKeyItem | null>(null);

  const extra = more.base === base ? more.pages : [];
  const pages = first.data ? [first.data, ...extra] : [];
  const lastPage = pages.at(-1) ?? null;
  const keys = pages.flatMap((page) => page.keys);
  const examined = pages.reduce((sum, page) => sum + page.examined, 0);

  const counts = new Map((keyspace.data?.databases ?? []).map((entry) => [entry.index, entry]));
  const indexes = [...new Set([...Array.from({ length: 16 }, (_, i) => i), ...counts.keys()])].sort((a, b) => a - b);
  const options = indexes.map((index) => {
    const entry = counts.get(index);
    return {
      value: String(index),
      label: entry ? `Database ${index} · ${formatCount(entry.keys)} ${entry.keys === 1 ? "chiave" : "chiavi"}` : `Database ${index} · vuoto`,
    };
  });

  function find(nextDatabase = database) {
    setMoreFailure(null);
    const next = { database: nextDatabase, pattern: pattern.trim() || "*" };
    if (next.database === search.database && next.pattern === search.pattern) first.refresh();
    else setSearch(next);
    setMore({ base: `${next.database}\u0000${next.pattern}`, pages: [] });
  }

  async function continueScan() {
    if (!lastPage || lastPage.done) return;
    setContinuing(true);
    setMoreFailure(null);
    const result = await call<RedisKeyPage>({ action: "keys", database: search.database, pattern: search.pattern, cursor: lastPage.cursor });
    setContinuing(false);
    if (!result.ok) {
      setMoreFailure(result.failure);
      return;
    }
    setMore({ base, pages: [...extra, result.data] });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
        <SelectField
          label="Database"
          value={database}
          onChange={(next) => {
            setDatabase(next);
            find(next);
          }}
          options={options}
        />
        <Field label="Chiavi che corrispondono a" htmlFor="redis-pattern">
          <TextField value={pattern} onChange={setPattern} aria-label="Chiavi che corrispondono a">
            <Input
              id="redis-pattern"
              className="font-mono text-sm"
              placeholder="utente:*"
              onKeyDown={(e) => {
                if (e.key === "Enter") find();
              }}
            />
          </TextField>
        </Field>
        <Button variant="primary" size="sm" className="sm:mb-0.5" isPending={first.loading} onPress={() => find()}>
          <Icon icon="solar:magnifier-linear" width={16} aria-hidden />
          Cerca
        </Button>
      </div>
      <FieldHint>
        <Code>*</Code> vale qualsiasi testo: <Code>utente:*</Code> trova tutte le chiavi che iniziano con <Code>utente:</Code>.
      </FieldHint>

      {first.failure ? (
        <BrowseFailureView failure={first.failure} onRetry={first.refresh} />
      ) : !first.data ? (
        <div className="space-y-2">
          <SkeletonBlock className="h-10" />
          <SkeletonBlock className="h-10" />
        </div>
      ) : keys.length === 0 && lastPage?.done ? (
        <EmptyState
          icon="solar:key-minimalistic-linear"
          title={search.pattern === "*" ? "Nessuna chiave in questo database" : "Nessuna chiave corrisponde"}
          description={search.pattern === "*" ? "Le app potrebbero usare un altro dei database numerati." : undefined}
        />
      ) : (
        <ul className="border-border divide-border max-h-[60vh] divide-y overflow-auto rounded-[var(--radius)] border">
          {keys.map((item, i) => (
            <li key={`${item.key.raw}:${i}`}>
              <button
                type="button"
                disabled={item.key.length !== undefined}
                onClick={() => setSelected(item)}
                className="hover:bg-surface-hover flex w-full items-center gap-3 px-3 py-2 text-left transition-colors disabled:cursor-default"
              >
                <span className="text-foreground min-w-0 flex-1 truncate font-mono text-sm">{item.key.text}</span>
                <Badge>{typeLabel(item.type)}</Badge>
                <span className="text-muted text-meta hidden shrink-0 sm:inline">{formatTtl(item.ttlMs)}</span>
                <span className="text-muted text-meta w-20 shrink-0 text-right tabular-nums">{formatSize(item.type, item.size)}</span>
              </button>
            </li>
          ))}
          {keys.length === 0 && <li className="text-muted px-3 py-3 text-sm">Ancora nessuna chiave trovata: continua a cercare.</li>}
        </ul>
      )}

      {lastPage && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted text-meta">
            {lastPage.done
              ? `Ricerca completa: ${formatCount(keys.length)} ${keys.length === 1 ? "chiave trovata" : "chiavi trovate"} su ${formatCount(lastPage.dbSize)}.`
              : `${formatCount(keys.length)} trovate finora, guardando circa ${formatCount(examined)} chiavi su ${formatCount(lastPage.dbSize)}.`}
          </span>
          {!lastPage.done && (
            <Button size="sm" variant="outline" isPending={continuing} onPress={() => void continueScan()}>
              Continua a cercare
            </Button>
          )}
        </div>
      )}
      {moreFailure && <BrowseFailureView failure={moreFailure} />}

      {selected && <RedisKeyDialog call={call} database={search.database} item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function BytesText({ value }: { value: BrowseBytes }) {
  return (
    <span className="font-mono text-xs break-all whitespace-pre-wrap">
      {value.text}
      {value.length !== undefined && <span className="text-muted"> … ({formatBytes(value.length)})</span>}
    </span>
  );
}

function RedisKeyDialog({ call, database, item, onClose }: { call: BrowseCall; database: string; item: RedisKeyItem; onClose: () => void }) {
  const [full, setFull] = useState(false);
  const { data, failure, loading, refresh } = useBrowseFetch<RedisKeyDetail>(call, { action: "key", database, key: item.key.raw, full });
  const [last, setLast] = useState<RedisKeyDetail | null>(null);
  if (data && data !== last) setLast(data);
  const detail = data ?? last;
  const value = detail?.value;
  const shownOf = detail && detail.size !== null && detail.shown < detail.size;

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()} shouldCloseOnInteractOutside={outsideToasts}>
      <Modal.Container>
        <Modal.Dialog className="max-w-3xl">
          <SheetGrip />
          <Modal.Header>
            <Modal.Heading className="font-mono break-all">{item.key.text}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{typeLabel(detail?.type ?? item.type)}</Badge>
              <span className="text-muted text-meta">{formatTtl(detail?.ttlMs ?? item.ttlMs)}</span>
              <span className="text-muted text-meta">{formatSize(detail?.type ?? item.type, detail?.size ?? item.size)}</span>
              {item.key.binary && <span className="text-muted text-meta">il nome contiene byte che non sono testo</span>}
            </div>

            {failure ? (
              <BrowseFailureView failure={failure} onRetry={refresh} />
            ) : !detail || !value ? (
              <SkeletonBlock className="h-32" />
            ) : value.kind === "string" ? (
              <>
                <pre className="border-border bg-surface-secondary text-foreground max-h-[55vh] overflow-auto rounded-[var(--radius)] border p-3">
                  <BytesText value={value.value} />
                </pre>
                {value.value.binary && (
                  <FieldHint>Contiene byte che non sono testo: sono scritti come \xHH, come li mostra redis-cli.</FieldHint>
                )}
                {value.value.length !== undefined && (
                  <Hint tone="info">
                    Qui ci sono i primi {formatBytes(detail.limit)}: il valore continua.
                    {full ? " Per leggerlo tutto usa la console." : ""}
                  </Hint>
                )}
              </>
            ) : value.kind === "list" || value.kind === "set" ? (
              <ol className="border-border divide-border max-h-[55vh] divide-y overflow-auto rounded-[var(--radius)] border">
                {value.items.map((entry, i) => (
                  <li key={i} className="flex gap-3 px-3 py-1.5">
                    {value.kind === "list" && <span className="text-muted text-meta w-8 shrink-0 text-right tabular-nums">{i}</span>}
                    <BytesText value={entry} />
                  </li>
                ))}
              </ol>
            ) : value.kind === "zset" || value.kind === "hash" ? (
              <div className="border-border max-h-[55vh] overflow-auto rounded-[var(--radius)] border">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-surface-secondary sticky top-0">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {value.kind === "zset" ? "Membro" : "Campo"}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {value.kind === "zset" ? "Punteggio" : "Valore"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.kind === "zset"
                      ? value.items.map((entry, i) => (
                          <tr key={i} className="border-border border-t align-top">
                            <td className="px-3 py-1.5">
                              <BytesText value={entry.member} />
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs tabular-nums">{entry.score}</td>
                          </tr>
                        ))
                      : value.items.map((entry, i) => (
                          <tr key={i} className="border-border border-t align-top">
                            <td className="px-3 py-1.5">
                              <BytesText value={entry.field} />
                            </td>
                            <td className="px-3 py-1.5">
                              <BytesText value={entry.value} />
                            </td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              </div>
            ) : value.kind === "stream" ? (
              <ul className="max-h-[55vh] space-y-2 overflow-auto">
                {value.items.map((entry) => (
                  <li key={entry.id} className="border-border rounded-[var(--radius)] border px-3 py-2">
                    <span className="text-muted text-meta font-mono">{entry.id}</span>
                    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                      {entry.fields.map((pair, j) => (
                        <div key={j} className="contents">
                          <dt className="text-muted">
                            <BytesText value={pair.field} />
                          </dt>
                          <dd>
                            <BytesText value={pair.value} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            ) : value.kind === "none" ? (
              <p className="text-muted text-sm">La chiave non c&apos;è più: è scaduta o è stata eliminata.</p>
            ) : (
              <p className="text-muted text-sm">
                Questo tipo di chiave ({detail.type}) non si può mostrare qui: usa la console.
              </p>
            )}

            {shownOf && value?.kind !== "string" && (
              <FieldHint>
                Mostrati i primi {formatCount(detail.shown)} elementi su {formatCount(detail.size ?? 0)}.
                <Technical> Ogni valore è accorciato a {formatBytes(detail.limit)}.</Technical>
              </FieldHint>
            )}
          </Modal.Body>
          <Modal.Footer className="justify-end gap-2">
            {value?.kind === "string" && value.value.length !== undefined && (!full || loading) && (
              <Button variant="secondary" isPending={full && loading} onPress={() => setFull(true)}>
                <Icon icon="solar:maximize-square-minimalistic-linear" width={15} aria-hidden />
                Carica il valore completo
              </Button>
            )}
            <Button onPress={onClose}>Chiudi</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
