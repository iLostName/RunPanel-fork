"use client";

import { useCallback, useState } from "react";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorDetail, LoadError } from "@/components/ui/LoadError";
import { refusalNote } from "@/lib/error-text";
import { Segmented } from "@/components/ui/Segmented";
import { Technical } from "@/components/ui/Technical";
import { HostCharts } from "@/components/metrics/HostCharts";
import { RangePicker, useMetricRange } from "@/components/metrics/RangePicker";
import { formatMetric } from "@/components/charts/MetricChart";
import MonitorLoading from "./loading";
import { monitorDescription } from "./_components/copy";
import { formatBytes, formatUptime } from "@/lib/format";
import { percentOf, type UsageSort } from "@/lib/metrics-math";
import { useNode, useServerHref } from "@/lib/hooks/useNode";
import { ServerFilter } from "@/components/cluster/ServerBits";
import { Hint } from "@/components/ui/Hint";
import type { PerServer } from "@/lib/cluster-merge";
import { ProjectTable, StandaloneServices, type HostScale } from "./_components/ProcessTable";
import { OtherContainers } from "./_components/OtherContainers";
import type { MonitorData } from "./_components/types";

const SORTS = [
  { value: "name" as const, label: "Nome" },
  { value: "cpu" as const, label: "CPU" },
  { value: "memory" as const, label: "Memoria" },
];

