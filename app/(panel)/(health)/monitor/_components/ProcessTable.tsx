"use client";

import { memo } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { InfoTip } from "@/components/ui/Tooltip";
import { formatMetric } from "@/components/charts/MetricChart";
import { useExpertMode } from "@/components/Providers";
import { statusMeta, TONE_DOT, type StatusTone } from "@/lib/status";
import { formatBytes, formatUptime } from "@/lib/format";
import { percentOf, shareOfHost, sortByUsage, type UsageSort } from "@/lib/metrics-math";
import { runtimeLabel, engineLabel } from "@/lib/labels";
import { serviceDisplayName } from "@/lib/service-name";
import { cn } from "@/lib/utils";
import type { MonitorData, ProjectInfo, ServiceInfo, StackContainer } from "./types";

/** What a row's numbers are measured against: the machine it runs on. */
export interface HostScale {
  cores: number;
  memTotal: number;
}

/** Docker's states, in the panel's words and colours. */
const CONTAINER_STATE: Record<string, { tone: StatusTone; label: string }> = {
  running: { tone: "success", label: "In esecuzione" },
  paused: { tone: "warning", label: "In pausa" },
  restarting: { tone: "warning", label: "Si sta riavviando" },
  exited: { tone: "neutral", label: "Fermo" },
  created: { tone: "neutral", label: "Creato, mai avviato" },
  dead: { tone: "danger", label: "Non recuperabile" },
};

export function containerState(state: string): { tone: StatusTone; label: string } {
  return CONTAINER_STATE[state] ?? { tone: "neutral", label: state };
}

/**
 * One row, for a project, a service or a container.
 *
 * A single responsive layout, not a desktop table plus a mobile card list. The
 * previous version rendered both and hid one with `hidden sm:block`, so every
 * row existed twice in the DOM and was re-rendered twice on every 3-second
 * poll.
 *
 * The numbers are against the host: CPU as a share of the whole machine — the
 * same axis as the charts above, where Docker's own "150%" would be off the
 * scale — and memory with its share of the RAM next to it. The raw figure
 * Docker prints is in the tooltip, for whoever is used to it.
 */
export const Row = memo(function Row({
  label,
  sublabel,
  technical,
  tone,
  stateLabel,
  pulse,
  cpu,
  memory,
  uptime,
  host,
  href,
  nested,
  onToggle,
  collapsed,
  toggleLabel,
}: {
  label: string;
  sublabel?: string;
  /** Shown in expert mode only, after the sublabel: a port, a container name. */
  technical?: string;
  tone: StatusTone;
  stateLabel: string;
  pulse?: boolean;
  /** Percent of one core. */
  cpu?: number;
  memory?: number;
  uptime?: number;
  host: HostScale;
  href?: string;
  nested?: boolean;
  onToggle?: () => void;
  collapsed?: boolean;
  toggleLabel?: string;
}) {
  const { expert } = useExpertMode();
  const share = shareOfHost(cpu, host.cores);
  const memShare = percentOf(memory, host.memTotal);

  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone], pulse && "animate-pulse")} aria-hidden />
        <span className="sr-only">{stateLabel}:</span>
        <span className="text-foreground truncate text-sm">{label}</span>
        {(sublabel || (expert && technical)) && (
          <span className="text-muted hidden truncate text-xs sm:inline">
            {sublabel}
            {expert && technical ? <span className="font-mono">{sublabel ? ` · ${technical}` : technical}</span> : null}
          </span>
        )}
      </div>

      {/* Numbers stay on one line on every width: tabular figures and fixed
          columns, so the values do not jitter as they update. On a phone they
          are that line, under the name and named, so the name has the width:
          beside two columns of figures it was cut to "gestionale-mag…". */}
      <div className="text-muted flex shrink-0 items-center gap-3 font-mono text-xs tabular-nums max-sm:basis-full max-sm:pl-3.5 sm:gap-5">
        <span className="w-14 text-right max-sm:w-auto max-sm:text-left" title={cpu != null ? `${cpu.toFixed(1)}% di un core` : undefined}>
          <span className="font-sans sm:hidden">CPU </span>
          {formatMetric(share, "percent")}
        </span>
        <span className="w-28 text-right max-sm:w-auto max-sm:text-left">
          <span className="font-sans sm:hidden">RAM </span>
          {formatBytes(memory)}
          {memShare !== null && <span className="text-muted/70"> · {formatMetric(memShare, "percent")}</span>}
        </span>
        <span className="hidden w-16 text-right sm:inline">{formatUptime(uptime)}</span>
      </div>
    </>
  );

  const className = cn(
    "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors max-sm:flex-wrap max-sm:gap-y-0.5",
    nested ? "pl-8" : "",
    (href || onToggle) && "hover:bg-surface-hover"
  );

  // The arrow opens what is inside, the row opens the project: a project with
  // services used to be the one row of this page that led nowhere.
  if (onToggle) {
    return (
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          className="text-muted hover:bg-surface-hover hover:text-foreground shrink-0 pr-1 pl-3 transition-colors"
        >
          <Icon icon={collapsed ? "solar:alt-arrow-right-linear" : "solar:alt-arrow-down-linear"} width={14} aria-hidden />
        </button>
        {href ? (
          <Link href={href} className={cn(className, "min-w-0 flex-1 pl-1")}>
            {content}
          </Link>
        ) : (
          <div className={cn(className, "min-w-0 flex-1 pl-1")}>{content}</div>
        )}
      </div>
    );
  }

  if (href) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
});

