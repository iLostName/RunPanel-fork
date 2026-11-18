"use client";

import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import { useNode, useNodeApi } from "@/lib/hooks/useNode";
import { serviceDisplayName } from "@/lib/service-name";
import { engineLabel } from "@/lib/labels";

interface ProjectLike {
  id: string;
  name: string;
  status: string;
  memberId: string;
}

interface ServiceLike {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  status: string;
  memberId: string;
}

interface RunsOverview {
  overview?: {
    lastRun: { id: string; status: string; policyName: string | null; errorMessage: string | null } | null;
  };
}

interface Problem {
  key: string;
  title: string;
  description: string;
  href: string;
  cta: string;
}

/**
 * "Is everything OK?", answered for the apps as well as for the machine.
 *
 * The health banner looks at the platform only (Docker, PM2, disk, boot), so a
 * project in crash or a stopped database never showed there, and "Nessun
 * problema rilevato" could sit right above a red card. This adds what the
 * banner cannot see: projects and databases in error, and the last backup when
 * it failed or saved only part of what it should. Every line says what to
 * press. Above it, one line of counts that says how things are at a glance.
 */
export function OverviewStatus({
  projects,
  services,
  link,
}: {
  projects: ProjectLike[];
  services: ServiceLike[];
  link: (href: string, memberId: string) => string;
}) {
  const api = useNodeApi();
  const { isSolo } = useNode();
  const canBackup = useCan("backup");
  // One server's backups: a cluster has its own backup view per server.
  const { data: backups } = useResource<RunsOverview>(canBackup && isSolo ? api("/api/backups/runs?limit=1") : null, {
    intervalMs: 60_000,
  });

  const problems: Problem[] = [];
  for (const project of projects) {
    if (project.status !== "error") continue;
    problems.push({
      key: `project:${project.memberId}:${project.id}`,
      title: `${project.name} non è online`,
      description: "L'ultimo avvio o deploy non è riuscito. Il log dice perché.",
      href: link(`/projects/${project.id}?tab=deployments`, project.memberId),
      cta: "Vedi cosa è successo",
    });
  }
  for (const service of services) {
    if (service.status !== "error") continue;
    problems.push({
      key: `service:${service.memberId}:${service.id}`,
      title: `${serviceDisplayName(service)} non risponde`,
      description: `Il database ${engineLabel(service.type)} si è fermato per un errore.`,
      href: link(`/services/${service.id}`, service.memberId),
      cta: "Apri il database",
    });
  }
  const lastRun = backups?.overview?.lastRun;
  if (lastRun && (lastRun.status === "failed" || lastRun.status === "partial")) {
    problems.push({
      key: `backup:${lastRun.id}`,
      title: lastRun.status === "failed" ? "L'ultimo backup è fallito" : "L'ultimo backup è incompleto",
      description:
        lastRun.errorMessage ??
        (lastRun.status === "partial"
          ? `«${lastRun.policyName ?? "Backup"}» non ha salvato tutto quello che doveva.`
          : `«${lastRun.policyName ?? "Backup"}» non è riuscito.`),
      href: `/backups/runs/${lastRun.id}`,
      cta: "Apri il backup",
    });
  }

  const online = projects.filter((p) => p.status === "running").length;
  const runningServices = services.filter((s) => s.status === "running").length;
  const summary = [
    projects.length > 0 ? `${online} di ${projects.length} ${projects.length === 1 ? "progetto online" : "progetti online"}` : null,
    services.length > 0 ? `${runningServices} ${runningServices === 1 ? "database attivo" : "database attivi"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  if (problems.length === 0) {
    if (!summary) return null;
    return (
      <p role="status" className="text-muted mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Icon icon="solar:check-circle-bold" width={16} className="text-success" aria-hidden />
        <span>
          <span className="text-foreground font-medium">Le tue app funzionano.</span> {summary}
        </span>
      </p>
    );
  }

  return (
    <Panel padding="flush" className="border-warning/35 mb-4 overflow-hidden" role="region" aria-labelledby="overview-problems">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
        <Icon icon="solar:danger-triangle-bold" width={18} className="text-warning shrink-0" aria-hidden />
        <h2 id="overview-problems" className="text-foreground text-sm font-semibold">
          {problems.length === 1 ? "Una cosa da sistemare" : `${problems.length} cose da sistemare`}
        </h2>
        {summary && <span className="text-muted text-xs">{summary}</span>}
      </div>
      <ul className="divide-separator border-separator divide-y border-t">
        {problems.map((problem) => (
          <li key={problem.key} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:pl-11">
            <div className="min-w-[14rem] flex-1">
              <p className="text-foreground text-sm font-medium">{problem.title}</p>
              <p className="text-muted mt-0.5 text-xs">{problem.description}</p>
            </div>
            <Link
              href={problem.href}
              className="border-border bg-surface hover:bg-surface-hover text-foreground inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius)] border px-3 text-sm font-medium transition-colors"
            >
              {problem.cta}
              <Icon icon="solar:alt-arrow-right-linear" width={14} aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
