"use client";

import { Panel } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Technical } from "@/components/ui/Technical";
import { MetricChart, formatMetric } from "@/components/charts/MetricChart";
import { formatBytes } from "@/lib/format";
import { RESOURCE_ALERT_RULE, summarize, type MetricRange } from "@/lib/metrics-math";
import { shortDuration } from "@/lib/uptime-math";
import { useMetricHistory, type MetricHistory } from "./useMetricHistory";

const ALERT = [{ value: RESOURCE_ALERT_RULE.trigger, tone: "danger" as const, label: "soglia degli avvisi" }];
const DISK_FULL = [{ value: 90, tone: "warning" as const, label: "disco quasi pieno" }];

/** "Sopra il 90% da 7 min": the alarm standing right now, next to the chart it is about. */
export function AlertBadge({ alert, now }: { alert?: { since: number } | null; now: number }) {
  if (!alert) return null;
  return (
    <Badge tone="danger" icon="solar:danger-triangle-linear">
      Sopra il {RESOURCE_ALERT_RULE.trigger}% da {shortDuration(now - alert.since)}
    </Badge>
  );
}

/** Where the samples come from, for whoever wants to know how much to trust a line. */
export function SamplingNote({ data }: { data: MetricHistory }) {
  return (
    <Technical>
      <p className="text-muted text-meta leading-relaxed">
        Un campione ogni {Math.round(data.sampling.intervalMs / 1000)} s, tenuto per un&apos;ora; poi medie di 1 minuto per 24
        ore e di 15 minuti per 30 giorni. La CPU è la quota dell&apos;intero server ({data.context.cores} core): un processo che
        occupa un core intero vale {formatMetric(100 / data.context.cores, "percent")}.
      </p>
    </Technical>
  );
}

export function ChartsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonBlock key={i} className="h-48" />
      ))}
    </div>
  );
}

/**
 * The machine over time: CPU, memory, disk and network, the four numbers the
 * Panoramica shows as they are now. For the Monitor; `memberId` draws another
 * server of the cluster.
 */
export function HostCharts({ range, memberId }: { range: MetricRange; memberId?: string | null }) {
  const { data, error, loading, stale, refresh } = useMetricHistory("host", null, range, { memberId });

  if (!data && loading) return <ChartsSkeleton />;
  if (!data) return <LoadError what="lo storico del server" error={error ?? "Nessuna risposta"} onRetry={() => void refresh()} />;
  return <HostChartsView data={data} stale={stale} />;
}

/** The charts themselves, from an answer already in hand. */
export function HostChartsView({ data, stale = false }: { data: MetricHistory; stale?: boolean }) {
  const s = data.series;
  const common = { t: data.t, from: data.from, to: data.to, step: data.step, range: data.range, stale };
  const memLast = summarize(s.mem ?? [])?.last ?? null;
  const diskLast = summarize(s.disk ?? [])?.last ?? null;
  const hasNetwork = Boolean(s.net_rx || s.net_tx);

  return (
    <div className="space-y-2">
      {!data.sampling.collecting && (
        <Hint>
          Su questo server lo storico non viene raccolto, quindi i grafici restano vuoti.
          <Technical> I timer di fondo sono spenti (RUNPANEL_DISABLE_SCHEDULERS).</Technical>
        </Hint>
      )}

      <div className={hasNetwork ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-4" : "grid gap-3 sm:grid-cols-3"}>
        <Panel padding="compact">
          <MetricChart
            {...common}
            title="CPU"
            unit="percent"
            series={[{ label: "CPU", values: s.cpu ?? [] }]}
            thresholds={ALERT}
            badge={<AlertBadge alert={data.alerts.cpu} now={data.to} />}
          />
        </Panel>
        <Panel padding="compact">
          <MetricChart
            {...common}
            title="Memoria"
            unit="percent"
            series={[{ label: "Memoria", values: s.mem_pct ?? [] }]}
            thresholds={ALERT}
            current={
              memLast !== null ? (
                <>
                  {formatMetric(summarize(s.mem_pct ?? [])?.last, "percent")}{" "}
                  <span className="text-muted text-xs font-normal">
                    {formatBytes(memLast)} di {formatBytes(data.context.memTotal)}
                  </span>
                </>
              ) : undefined
            }
            detail={(i) => (s.mem?.[i] != null ? `${formatBytes(s.mem[i])} di ${formatBytes(data.context.memTotal)}` : null)}
            badge={<AlertBadge alert={data.alerts.memory} now={data.to} />}
          />
        </Panel>
        <Panel padding="compact">
          <MetricChart
            {...common}
            title="Disco"
            unit="percent"
            series={[{ label: "Disco", values: s.disk_pct ?? [] }]}
            thresholds={DISK_FULL}
            current={
              diskLast !== null ? (
                <>
                  {formatMetric(summarize(s.disk_pct ?? [])?.last, "percent")}{" "}
                  <span className="text-muted text-xs font-normal">
                    {formatBytes(diskLast)}
                    {data.context.diskTotal ? ` di ${formatBytes(data.context.diskTotal)}` : ""}
                  </span>
                </>
              ) : undefined
            }
            detail={(i) => (s.disk?.[i] != null ? `${formatBytes(s.disk[i])} occupati` : null)}
          />
        </Panel>
        {hasNetwork && (
          <Panel padding="compact">
            <MetricChart
              {...common}
              title="Rete"
              unit="rate"
              series={[
                { label: "Ricevuti", values: s.net_rx ?? [] },
                { label: "Inviati", values: s.net_tx ?? [], tone: "muted" },
              ]}
              current={formatMetric(summarize(s.net_rx ?? [])?.last, "rate")}
            />
          </Panel>
        )}
      </div>

      <SamplingNote data={data} />
    </div>
  );
}
