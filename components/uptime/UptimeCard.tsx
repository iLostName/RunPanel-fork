"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Advanced, Technical } from "@/components/ui/Technical";
import { MetricChart } from "@/components/charts/MetricChart";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";
import type { SeriesPayload } from "@/lib/metrics-math";
import {
  UPTIME_INTERVAL_MS,
  causeLabel,
  durationWords,
  formatUptimePercent,
  shortDuration,
} from "@/lib/uptime-math";

interface Incident {
  id: string;
  startedAt: string;
  endedAt: string | null;
  cause: string | null;
  resolution: string | null;
  durationMs: number | null;
}

/** What `/api/projects/{id}/uptime` answers. */
export interface UptimeData {
  now: number;
  watch: {
    active: boolean;
    skip: "disabled" | "no-port" | "not-running" | null;
    path: string;
    port: number | null;
    expectStatus: number[];
    intervalMs: number;
    timeoutMs: number;
    downAfter: number;
    upAfter: number;
    checking: boolean;
  };
  up24h: number | null;
  up30d: number | null;
  checks24h: number;
  latency24h: number | null;
  last: { at: number; ok: boolean; latencyMs: number | null } | null;
  since: { at: number; atLeast: boolean } | null;
  days: { day: number; ratio: number | null }[];
  series: SeriesPayload;
  open: Incident | null;
  incidents: Incident[];
}

/**
 * The browser's offset, read once when the module loads rather than during a
 * render: the thirty bars are the reader's days, and the server is told which.
 */
const TZ = typeof window === "undefined" ? 0 : new Date().getTimezoneOffset();

const WHEN = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const TIME = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "short" });

const SKIP_TEXT: Record<"disabled" | "no-port" | "not-running", string> = {
  disabled: "Il controllo è spento, perché il controllo di salute di questo progetto è disattivato nelle impostazioni del deploy.",
  "no-port": "Questo progetto non ha una porta, quindi non c'è una pagina da chiedere: succede con bot, worker e code.",
  "not-running": "Il progetto non è in esecuzione: il controllo riprende quando riparte.",
};

type Tone = "success" | "warning" | "danger" | "neutral";
const DOT: Record<Tone, string> = { success: "bg-success", warning: "bg-warning", danger: "bg-danger", neutral: "bg-muted/50" };

/** The tone of a day's bar: a single failed check is not a red day. */
function dayTone(ratio: number | null): string {
  if (ratio === null) return "bg-default";
  if (ratio >= 0.9995) return "bg-success";
  if (ratio >= 0.99) return "bg-warning";
  return "bg-danger";
}

function headline(data: UptimeData): { tone: Tone; text: string; sub?: string } {
  if (!data.watch.active) {
    return { tone: "neutral", text: "Controllo non attivo", sub: data.watch.skip ? SKIP_TEXT[data.watch.skip] : undefined };
  }
  if (data.open) {
    return {
      tone: "danger",
      text: `L'app non risponde da ${durationWords(data.now - Date.parse(data.open.startedAt))}`,
      sub: causeLabel(data.open.cause, data.watch.timeoutMs),
    };
  }
  if (!data.last) {
    return { tone: "neutral", text: "In attesa del primo controllo", sub: "Il pannello chiede all'app di rispondere una volta al minuto." };
  }
  if (!data.last.ok) {
    return { tone: "warning", text: "L'ultimo controllo non ha avuto risposta", sub: "Riprovo tra un minuto: due risposte mancate di fila aprono un incidente." };
  }
  const since = data.since ? `${data.since.atLeast ? "da più di" : "da"} ${durationWords(data.now - data.since.at)}` : "";
  const day = data.up24h !== null ? ` · ${formatUptimePercent(data.up24h)} nelle ultime 24 ore` : "";
  return { tone: "success", text: `L'app risponde${since ? ` ${since}` : ""}${day}` };
}

