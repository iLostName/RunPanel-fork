"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useNodeApi } from "@/lib/hooks/useNode";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { useExpertMode } from "@/components/Providers";
import { Hint } from "@/components/ui/Hint";
import { ErrorDetail } from "@/components/ui/LoadError";
import { Segmented } from "@/components/ui/Segmented";
import { MSG } from "@/lib/copy";
import { outsideToasts } from "@/lib/toast";
import { SheetGrip } from "@/components/ui/SheetGrip";
import { cn } from "@/lib/utils";
import type { BrowseCell, BrowseColumn } from "@/lib/db-browser/types";

/**
 * What the `Browse*` panels share: the call, the grid, the "mostra tutto".
 *
 * Every read is a POST to `/browse` — the statement and the key stay out of
 * URLs — so `useResource`, which GETs, does not fit; `useBrowseFetch` is its
 * counterpart for a request described by a body. It is keyed by that body, so
 * changing the table or the page is changing the key, and the answer that
 * lands is always the one for the key on screen.
 */

export interface BrowseFailure {
  error: string;
  detail: string | null;
}

export type BrowseCall = <T>(body: Record<string, unknown>) => Promise<{ ok: true; data: T } | { ok: false; failure: BrowseFailure }>;

export function useBrowseCall(serviceId: string): BrowseCall {
  const api = useNodeApi();
  return useCallback(
    async <T,>(body: Record<string, unknown>) => {
      try {
        const res = await fetch(api(`/api/services/${serviceId}/browse`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { ok: false as const, failure: { error: json.error ?? `HTTP ${res.status}`, detail: json.detail ?? null } };
        }
        return { ok: true as const, data: json as T };
      } catch {
        return { ok: false as const, failure: { error: MSG.unreachable, detail: null } };
      }
    },
    [api, serviceId]
  );
}

interface Landed<T> {
  key: string;
  nonce: number;
  data: T | null;
  failure: BrowseFailure | null;
}

/**
 * The answer to `body`, fetched when it changes; null `body` asks nothing.
 *
 * Loading is derived — the key on screen against the key of the last answer —
 * rather than set when a request starts, so the effect never sets state before
 * its request returns. `refresh` asks the same question again and keeps the
 * previous answer on screen meanwhile.
 */
export function useBrowseFetch<T>(call: BrowseCall, body: Record<string, unknown> | null) {
  const key = body ? JSON.stringify(body) : null;
  const [nonce, setNonce] = useState(0);
  const [landed, setLanded] = useState<Landed<T> | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void call<T>(JSON.parse(key)).then((result) => {
      if (cancelled) return;
      setLanded(result.ok ? { key, nonce, data: result.data, failure: null } : { key, nonce, data: null, failure: result.failure });
    });
    return () => {
      cancelled = true;
    };
  }, [call, key, nonce]);

  const current = landed && landed.key === key ? landed : null;
  return {
    data: current?.data ?? null,
    failure: current?.failure ?? null,
    loading: key !== null && (!current || current.nonce !== nonce),
    refresh: useCallback(() => setNonce((n) => n + 1), []),
  };
}

export function BrowseFailureView({ failure, onRetry, className }: { failure: BrowseFailure; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={className}>
      <Hint tone="warn" title="Lettura non riuscita">
        <div className="flex flex-wrap items-center gap-3">
          <span className="break-words whitespace-pre-line">{failure.error}</span>
          {onRetry && (
            <Button size="sm" variant="secondary" onPress={onRetry}>
              Riprova
            </Button>
          )}
        </div>
        {failure.detail && failure.detail !== failure.error && <ErrorDetail detail={failure.detail} />}
      </Hint>
    </div>
  );
}

/** "1.234", the way an Italian reads a count. */
export function formatCount(value: number): string {
  return value.toLocaleString("it-IT");
}

/** What a grid cell shows: a line, short. The whole value is one press away. */
const CELL_PREVIEW = 120;

function needsDialog(value: string, cut: boolean): boolean {
  return cut || value.length > CELL_PREVIEW || value.includes("\n");
}

function CellPreview({ value }: { value: BrowseCell }) {
  if (value === null) return <span className="text-muted text-meta font-sans italic">NULL</span>;
  if (value === "") return <span className="text-muted text-meta font-sans italic">vuoto</span>;
  const line = value.split("\n", 1)[0];
  return <>{line.length > CELL_PREVIEW ? `${line.slice(0, CELL_PREVIEW)}…` : line}</>;
}

export interface OpenCell {
  row: number;
  column: number;
}

/**
 * A page of rows, as a table: the column's name, its type under it, its
 * place in the primary key. Long values are cut on screen and open whole.
 */
