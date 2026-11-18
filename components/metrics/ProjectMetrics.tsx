"use client";

import { Panel, PanelHeader } from "@/components/ui/Panel";
import { LoadError } from "@/components/ui/LoadError";
import { MetricChart, formatMetric } from "@/components/charts/MetricChart";
import { formatBytes } from "@/lib/format";
import { RESOURCE_ALERT_RULE, percentOf, summarize } from "@/lib/metrics-math";
import { AlertBadge, ChartsSkeleton, SamplingNote } from "./HostCharts";
import { RangePicker, useMetricRange } from "./RangePicker";
import { useMetricHistory, type MetricHistory } from "./useMetricHistory";

const ALERT = [{ value: RESOURCE_ALERT_RULE.trigger, tone: "danger" as const, label: "soglia degli avvisi" }];

/**
 * What one project (or database) has been using: CPU, memory and network over
 * the last hour, day or week.
 *
 * Standalone, with its own period and its own fetch, so it can sit wherever
 * the project page puts it. CPU is a share of the whole server, on the same
 * 0–100 axis as the server's own chart; memory is in bytes, scaled to what the
 * project uses, because a leak from 3% to 6% of the server is invisible on an
 * axis that goes to 100 and obvious on one that goes to 400 MB.
 */
export function ResourceCharts({
  scope,
  id,
  title = "Consumo di risorse",
  bare = false,
  className,
}: {
  scope: "project" | "service";
  id: string;
  title?: string;
  /** Without its own card and title, for a section that already has both. */
  bare?: boolean;
  className?: string;
}) {
  const [range, setRange] = useMetricRange();
  const { data, error, loading, stale, refresh } = useMetricHistory(scope, id, range);

  const picker = <RangePicker value={range} onChange={setRange} />;
  const header = bare ? (
    <div className="mb-3">{picker}</div>
  ) : (
    <PanelHeader title={title} description="Quanto ha usato del server, nel tempo" actions={picker} className="mb-3" />
  );
  const Frame = bare ? BareFrame : Panel;

  return (
    <Frame className={className}>
      {header}
      {!data && loading ? (
        <ChartsSkeleton count={3} />
      ) : !data ? (
        <LoadError what="lo storico" error={error ?? "Nessuna risposta"} onRetry={() => void refresh()} />
      ) : (
        <ResourceChartsView data={data} stale={stale} scope={scope} />
      )}
    </Frame>
  );
}

/** The charts of one project or database, from an answer already in hand. */
export function ResourceChartsView({
  data,
  stale = false,
  scope,
}: {
  data: MetricHistory;
  stale?: boolean;
  scope: "project" | "service";
}) {
  const s = data.series;
  const common = { t: data.t, from: data.from, to: data.to, step: data.step, range: data.range, stale, height: 88 };
  const memLast = summarize(s.mem ?? [])?.last ?? null;
  const memPctLast = summarize(s.mem_pct ?? [])?.last ?? null;
  // A limit of its own shows as a percentage that is not the share of the server.
  const limit = memLast !== null && memPctLast ? (memLast * 100) / memPctLast : null;
  const ownLimit = limit !== null && limit < data.context.memTotal * 0.95 ? limit : null;
  const hasNetwork = Boolean(s.net_rx || s.net_tx);

  if (data.t.length === 0) {
    return (
      <p className="text-muted text-sm">
        Nessun dato per questo periodo. Il pannello registra il consumo mentre il{" "}
        {scope === "project" ? "progetto" : "database"} è in esecuzione: il primo punto arriva entro un minuto
        dall&apos;avvio.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className={hasNetwork ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" : "grid gap-4 sm:grid-cols-2"}>
        <MetricChart
          {...common}
          title="CPU del server"
          unit="percent"
          series={[{ label: "CPU", values: s.cpu ?? [] }]}
          thresholds={scope === "project" ? ALERT : []}
          badge={<AlertBadge alert={data.alerts.cpu} now={data.to} />}
        />
        <MetricChart
          {...common}
          title="Memoria"
          unit="bytes"
          series={[{ label: "Memoria", values: s.mem ?? [] }]}
          current={
            memLast !== null ? (
              <>
                {formatBytes(memLast)}{" "}
                <span className="text-muted text-xs font-normal">
                  {ownLimit
                    ? `${formatMetric(memPctLast, "percent")} del limite di ${formatBytes(ownLimit)}`
                    : `${formatMetric(percentOf(memLast, data.context.memTotal), "percent")} della RAM`}
                </span>
              </>
            ) : undefined
          }
          detail={(i) => {
            const bytes = s.mem?.[i];
            return bytes != null ? `${formatMetric(percentOf(bytes, data.context.memTotal), "percent")} della RAM del server` : null;
          }}
          badge={<AlertBadge alert={data.alerts.memory} now={data.to} />}
        />
        {hasNetwork && (
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
        )}
      </div>
      <SamplingNote data={data} />
    </div>
  );
}

function BareFrame({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}

/** The project page's charts. */
export function ProjectMetrics({ projectId, className }: { projectId: string; className?: string }) {
  return <ResourceCharts scope="project" id={projectId} className={className} />;
}