function IncidentRow({ incident, now, timeoutMs }: { incident: Incident; now: number; timeoutMs: number }) {
  const start = Date.parse(incident.startedAt);
  const end = incident.endedAt ? Date.parse(incident.endedAt) : null;
  const sameDay = end !== null && new Date(start).toDateString() === new Date(end).toDateString();
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-xs">
      <span className={cn("size-1.5 shrink-0 self-center rounded-full", end === null ? "bg-danger animate-pulse" : "bg-muted/60")} aria-hidden />
      <span className="text-foreground tabular-nums">
        {WHEN.format(start)} → {end === null ? "in corso" : sameDay ? TIME.format(end) : WHEN.format(end)}
      </span>
      <span className="text-muted">{shortDuration(incident.durationMs ?? now - start)}</span>
      <span className="text-muted min-w-0">· {causeLabel(incident.cause, timeoutMs)}</span>
      {incident.resolution === "paused" && <span className="text-muted">· controllo sospeso, il progetto si è fermato</span>}
    </li>
  );
}

/**
 * "Does the app answer?", for the project page.
 *
 * One sentence first — "L'app risponde da 12 giorni · 99,98% nelle ultime 24
 * ore" — because that is the question; then the last thirty days as a strip,
 * and the incidents with their start, end and cause. The response times and the
 * mechanics (what is asked, how often, after how many failures) are folded
 * under Avanzate, open by default in expert mode.
 */
export function UptimeCard({ projectId, className }: { projectId: string; className?: string }) {
  const api = useNodeApi();
  const { data, error, loading, refresh } = useResource<UptimeData>(api(`/api/projects/${projectId}/uptime?tz=${TZ}`), {
    intervalMs: UPTIME_INTERVAL_MS,
  });

  if (!data && loading) return <SkeletonBlock className={cn("h-28", className)} />;
  if (!data) {
    return (
      <LoadError what="il controllo dell'app" error={error ?? "Nessuna risposta"} onRetry={() => void refresh()} className={className} />
    );
  }
  return <UptimeView data={data} className={className} />;
}