export function BrowseGrid({
  columns,
  rows,
  cut,
  offset,
  onOpen,
  ariaLabel,
}: {
  columns: BrowseColumn[];
  rows: BrowseCell[][];
  cut: [number, number][];
  offset: number;
  onOpen: (cell: OpenCell) => void;
  ariaLabel: string;
}) {
  const cutSet = new Set(cut.map(([r, c]) => `${r}:${c}`));
  /** One value: a line in the table, up to three wrapped lines in a card, where the column is narrow. */
  const cell = (value: BrowseCell, r: number, c: number, card = false) => {
    const isCut = cutSet.has(`${r}:${c}`);
    const open = value !== null && needsDialog(value, isCut);
    const text = cn("text-foreground block font-mono text-xs", card ? "line-clamp-3 [overflow-wrap:anywhere]" : "truncate");
    return open ? (
      <button
        type="button"
        onClick={() => onOpen({ row: r, column: c })}
        className="group block w-full min-w-0 text-left"
        aria-label={`Mostra tutto il valore di ${columns[c]?.name ?? "questa colonna"}, riga ${offset + r + 1}`}
      >
        <span className={text}>
          <CellPreview value={value} />
        </span>
        <span className="text-accent text-meta group-hover:underline">mostra tutto</span>
      </button>
    ) : (
      <span className={text}>
        <CellPreview value={value} />
      </span>
    );
  };
  const keyIcon = (column: BrowseColumn | undefined) =>
    typeof column?.key === "number" && (
      <Icon icon="solar:key-minimalistic-linear" width={13} className="text-accent shrink-0" aria-label="chiave primaria" />
    );
  const columnName = (column: BrowseColumn | undefined) => column?.name || <span className="text-muted italic">senza nome</span>;

  return (
    <>
      {/*
        A phone held upright: a card per row, each value under its column's
        name. A table there showed the row number and two columns of a page
        that scrolled sideways inside a box inside a page scrolling down.
        Turned sideways the phone has the width, and gets the table back with
        the row number and the first column held at the left edge.
      */}
      <ol className="hidden space-y-2 max-md:portrait:block" aria-label={ariaLabel}>
        {rows.map((row, r) => (
          <li key={r} className="border-border rounded-[var(--radius)] border">
            <p className="text-muted text-meta border-border border-b px-3 py-1.5 tabular-nums">Riga {formatCount(offset + r + 1)}</p>
            <dl className="divide-border divide-y px-3">
              {row.map((value, c) => (
                <div key={c} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-3 py-1.5">
                  <dt className="text-muted flex min-w-0 items-center gap-1 text-xs">
                    <span className="truncate">{columnName(columns[c])}</span>
                    {keyIcon(columns[c])}
                  </dt>
                  <dd className="min-w-0">{cell(value, r, c, true)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ol>

      <div className="border-border max-h-[65vh] overflow-auto rounded-[var(--radius)] border max-md:portrait:hidden">
        <table className="min-w-full border-collapse text-left text-sm" aria-label={ariaLabel}>
          <thead className="bg-surface-secondary sticky top-0 z-10">
            <tr>
              <th scope="col" className={cn("text-muted text-meta w-10 px-2 py-2 text-right font-normal", STICKY_HEAD, "max-md:left-0 max-md:w-14 max-md:min-w-14")}>
                #
              </th>
              {columns.map((column, i) => (
                <th key={i} scope="col" className={cn("px-3 py-2 align-bottom font-medium whitespace-nowrap", i === 0 && STICKY_HEAD, i === 0 && "max-md:left-14")}>
                  <span className="text-foreground inline-flex items-center gap-1">
                    {columnName(column)}
                    {keyIcon(column)}
                  </span>
                  {column.type && <span className="text-muted text-meta block font-mono font-normal">{column.type}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-border hover:bg-surface-hover border-t">
                <td className={cn("text-muted text-meta px-2 py-1.5 text-right align-top tabular-nums", STICKY_CELL, "max-md:left-0 max-md:w-14 max-md:min-w-14")}>
                  {offset + r + 1}
                </td>
                {row.map((value, c) => (
                  <td
                    key={c}
                    className={cn("max-w-[22rem] px-3 py-1.5 align-top", c === 0 && STICKY_CELL, c === 0 && "max-md:left-14 max-md:max-w-[40vw]")}
                  >
                    {cell(value, r, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Held at the left edge on a phone turned sideways: the row number and the first column. */
const STICKY_HEAD = "max-md:sticky max-md:z-20 max-md:bg-surface-secondary";
const STICKY_CELL = "max-md:sticky max-md:z-[1] max-md:bg-surface max-md:shadow-[inset_-1px_0_0_var(--color-border)]";

/** Pretty JSON when the value is a JSON object or array, else null. */
function prettyJson(value: string): string | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : null;
  } catch {
    return null;
  }
}

/**
 * One value, whole — or as much of it as was fetched, saying so. `onLoadFull`
 * is offered when the page knows how to ask for the rest.
 */
export function ValueDialog({
  title,
  subtitle,
  value,
  truncated,
  limitNote,
  onLoadFull,
  onClose,
}: {
  title: string;
  subtitle?: string;
  value: BrowseCell | null;
  truncated: boolean;
  /** What "cut" means here: "i primi 2.000 caratteri". */
  limitNote: string;
  onLoadFull?: () => Promise<BrowseFailure | null>;
  onClose: () => void;
}) {
  const { copied, copy } = useClipboard();
  const [format, setFormat] = useState<"pretty" | "raw">("pretty");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<BrowseFailure | null>(null);
  const pretty = value && !truncated ? prettyJson(value) : null;
  const shown = value === null ? null : pretty && format === "pretty" ? pretty : value;

  async function loadFull() {
    if (!onLoadFull) return;
    setLoading(true);
    setFailure(await onLoadFull());
    setLoading(false);
  }

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      shouldCloseOnInteractOutside={outsideToasts}
    >
      <Modal.Container>
        <Modal.Dialog className="max-w-3xl">
          <SheetGrip />
          <Modal.Header>
            <Modal.Heading className="font-mono">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-3">
            {subtitle && <p className="text-muted text-sm">{subtitle}</p>}
            {pretty && (
              <Segmented
                label="Come mostrarlo"
                value={format}
                onChange={setFormat}
                options={[
                  { value: "pretty", label: "JSON formattato" },
                  { value: "raw", label: "Com'è salvato" },
                ]}
              />
            )}
            {shown === null ? (
              <p className="text-muted text-sm italic">NULL: nessun valore.</p>
            ) : (
              <pre className="border-border bg-surface-secondary text-foreground text-meta max-h-[55vh] overflow-auto rounded-[var(--radius)] border p-3 font-mono leading-relaxed break-words whitespace-pre-wrap">
                {shown === "" ? <span className="text-muted italic">vuoto</span> : shown}
              </pre>
            )}
            {truncated && (
              <Hint tone="info">
                Qui ci sono {limitNote}: il valore continua.
                {onLoadFull ? " Puoi caricarlo per intero, fino a 1 MB." : " Per leggerlo tutto usa la console."}
              </Hint>
            )}
            {failure && <BrowseFailureView failure={failure} />}
          </Modal.Body>
          <Modal.Footer className="flex-wrap justify-end gap-2">
            {truncated && onLoadFull && (
              <Button variant="secondary" isPending={loading} onPress={() => void loadFull()}>
                <Icon icon="solar:maximize-square-minimalistic-linear" width={15} aria-hidden />
                Carica il valore completo
              </Button>
            )}
            {shown !== null && (
              <Button variant="ghost" onPress={() => void copy(shown)}>
                <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} aria-hidden />
                {copied ? "Copiato" : "Copia"}
              </Button>
            )}
            <Button onPress={onClose}>Chiudi</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** "Righe 51–100", with the two buttons that move by a page. */
export function BrowsePager({
  offset,
  count,
  pageSize,
  hasMore,
  onChange,
  noun = "Righe",
  busy,
}: {
  offset: number;
  count: number;
  pageSize: number;
  hasMore: boolean;
  onChange: (offset: number) => void;
  noun?: string;
  busy?: boolean;
}) {
  if (count === 0 && offset === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-muted text-meta tabular-nums">
        {noun} {formatCount(offset + 1)}–{formatCount(offset + count)}
        {hasMore ? ", e ce ne sono altre" : ""}
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" isDisabled={offset === 0 || busy} onPress={() => onChange(Math.max(0, offset - pageSize))}>
          <Icon icon="solar:alt-arrow-left-linear" width={15} aria-hidden />
          Precedenti
        </Button>
        <Button size="sm" variant="outline" isDisabled={!hasMore || busy} onPress={() => onChange(offset + pageSize)}>
          Successive
          <Icon icon="solar:alt-arrow-right-linear" width={15} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** For experts: how long the engine took. */
export function Elapsed({ ms, className }: { ms: number | undefined; className?: string }) {
  const { expert } = useExpertMode();
  if (!expert || ms === undefined) return null;
  return <span className={cn("text-muted text-meta tabular-nums", className)}>{formatCount(ms)} ms</span>;
}
