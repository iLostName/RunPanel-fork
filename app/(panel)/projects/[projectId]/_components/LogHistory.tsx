"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { LoadError } from "@/components/ui/LoadError";
import { Code } from "@/components/ui/Hint";
import { Technical } from "@/components/ui/Technical";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { formatBytes, formatWhen } from "@/lib/format";
import type { LogEntry, LogStream } from "@/lib/log-search";

/** What `GET /api/projects/:id/logs/app` answers. */
interface AppLogPage {
  entries: LogEntry[];
  more: boolean;
  stored: { bytes: number; files: number; since: string | null };
  retention: { fileBytes: number; files: number };
  runtime: "native" | "docker" | "compose";
}

const FIRST_PAGE = 500;
const MAX_LINES = 5000;

/**
 * The app's saved output, searched on the server.
 *
 * The live view holds the current run as the browser received it. This is the
 * panel's copy, which goes back past restarts and deploys — so the search runs
 * where the whole of it is, and only the matching lines travel.
 */
export function LogHistory({ projectId, query, stream }: { projectId: string; query: string; stream: "all" | LogStream }) {
  const api = useNodeApi();
  const [limit, setLimit] = useState(FIRST_PAGE);
  const search = useDebounced(query.trim(), 350);

  const params = new URLSearchParams({ lines: String(limit) });
  if (search) params.set("q", search);
  if (stream !== "all") params.set("stream", stream);
  const { data, loading, error, refresh, refreshing } = useResource<AppLogPage>(
    api(`/api/projects/${projectId}/logs/app?${params.toString()}`)
  );

  // Counted from the end, so the newest lines keep their keys when older ones
  // are loaded in front of them.
  const lines: LogLine[] = useMemo(() => {
    const entries = data?.entries ?? [];
    return entries.map((entry, i) => ({ id: entries.length - i, text: `${formatTime(entry.at)}  ${entry.text}`, stream: entry.stream }));
  }, [data]);

  if (error && !data) return <LoadError what="i log salvati" error={error} onRetry={() => void refresh()} />;
  if (!data && loading) return <SkeletonBlock className="h-[320px] sm:h-[440px]" />;

  const filtered = Boolean(search) || stream !== "all";
  const empty = filtered
    ? search
      ? `Nessuna riga salvata contiene «${search}».`
      : stream === "stderr"
        ? "Nessun errore fra le righe salvate."
        : "Nessuna riga di output fra le righe salvate."
    : "Ancora niente di salvato. RunPanel conserva quello che l'app scrive mentre gira, anche dopo un riavvio o un nuovo deploy.";
  const budget = data ? data.retention.fileBytes * data.retention.files : 0;

  return (
    <div className="space-y-2">
      <LogViewer
        lines={lines}
        highlight={search || undefined}
        className="h-[320px] sm:h-[440px]"
        ariaLabel="Log salvati dell'app"
        emptyMessage={query.trim() !== search ? "Cerco…" : empty}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {data && data.stored.bytes > 0 && (
          <p className="text-muted min-w-0 flex-1 text-meta">
            {`Salvati ${formatBytes(data.stored.bytes)} su ${formatBytes(budget)}`}
            {data.stored.since ? `, dal ${formatWhen(data.stored.since)}` : ""}. I più vecchi vengono cancellati da soli.
          </p>
        )}
        <div className="ml-auto flex items-center gap-2">
          {data?.more && limit < MAX_LINES && (
            <Button size="sm" variant="ghost" onPress={() => setLimit((current) => Math.min(MAX_LINES, current * 4))}>
              Mostra righe più vecchie
            </Button>
          )}
          <Button size="sm" variant="ghost" isPending={refreshing} onPress={() => void refresh()}>
            <Icon icon="solar:refresh-linear" width={15} aria-hidden />
            Aggiorna
          </Button>
        </div>
      </div>

      <Technical>
        <p className="text-muted text-meta leading-relaxed">
          Archivio nella cartella dati del pannello, in <Code>logs/apps/{projectId}</Code>: {data?.retention.files ?? 5} file da{" "}
          {formatBytes(data?.retention.fileBytes ?? 4 * 1024 * 1024)}, ruotati per dimensione.{" "}
          {data?.runtime === "native"
            ? "I file di PM2 vengono letti ogni 10 secondi: l'ora è quella della lettura."
            : data?.runtime === "compose"
              ? "Letto con docker compose logs ogni 30 secondi: stdout e stderr arrivano insieme e le righe perdono il rientro."
              : "Letto con docker logs ogni 30 secondi, con l'ora scritta da Docker e stdout/stderr separati."}{" "}
          Prima di ogni riavvio dal pannello viene letto ancora una volta.
        </p>
      </Technical>
    </div>
  );
}

/** `value`, once it has stopped changing for `ms`: one search per pause in typing, not per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Today's lines by the time alone, older ones with their day. */
function formatTime(at: string | null): string {
  if (!at) return "--:--:--";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const time = date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })} ${time}`;
}