/** The card itself, from an answer already in hand. */
export function UptimeView({ data, className }: { data: UptimeData; className?: string }) {
  const [showAll, setShowAll] = useState(false);
  const head = headline(data);
  const hasHistory = data.days.some((d) => d.ratio !== null) || data.incidents.length > 0;
  // A project that is not running and never was checked has nothing to say
  // here: its header already says it is stopped, and a never-deployed one has
  // a page of its own about what to do first.
  if (!data.watch.active && data.watch.skip === "not-running" && !hasHistory) return null;
  const incidents = showAll ? data.incidents : data.incidents.slice(0, 3);
  const goodDays = data.days.filter((d) => d.ratio !== null && d.ratio >= 0.9995).length;
  const badDays = data.days.filter((d) => d.ratio !== null && d.ratio < 0.9995).length;

  return (
    <Panel className={className}>
      <section aria-label="Controllo che l'app risponda" className="space-y-4">
        <div className="flex items-start gap-3">
          <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", DOT[head.tone], head.tone === "danger" && "animate-pulse")} aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium" role="status">
              {head.text}
            </p>
            {head.sub && <p className="text-muted mt-0.5 text-xs leading-relaxed">{head.sub}</p>}
          </div>
          {data.watch.active && (
            <Technical>
              <span className="text-muted shrink-0 font-mono text-meta">
                GET {data.watch.path} :{data.watch.port}
              </span>
            </Technical>
          )}
        </div>

        {hasHistory && (
          <>
            <dl className="grid grid-cols-3 gap-3">
              <div>
                <dt className="text-muted text-meta">Ultime 24 ore</dt>
                <dd className="text-foreground text-sm font-semibold">{formatUptimePercent(data.up24h)}</dd>
              </div>
              <div>
                <dt className="text-muted text-meta">Ultimi 30 giorni</dt>
                <dd className="text-foreground text-sm font-semibold">{formatUptimePercent(data.up30d)}</dd>
              </div>
              <div>
                <dt className="text-muted text-meta">Risposta media</dt>
                <dd className="text-foreground text-sm font-semibold">
                  {data.latency24h !== null ? `${Math.round(data.latency24h)} ms` : "—"}
                </dd>
              </div>
            </dl>

            <div>
              <div
                className="flex h-6 items-stretch gap-0.5"
                role="img"
                aria-label={`Ultimi 30 giorni: ${goodDays} senza interruzioni, ${badDays} con qualche risposta mancata, ${
                  data.days.length - goodDays - badDays
                } senza controlli.`}
              >
                {data.days.map((d) => (
                  <span
                    key={d.day}
                    className={cn("min-w-0 flex-1 rounded-sm", dayTone(d.ratio))}
                    title={`${DAY.format(d.day)}: ${d.ratio === null ? "nessun controllo" : formatUptimePercent(d.ratio)}`}
                  />
                ))}
              </div>
              <div className="text-muted mt-1 flex justify-between text-meta" aria-hidden>
                <span>30 giorni fa</span>
                <span>oggi</span>
              </div>
            </div>

            {data.incidents.length > 0 ? (
              <div>
                <h3 className="text-muted text-meta font-medium">Incidenti recenti</h3>
                <ul className="divide-border divide-y">
                  {incidents.map((incident) => (
                    <IncidentRow key={incident.id} incident={incident} now={data.now} timeoutMs={data.watch.timeoutMs} />
                  ))}
                </ul>
                {data.incidents.length > 3 && (
                  <Button size="sm" variant="ghost" className="mt-1" onPress={() => setShowAll((v) => !v)}>
                    {showAll ? "Mostra meno" : `Mostra tutti (${data.incidents.length})`}
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-muted flex items-center gap-1.5 text-xs">
                <Icon icon="solar:check-circle-linear" width={14} className="text-success" aria-hidden />
                Nessun incidente negli ultimi 30 giorni.
              </p>
            )}
          </>
        )}

        {(data.watch.active || hasHistory) && (
          <Advanced summary="tempi di risposta, come funziona il controllo">
            <MetricChart
              title="Tempo di risposta, ultime 24 ore"
              t={data.series.t}
              from={data.series.from}
              to={data.series.to}
              step={data.series.step}
              range="24h"
              unit="ms"
              height={80}
              // The last answer, not the last value on the line: an app that has
              // stopped answering has no response time.
              current={
                data.last ? (data.last.ok && data.last.latencyMs !== null ? `${data.last.latencyMs} ms` : "nessuna risposta") : undefined
              }
              series={[{ label: "Risposta", values: data.series.series.latency ?? [] }]}
              emptyText="Ancora nessuna risposta registrata nelle ultime 24 ore."
            />
            <p className="text-muted text-xs leading-relaxed">
              Ogni {Math.round(data.watch.intervalMs / 1000)} secondi il pannello chiede{" "}
              <code className="font-mono">{data.watch.path}</code>
              {data.watch.port ? (
                <>
                  {" "}
                  sulla porta <code className="font-mono">{data.watch.port}</code>
                </>
              ) : null}{" "}
              e aspetta al massimo {Math.round(data.watch.timeoutMs / 1000)} secondi.{" "}
              {data.watch.expectStatus.length > 0
                ? `Conta come risposta solo lo stato ${data.watch.expectStatus.join(" o ")}.`
                : "Conta come risposta qualsiasi stato tranne gli errori del server (5xx)."}{" "}
              Dopo {data.watch.downAfter} risposte mancate di fila si apre un incidente e arriva una notifica; si chiude dopo{" "}
              {data.watch.upAfter} risposte, e la notifica di ritorno parte quando l&apos;app risponde da qualche minuto senza
              interruzioni. Il percorso e la porta sono quelli del controllo di salute del deploy.
            </p>
            <Technical>
              <p className="text-muted text-meta">
                {data.checks24h} controlli nelle ultime 24 ore
                {data.last ? ` · ultimo alle ${TIME.format(data.last.at)}${data.last.latencyMs !== null ? `, ${data.last.latencyMs} ms` : ""}` : ""}
                {!data.watch.checking ? " · i timer di fondo sono spenti su questo server (RUNPANEL_DISABLE_SCHEDULERS)" : ""}
              </p>
            </Technical>
          </Advanced>
        )}
      </section>
    </Panel>
  );
}