/** The machine in one line, under its charts: the same numbers the charts end on, in words. */
function HostSummary({ server }: { server: MonitorData["server"] }) {
  const memPct = percentOf(server.memory.used, server.memory.total);
  const diskPct = server.disk?.total ? percentOf(server.disk.used, server.disk.total) : null;
  return (
    <p className="text-muted flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
      <span className="flex items-center gap-1.5">
        <Icon icon="solar:cpu-linear" width={14} aria-hidden />
        CPU <span className="text-foreground">{formatMetric(server.cpu, "percent")}</span>
        <Technical>
          <span>
            · {server.cores ?? "?"} core
            {server.loadAverage ? ` · carico ${server.loadAverage.map((l) => l.toFixed(2)).join(" ")}` : ""}
          </span>
        </Technical>
      </span>
      <span className="flex items-center gap-1.5">
        <Icon icon="solar:server-linear" width={14} aria-hidden />
        Memoria{" "}
        <span className="text-foreground">
          {formatBytes(server.memory.used)} di {formatBytes(server.memory.total)}
          {memPct !== null ? ` (${formatMetric(memPct, "percent")})` : ""}
        </span>
      </span>
      {server.disk && server.disk.total > 0 && (
        <span className="flex items-center gap-1.5">
          <Icon icon="solar:ssd-square-linear" width={14} aria-hidden />
          Disco{" "}
          <span className="text-foreground">
            {formatBytes(server.disk.used)} di {formatBytes(server.disk.total)}
            {diskPct !== null ? ` (${formatMetric(diskPct, "percent")})` : ""}
          </span>
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <Icon icon="solar:clock-circle-linear" width={14} aria-hidden />
        Acceso da <span className="text-foreground">{formatUptime(server.uptime)}</span>
      </span>
    </p>
  );
}

/** One server: its history, then what runs on it, then what runs on it without the panel. */
function HostMonitor({
  data,
  memberId,
  range,
  sort,
  link,
  collapsed,
  toggle,
  keyPrefix,
}: {
  data: MonitorData;
  /** The server for the charts; undefined is the one the page is about. */
  memberId?: string | null;
  range: ReturnType<typeof useMetricRange>[0];
  sort: UsageSort;
  link: (href: string) => string;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  keyPrefix: string;
}) {
  const host: HostScale = { cores: Math.max(1, data.server.cores ?? 1), memTotal: data.server.memory.total };
  return (
    <div className="space-y-4">
      <HostCharts range={range} memberId={memberId} />
      <HostSummary server={data.server} />

      <div>
        <h2 className="text-foreground mb-2 text-sm font-semibold">Cosa gira su questo server</h2>
        <ProjectTable
          data={data}
          host={host}
          sort={sort}
          link={link}
          collapsed={collapsed}
          toggle={toggle}
          keyPrefix={keyPrefix}
        />
        <StandaloneServices services={data.services ?? []} host={host} sort={sort} link={link} />
        <OtherContainers containers={data.others ?? []} host={host} sort={sort} />
      </div>
    </div>
  );
}

export default function MonitorPage() {
  const href = useServerHref();
  const { isSolo, serverParam, selfId } = useNode();
  const poll3000 = usePollInterval(3000);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [range, setRange] = useMetricRange();
  const [sort, setSort] = useState<UsageSort>("name");

  // Polls, but stops while the tab is hidden — this endpoint inspects
  // containers, so an idle background tab was doing real work on the host
  // every three seconds forever. In a cluster the panel asks every server.
  const solo = useResource<MonitorData>(isSolo ? "/api/monitor" : null, { intervalMs: poll3000 });
  const cluster = useResource<{ servers: PerServer<MonitorData>[] }>(isSolo ? null : "/api/cluster/monitor", {
    intervalMs: Math.max(poll3000, 5000),
  });

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const description = monitorDescription(isSolo);
  const loading = isSolo ? solo.loading && !solo.data : cluster.loading && !cluster.data;
  if (loading) return <MonitorLoading />;

  // One row of controls above everything they scope: the period of every
  // chart, the order of every list, on every server of the page.
  const controls = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <RangePicker value={range} onChange={setRange} />
      <div className="flex items-center gap-2">
        <span className="text-muted text-xs">Ordina per</span>
        <Segmented value={sort} onChange={setSort} options={SORTS} label="Ordina i processi per" />
      </div>
    </div>
  );

  if (isSolo) {
    if (!solo.data) {
      return (
        <>
          <PageHeader title="Monitor" description={description} />
          <LoadError what="il monitor" error={solo.error ?? "Nessuna risposta"} onRetry={() => void solo.refresh()} />
        </>
      );
    }
    return (
      <>
        <PageHeader title="Monitor" description={description} />
        {controls}
        <HostMonitor
          data={solo.data}
          range={range}
          sort={sort}
          link={(h) => h}
          collapsed={collapsed}
          toggle={toggle}
          keyPrefix=""
        />
      </>
    );
  }

  const servers = (cluster.data?.servers ?? []).filter((s) => !serverParam || s.memberId === serverParam);
  return (
    <>
      <PageHeader title="Monitor" description={description} actions={<ServerFilter />} />
      {controls}
      {!cluster.data && cluster.error ? (
        <LoadError what="il monitor" error={cluster.error} onRetry={() => void cluster.refresh()} />
      ) : (
        <div className="space-y-10">
          {servers.map((server) => (
            <section key={server.memberId} aria-label={`Server ${server.memberName}`}>
              <h2 className="text-foreground mb-3 flex items-center gap-2 text-sm font-semibold">
                <Icon icon="solar:server-2-linear" width={16} className="text-muted" aria-hidden />
                {server.memberName}
                {server.memberId === selfId && <span className="text-muted font-normal">(questo)</span>}
              </h2>
              {server.data ? (
                <HostMonitor
                  data={server.data}
                  memberId={server.memberId}
                  range={range}
                  sort={sort}
                  link={(h) => href(h, server.memberId)}
                  collapsed={collapsed}
                  toggle={toggle}
                  keyPrefix={`${server.memberId}:`}
                />
              ) : (
                <Hint tone={server.reachable ? "info" : "warn"}>
                  {server.reachable
                    ? `Il monitor di ${server.memberName} non è disponibile per il tuo account${refusalNote(server.error)}.`
                    : `${server.memberName} non raggiungibile.`}
                  {!server.reachable && <ErrorDetail detail={server.error} />}
                </Hint>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
