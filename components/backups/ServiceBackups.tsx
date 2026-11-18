"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Hint } from "@/components/ui/Hint";
import { Badge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/LinkButton";
import { ListRow } from "@/components/ui/ListRow";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { RestoreDialog } from "./RestoreDialog";
import { destinationPhrase, type ArtifactView } from "./types";
import { useCan, useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { formatBytes, formatRelative, formatWhen } from "@/lib/format";
import { capitalize } from "@/lib/schedule";
import { cn } from "@/lib/utils";

/** What `GET /api/backups/services/:id` answers. */
interface ServiceBackupsView {
  service: { id: string; name: string; type: string };
  coverage: {
    policyId: string;
    name: string;
    enabled: boolean;
    cron: string;
    schedule: string;
    timezone: string | null;
    destinationName: string | null;
    destinationType: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastStatus: string | null;
    databases: string[] | null;
  }[];
  runs: {
    runId: string;
    policyName: string | null;
    trigger: string;
    status: string;
    startedAt: string;
    hasArchive: boolean;
    destinationName: string | null;
    destinationType: string | null;
    verification: { status: "ok" | "failed"; checkedAt: string } | null;
    artifacts: ArtifactView[];
  }[];
}

/**
 * Backups, from the database's own page: is it saved, when last, and putting
 * it back — without going to the Backup page and finding it in a list.
 *
 * The restore is the same dialog as everywhere else, narrowed to this
 * database and with this database as the only possible target: from its own
 * page, "ripristina" can only mean "here".
 */
export function ServiceBackups({ serviceId, className }: { serviceId: string; className?: string }) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const me = useMe();
  const canBackup = useCan("backup");
  const canRestore = useCan("restore");

  const { data, loading, error, refresh } = useResource<ServiceBackupsView>(
    canBackup ? api(`/api/backups/services/${serviceId}`) : null,
    { intervalMs: 30_000 }
  );
  const [busy, setBusy] = useState<"now" | "schedule" | null>(null);
  const [restoring, setRestoring] = useState<ServiceBackupsView["runs"][number] | null>(null);

  if (!canBackup) return null;

  async function backupNow() {
    if (!data) return;
    setBusy("now");
    try {
      const res = await fetch(api("/api/backups/runs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: [{ kind: "service", id: serviceId }], name: `Backup di ${data.service.name}` }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Backup non avviato");
        return;
      }
      toast.success("Backup avviato");
      router.push(href(`/backups/runs/${body.runId}`));
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  /** The nightly preset, for this database alone. */
  async function scheduleNightly() {
    if (!data) return;
    setBusy("schedule");
    try {
      const list = await fetch(api("/api/backups/destinations")).then((res) => res.json());
      const destinations = (list.destinations ?? []) as { id: string; isDefault: boolean }[];
      const destinationId = (destinations.find((d) => d.isDefault) ?? destinations[0])?.id;
      if (!destinationId) {
        toast.error("Nessuna destinazione configurata: aggiungine una dalla pagina Backup");
        return;
      }
      const res = await fetch(api("/api/backups/policies"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Backup di ${data.service.name}`,
          cron: "0 3 * * *",
          targets: [{ kind: "service", id: serviceId }],
          destinationId,
          retentionCount: 7,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? body.details?.[0]?.message ?? MSG.createFailed);
        return;
      }
      toast.success("Fatto: ogni notte alle 03:00, conservando gli ultimi 7");
      await refresh();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  const coverage = data?.coverage ?? [];
  const active = coverage.filter((policy) => policy.enabled && policy.cron);
  const runs = data?.runs ?? [];
  const lastGood = runs.find((run) => run.status === "success" || run.status === "partial");

  return (
    <Panel className={cn("space-y-4", className)}>
      <PanelHeader
        title="Backup"
        description={
          lastGood
            ? `Ultimo backup ${formatRelative(lastGood.startedAt)}, ${destinationPhrase(lastGood.destinationType, lastGood.destinationName)}.`
            : "Le copie di questo database, e come rimetterle."
        }
        actions={
          me.isOwner && (
            <Button size="sm" variant="secondary" onPress={backupNow} isPending={busy === "now"} isDisabled={!data}>
              <Icon icon="solar:archive-up-linear" width={15} aria-hidden />
              Esegui backup ora
            </Button>
          )
        }
      />

      {loading && !data ? (
        <SkeletonBlock className="h-20" />
      ) : error && !data ? (
        <Hint tone="warn">Non riesco a leggere i backup di questo database: {error}</Hint>
      ) : (
        <>
          {active.length === 0 ? (
            <Hint tone="warn" title="Nessun backup pianificato per questo database">
              <p>
                {coverage.length > 0
                  ? "Le pianificazioni che lo includono sono spente o partono solo su richiesta."
                  : "Se il disco si rompe o un comando cancella i dati, non c'è niente da cui ripartire."}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" onPress={scheduleNightly} isPending={busy === "schedule"}>
                  <Icon icon="solar:calendar-linear" width={15} aria-hidden />
                  Salvalo ogni notte
                </Button>
                <LinkButton href={href("/backups/new")}>Configura a mano</LinkButton>
              </div>
            </Hint>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {active.map((policy) => (
                <li key={policy.policyId} className="flex flex-wrap items-baseline gap-x-2">
                  <Icon icon="solar:calendar-linear" width={14} className="text-muted shrink-0 self-center" aria-hidden />
                  <span className="text-foreground">{capitalize(policy.schedule)}</span>
                  <span className="text-muted text-xs">
                    {destinationPhrase(policy.destinationType, policy.destinationName)} · «{policy.name}»
                    {policy.databases ? ` · solo ${policy.databases.join(", ")}` : ""}
                    {policy.nextRunAt ? ` · prossimo ${formatRelative(policy.nextRunAt)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div>
            <p className="text-foreground mb-1 text-sm font-medium">Backup recenti</p>
            {runs.length === 0 ? (
              <p className="text-muted text-xs">Ancora nessun backup di questo database.</p>
            ) : (
              <ul className="divide-border -mx-4 divide-y sm:-mx-5">
                {runs.map((run) => {
                  const size = run.artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
                  const usable = run.hasArchive && run.artifacts.some((artifact) => artifact.status === "ok");
                  return (
                    <li key={run.runId}>
                      <ListRow
                        className="sm:px-5"
                        href={href(`/backups/runs/${run.runId}`)}
                        title={formatWhen(run.startedAt)}
                        status={<StatusBadge status={run.artifacts.every((a) => a.status === "ok") ? run.status : "partial"} />}
                        badges={
                          run.verification ? (
                            <Badge
                              tone={run.verification.status === "ok" ? "success" : "danger"}
                              icon={run.verification.status === "ok" ? "solar:shield-check-linear" : "solar:danger-circle-linear"}
                            >
                              {run.verification.status === "ok" ? "verificato" : "danneggiato"}
                            </Badge>
                          ) : undefined
                        }
                        description={`${run.policyName ?? "Esecuzione manuale"} · ${destinationPhrase(run.destinationType, run.destinationName)}${size ? ` · ${formatBytes(size)}` : ""}`}
                        meta={run.artifacts.find((artifact) => artifact.errorMessage)?.errorMessage ?? undefined}
                        action={
                          canRestore && usable ? (
                            <Button size="sm" variant="secondary" onPress={() => setRestoring(run)}>
                              Ripristina…
                            </Button>
                          ) : undefined
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {restoring && (
        <RestoreDialog
          source={{ runId: restoring.runId }}
          artifacts={restoring.artifacts}
          isOpen
          onOpenChange={(open) => !open && setRestoring(null)}
          fixedTargets={Object.fromEntries(restoring.artifacts.map((artifact) => [artifact.id, serviceId]))}
        />
      )}
    </Panel>
  );
}