/** The column heads, with what the CPU column is a share of. */
export function TableHead({ first }: { first: string }) {
  return (
    <div className="text-muted flex items-center gap-3 px-3 py-2 text-meta font-medium">
      <span className="flex-1">{first}</span>
      {/* On a phone the figures are a line of each row, named there. */}
      <span className="flex shrink-0 gap-3 sm:gap-5">
        <span className="flex w-14 items-center justify-end gap-0.5 max-sm:w-auto">
          CPU<span className="sm:hidden">&nbsp;e RAM</span>
          <InfoTip title="CPU del server">
            La quota di tutto il server: 100% vuol dire tutti i core occupati. Docker e PM2 contano invece un core alla volta,
            per cui un processo che ne occupa uno intero qui vale 100 diviso il numero dei core.
          </InfoTip>
        </span>
        <span className="w-28 text-right max-sm:hidden">RAM (% del server)</span>
        <span className="hidden w-16 text-right sm:inline">Uptime</span>
      </span>
    </div>
  );
}

function sorted<T>(items: readonly T[], sort: UsageSort, read: (item: T) => { name: string; cpu?: number; memory?: number }): T[] {
  return sortByUsage(
    items.map((item) => ({ item, ...read(item) })),
    sort
  ).map((entry) => entry.item);
}

function ServiceRow({ service, host, link, nested }: { service: ServiceInfo; host: HostScale; link: (href: string) => string; nested?: boolean }) {
  const meta = statusMeta(service.status);
  return (
    <Row
      nested={nested}
      label={serviceDisplayName(service)}
      sublabel={engineLabel(service.type)}
      technical={`:${service.port}`}
      tone={meta.tone}
      stateLabel={meta.label}
      pulse={meta.active}
      cpu={service.cpu}
      memory={service.memory}
      uptime={service.uptime}
      host={host}
      href={link(`/services/${service.id}`)}
    />
  );
}

function ContainerRow({ container, host }: { container: StackContainer; host: HostScale }) {
  const state = containerState(container.state);
  return (
    <Row
      nested
      label={container.service}
      sublabel="container"
      technical={container.name}
      tone={state.tone}
      stateLabel={state.label}
      cpu={container.cpu}
      memory={container.memory}
      host={host}
    />
  );
}

/** Projects with what runs inside them, in the order asked for. */
export function ProjectTable({
  data,
  host,
  sort,
  link,
  collapsed,
  toggle,
  keyPrefix,
}: {
  data: MonitorData;
  host: HostScale;
  sort: UsageSort;
  link: (href: string) => string;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  keyPrefix: string;
}) {
  if (data.projects.length === 0) {
    if ((data.services ?? []).length > 0) return null;
    return (
      <Panel>
        <EmptyState
          icon="solar:widget-2-linear"
          title="Nessun progetto"
          description="I progetti creati compariranno qui con i loro processi e servizi."
        />
      </Panel>
    );
  }

  const projects = sorted(data.projects, sort, (p: ProjectInfo) => ({ name: p.name, cpu: p.process?.cpu, memory: p.process?.memory }));

  return (
    <Panel padding="flush" className="divide-border divide-y overflow-hidden">
      <TableHead first="Progetto" />
      {projects.map((project) => {
        const key = `${keyPrefix}${project.id}`;
        const isCollapsed = collapsed.has(key);
        const containers = sorted(project.containers ?? [], sort, (c: StackContainer) => ({ name: c.service, cpu: c.cpu, memory: c.memory }));
        const services = sorted(project.services, sort, (s: ServiceInfo) => ({ name: serviceDisplayName(s), cpu: s.cpu, memory: s.memory }));
        const hasChildren = containers.length > 0 || services.length > 0;
        const meta = statusMeta(project.status);
        const inside = [
          containers.length > 0 ? `${containers.length} container` : null,
          services.length > 0 ? (services.length === 1 ? "1 servizio" : `${services.length} servizi`) : null,
        ]
          .filter(Boolean)
          .join(" e ");

        return (
          <div key={project.id}>
            <Row
              label={project.name}
              sublabel={runtimeLabel(project.runtimeType)}
              technical={project.port ? `:${project.port}` : undefined}
              tone={meta.tone}
              stateLabel={meta.label}
              pulse={meta.active}
              cpu={project.process?.cpu}
              memory={project.process?.memory}
              uptime={project.process?.uptime}
              host={host}
              href={link(`/projects/${project.id}`)}
              onToggle={hasChildren ? () => toggle(key) : undefined}
              collapsed={isCollapsed}
              toggleLabel={`${isCollapsed ? "Mostra" : "Nascondi"} ${inside} di ${project.name}`}
            />

            {hasChildren && !isCollapsed && (
              <div className="border-border/60 border-t">
                {containers.map((container) => (
                  <ContainerRow key={container.name} container={container} host={host} />
                ))}
                {services.map((service) => (
                  <ServiceRow key={service.id} service={service} host={host} link={link} nested />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

/** Services with no project have no row to nest under. */
export function StandaloneServices({
  services,
  host,
  sort,
  link,
}: {
  services: ServiceInfo[];
  host: HostScale;
  sort: UsageSort;
  link: (href: string) => string;
}) {
  if (services.length === 0) return null;
  return (
    <>
      <h2 className="text-muted mt-6 mb-2 text-meta font-medium">Database senza progetto</h2>
      <Panel padding="flush" className="divide-border divide-y overflow-hidden">
        <TableHead first="Database" />
        {sorted(services, sort, (s: ServiceInfo) => ({ name: serviceDisplayName(s), cpu: s.cpu, memory: s.memory })).map((service) => (
          <ServiceRow key={service.id} service={service} host={host} link={link} />
        ))}
      </Panel>
    </>
  );
}
