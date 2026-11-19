"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { LinkButton } from "@/components/ui/LinkButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { DeleteButton } from "@/components/ui/DangerAction";
import { Fab } from "@/components/ui/Fab";
import { PhoneRowMenu } from "@/components/ui/PhoneMenu";
import { DestinationsPanel } from "./_components/DestinationsPanel";
import { EncryptionPanel } from "./_components/EncryptionPanel";
import { HostedCopiesPanel } from "./_components/HostedCopiesPanel";
import { Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StatTile } from "@/components/ui/StatTile";
import { StatusBadge } from "@/components/StatusBadge";
import { useResource } from "@/lib/hooks/useResource";
import { useMe } from "@/lib/hooks/useMe";
import { capitalize } from "@/lib/schedule";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { formatBytes, formatDuration, formatRelative, formatWhen } from "@/lib/format";
import { triggerLabel } from "./_components/format";
import { CopiesBadge, deleteWhere, runWhere } from "./_components/copies";
import { useMemberApi, useNode, useServerHref } from "@/lib/hooks/useNode";
import { onlyMember, type Located, type MemberStatus } from "@/lib/cluster-merge";
import { ServerBadge, ServerFilter, UnreachableServers } from "@/components/cluster/ServerBits";
import {
  describeTarget,
  destinationsPhrase,
  policyDestinations,
  type DestinationView,
  type HostedDiskView,
  type HostedOverviewView,
  type HostedSourceView,
  type PolicyView,
  type RunView,
  type RunsResponse,
  type TargetCatalog,
} from "@/components/backups/types";

/**
 * The one preset that matters: everything, every night, keep a week.
 *
 * A backup feature nobody configures is a backup feature nobody has, and the
 * blank editor is where most people stop. This is the shape almost everyone
 * wants, one click away.
 */
const NIGHTLY_PRESET = {
  name: "Backup notturno",
  cron: "0 3 * * *",
  targets: [
    { kind: "all-services" as const },
    { kind: "panel" as const },
    // The files the apps write, as well as how they are configured: the project
    // page used to warn that no schedule held its volumes, right after this
    // one-click preset had been taken as "everything".
    { kind: "all-projects" as const, include: ["config" as const, "volumes" as const] },
  ],
  retentionCount: 7,
};

type Overview = RunsResponse["overview"];

interface ClusterBackups {
  policies: Located<PolicyView>[];
  runs: Located<RunView>[];
  destinations: Located<DestinationView>[];
  /** What each server keeps for the others. Absent from a panel on an older version. */
  hosted?: Located<HostedSourceView>[];
  perServer: {
    memberId: string;
    activeRunId: string | null;
    overview: Overview | null;
    catalog: TargetCatalog | null;
    hostedDisk?: HostedDiskView | null;
  }[];
  members: MemberStatus[];
}

/** Several servers' summaries as one: sums, the latest last run, the earliest next run. */
function combineOverviews(list: Overview[]): Overview | undefined {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const lastRuns = list.map((o) => o.lastRun).filter((r): r is RunView => r !== null);
  const nextRuns = list.map((o) => o.nextRunAt).filter((n): n is string => n !== null);
  return {
    lastRun: lastRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null,
    nextRunAt: nextRuns.sort()[0] ?? null,
    totalBytes: list.reduce((n, o) => n + o.totalBytes, 0),
    runCount: list.reduce((n, o) => n + o.runCount, 0),
    recent: { ok: list.reduce((n, o) => n + o.recent.ok, 0), failed: list.reduce((n, o) => n + o.recent.failed, 0) },
    policiesEnabled: list.reduce((n, o) => n + o.policiesEnabled, 0),
  };
}

export default function BackupsPage() {
  const memberApi = useMemberApi();
  const href = useServerHref();
  const { isSolo, selfId, serverParam, nameOf } = useNode();
  const poll20000 = usePollInterval(20000);
  const poll5000 = usePollInterval(5000);
  const router = useRouter();
  const me = useMe();

  // Solo mode reads this server's routes as always; a cluster reads every
  // server at once and narrows to `?server=` when the URL names one.
  const runs = useResource<RunsResponse>(isSolo ? "/api/backups/runs?limit=25" : null, { intervalMs: poll5000 });
  const policies = useResource<{ policies: PolicyView[] }>(isSolo ? "/api/backups/policies" : null, {
    intervalMs: poll20000,
  });
  const destinations = useResource<{ destinations: DestinationView[] }>(isSolo ? "/api/backups/destinations" : null);
  const catalog = useResource<TargetCatalog>(isSolo ? "/api/backups/targets" : null);
  // Alone, a server only keeps copies of servers it was once linked to.
  const hosted = useResource<HostedOverviewView>(isSolo ? "/api/backups/hosted" : null, { intervalMs: poll20000 });
  const cluster = useResource<ClusterBackups>(isSolo ? null : "/api/cluster/backups", { intervalMs: poll5000 });

  const [busy, setBusy] = useState<string | null>(null);

  const self = selfId ?? "";
  const tag = <T,>(list: T[] | undefined): Located<T>[] => (list ?? []).map((x) => ({ ...x, memberId: self, memberName: "" }));
  const shownServers = (cluster.data?.perServer ?? []).filter((p) => !serverParam || p.memberId === serverParam);
  const overview = isSolo
    ? runs.data?.overview
    : combineOverviews(shownServers.map((p) => p.overview).filter((o): o is Overview => o !== null));
  const activeRuns: { memberId: string; runId: string }[] = isSolo
    ? runs.data?.activeRunId
      ? [{ memberId: self, runId: runs.data.activeRunId }]
      : []
    : shownServers.filter((p) => p.activeRunId).map((p) => ({ memberId: p.memberId, runId: p.activeRunId as string }));
  const busyOn = (memberId: string) => activeRuns.some((a) => a.memberId === memberId);
  const catalogFor = (memberId: string) =>
    isSolo ? catalog.data : (cluster.data?.perServer.find((p) => p.memberId === memberId)?.catalog ?? undefined);
  const failed = (cluster.data?.members ?? []).filter((m) => !m.ok && (!serverParam || m.id === serverParam));
  const refreshAll = () => {
    if (isSolo) {
      void runs.refresh();
      void policies.refresh();
      void destinations.refresh();
      void hosted.refresh();
    } else void cluster.refresh();
  };
  // Where something new goes: the server named in the URL, else this one.
  const target = serverParam ?? self;

  async function post(url: string, label: string, memberId: string) {
    setBusy(url);
    try {
      const res = await fetch(memberApi(memberId, url), { method: "POST", headers: { "Content-Type": "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? `${label} non riuscita`);
        return null;
      }
      return body;
    } catch {
      toast.error(`${label} non riuscita`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function runNow(policy: Located<PolicyView>) {
    const body = await post(`/api/backups/policies/${policy.id}/run`, "Esecuzione", policy.memberId);
    if (!body?.runId) return;
    toast.success(`Backup avviato per "${policy.name}"`);
    router.push(href(`/backups/runs/${body.runId}`, policy.memberId));
  }

  async function createPreset() {
    // The destination marked as default on that server, not whichever comes first:
    // the local disk is created first, so an S3 bucket added later was never used.
    const onTarget = destinationList.filter((d) => d.memberId === target);
    const destinationId = (onTarget.find((d) => d.isDefault) ?? onTarget[0])?.id;
    if (!destinationId) {
      toast.error("Nessuna destinazione configurata");
      return;
    }

    setBusy("preset");
    try {
      const res = await fetch(memberApi(target, "/api/backups/policies"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...NIGHTLY_PRESET, destinationId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? "Creazione non riuscita");
        return;
      }
      toast.success(`Pianificazione creata${isSolo ? "" : ` su ${nameOf(target)}`}: ogni giorno alle 03:00`);
      refreshAll();
    } finally {
      setBusy(null);
    }
  }

  async function togglePolicy(policy: Located<PolicyView>) {
    setBusy(policy.id);
    try {
      const res = await fetch(memberApi(policy.memberId, `/api/backups/policies/${policy.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !policy.enabled }),
      });
      if (!res.ok) {
        toast.error("Modifica non riuscita");
        return;
      }
      refreshAll();
    } finally {
      setBusy(null);
    }
  }

  async function removePolicy(policyId: string, memberId: string) {
    const res = await fetch(memberApi(memberId, `/api/backups/policies/${policyId}`), { method: "DELETE" });
    if (!res.ok) {
      toast.error("Eliminazione non riuscita");
      return;
    }
    toast.success("Pianificazione eliminata. I backup già fatti restano.");
    refreshAll();
  }

  async function removeRun(runId: string, memberId: string) {
    const res = await fetch(memberApi(memberId, `/api/backups/runs/${runId}`), { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Eliminazione non riuscita");
      return;
    }
    toast.success("Backup eliminato, archivio compreso");
    refreshAll();
  }

  if ((isSolo ? runs.loading && !runs.data : cluster.loading && !cluster.data)) {
    return (
      <>
        <PageHeader title="Backup" description="Copie dei database, della configurazione e dei dati." />
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonBlock key={i} className="h-24" />
          ))}
        </div>
        <div className="space-y-4">
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-64" />
        </div>
      </>
    );
  }

  const policyList: Located<PolicyView>[] = isSolo ? tag(policies.data?.policies) : onlyMember(cluster.data?.policies ?? [], serverParam);
  const runList: Located<RunView>[] = isSolo ? tag(runs.data?.runs) : onlyMember(cluster.data?.runs ?? [], serverParam);
  const destinationList: Located<DestinationView>[] = isSolo
    ? tag(destinations.data?.destinations)
    : onlyMember(cluster.data?.destinations ?? [], serverParam);
  const policiesError = isSolo ? policies.error : cluster.error;
  const runsError = isSolo ? runs.error : cluster.error;
  const destinationsError = isSolo ? destinations.error : cluster.error;
  const destinationsLoaded = isSolo ? Boolean(destinations.data) : Boolean(cluster.data);
  const hostedList: Located<HostedSourceView>[] = isSolo ? tag(hosted.data?.sources) : onlyMember(cluster.data?.hosted ?? [], serverParam);
  const hostedDisks: Record<string, HostedDiskView | null | undefined> = isSolo
    ? { [self]: hosted.data?.disk }
    : Object.fromEntries((cluster.data?.perServer ?? []).map((p) => [p.memberId, p.hostedDisk]));

  return (
    <>
      <PageHeader
        title="Backup"
        description="Copie dei database gestiti, dello store del pannello e della configurazione dei progetti."
        actions={
          <>
            <ServerFilter />
            {me.isOwner && (
              <LinkButton href={href("/backups/upload")} variant="secondary">
                <Icon icon="solar:upload-minimalistic-linear" width={16} aria-hidden />
                Ripristina da un archivio
              </LinkButton>
            )}
            {/* On a phone this is the floating button at the end of the page:
                beside "Ripristina da un archivio" the row took two lines. */}
            <LinkButton href={href("/backups/new")} className="max-md:hidden">
              <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
              Nuova pianificazione
            </LinkButton>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Ultimo backup"
          icon="solar:clock-circle-linear"
          value={formatRelative(overview?.lastRun?.startedAt ?? null)}
          hint={overview?.lastRun ? triggerLabel(overview.lastRun.trigger) : undefined}
        />
        <StatTile
          label="Spazio occupato"
          icon="solar:ssd-square-linear"
          value={formatBytes(overview?.totalBytes ?? 0)}
          hint={`${overview?.runCount ?? 0} archivi`}
        />
        <StatTile
          label="Ultimi 7 giorni"
          icon="solar:check-circle-linear"
          value={`${overview?.recent.ok ?? 0} ok`}
          hint={overview?.recent.failed ? `${overview.recent.failed} falliti` : "nessun fallimento"}
        />
        <StatTile
          label="Prossima esecuzione"
          icon="solar:calendar-linear"
          value={formatRelative(overview?.nextRunAt ?? null)}
          hint={overview?.nextRunAt ? formatWhen(overview.nextRunAt) : "nessuna pianificazione"}
        />
      </div>

      <UnreachableServers failed={failed} what="i backup" className="mb-4" />

      {activeRuns.map((active) => (
        <Hint key={active.memberId} tone="info" className="mb-4">
          Un backup è in corso{isSolo ? "" : ` su ${nameOf(active.memberId)}`}.{" "}
          <Link href={href(`/backups/runs/${active.runId}`, active.memberId)} className="text-accent underline">
            Segui l&apos;esecuzione
          </Link>
          .
        </Hint>
      ))}

      <div className="space-y-4">
        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Pianificazioni"
              description="Cosa viene salvato e quando. Una pianificazione senza orario si esegue solo su richiesta."
            />
          </div>

          {policyList.length === 0 && policiesError ? (
            <LoadError what="le pianificazioni" error={policiesError} onRetry={refreshAll} />
          ) : policyList.length === 0 ? (
            <EmptyState
              icon="solar:calendar-linear"
              title="Nessun backup pianificato"
              description="Comincia dalla configurazione che va bene quasi sempre: tutto quello che esiste, ogni notte alle 03:00, conservando l'ultima settimana."
              action={
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button size="sm" onPress={createPreset} isPending={busy === "preset"}>
                    <Icon icon="solar:magic-stick-3-linear" width={16} aria-hidden />
                    Crea il backup notturno
                  </Button>
                  <LinkButton href={href("/backups/new")}>Configura a mano</LinkButton>
                </div>
              }
            />
          ) : (
            <ul className="divide-border divide-y">
              {policyList.map((policy) => (
                // On a phone the row opens the policy from anywhere on it, and
                // keeps one quick action and a ⋯ (`ListRow`'s shape): with three
                // buttons the name was cut to a word.
                <li
                  key={`${policy.memberId}:${policy.id}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 max-md:relative max-md:active:bg-surface-hover sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link
                        href={href(`/backups/policies/${policy.id}`, policy.memberId)}
                        className="text-foreground max-md:touch-chrome truncate text-sm font-medium hover:underline max-md:after:absolute max-md:after:inset-0"
                      >
                        {policy.name}
                      </Link>
                      {!policy.enabled && (
                        <span className="text-muted bg-default rounded-full px-2 py-0.5 text-meta">
                          disattivata
                        </span>
                      )}
                      {policy.lastStatus && <StatusBadge status={policy.lastStatus} />}
                      <ServerBadge memberId={policy.memberId} />
                    </div>
                    {/* When and where first, in a sentence; what, on its own line. */}
                    <p className="text-muted mt-0.5 truncate text-xs">
                      {capitalize(policy.schedule)}
                      {policy.cron && policy.timezone ? ` (ora di ${policy.timezone})` : ""} ·{" "}
                      {destinationsPhrase(policyDestinations(policy))}
                    </p>
                    <p className="text-muted/80 mt-0.5 truncate text-meta">
                      {policy.targets.map((t) => describeTarget(t, catalogFor(policy.memberId))).join(" · ")}
                    </p>
                    {/* The column on the right is not drawn on a phone. */}
                    <p className="text-muted/80 mt-0.5 truncate text-meta sm:hidden">
                      prossima {formatRelative(policy.nextRunAt)} · ultima {formatRelative(policy.lastRunAt)}
                    </p>
                  </div>

                  <div className="text-muted hidden text-right text-xs sm:block">
                    <div>prossima {formatRelative(policy.nextRunAt)}</div>
                    <div>ultima {formatRelative(policy.lastRunAt)}</div>
                  </div>

                  <div className="flex items-center gap-1 max-md:relative max-md:z-10">
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => runNow(policy)}
                      isPending={busy === `/api/backups/policies/${policy.id}/run`}
                      isDisabled={busyOn(policy.memberId)}
                      aria-label={`Esegui ora ${policy.name}`}
                    >
                      <Icon icon="solar:play-linear" width={15} aria-hidden />
                      <span className="max-md:hidden">Esegui ora</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="max-md:hidden"
                      onPress={() => togglePolicy(policy)}
                      isPending={busy === policy.id}
                      aria-label={policy.enabled ? "Disattiva" : "Attiva"}
                    >
                      <Icon
                        icon={policy.enabled ? "solar:pause-linear" : "solar:play-circle-linear"}
                        width={16}
                        aria-hidden
                      />
                    </Button>
                    <DeleteButton
                      label={`Elimina la pianificazione ${policy.name}`}
                      className="max-md:hidden"
                      confirm={{
                        title: `Eliminare "${policy.name}"?`,
                        description:
                          "Gli archivi già creati restano e si possono ancora ripristinare. Da adesso non ne verranno creati altri da questa pianificazione.",
                      }}
                      onConfirm={() => removePolicy(policy.id, policy.memberId)}
                    />
                    <PhoneRowMenu
                      label={`Azioni per ${policy.name}`}
                      actions={[
                        {
                          id: "toggle",
                          label: policy.enabled ? "Disattiva" : "Attiva",
                          icon: policy.enabled ? "solar:pause-linear" : "solar:play-circle-linear",
                          onAction: () => void togglePolicy(policy),
                        },
                      ]}
                      remove={{
                        label: "Elimina…",
                        title: `Eliminare "${policy.name}"?`,
                        description:
                          "Gli archivi già creati restano e si possono ancora ripristinare. Da adesso non ne verranno creati altri da questa pianificazione.",
                        onConfirm: () => removePolicy(policy.id, policy.memberId),
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Above the history, not under it: the nightly preset needs a destination,
            and below 25 rows of runs nobody found where to add one. */}
        <DestinationsPanel
          destinations={destinationList}
          loaded={destinationsLoaded}
          error={destinationsError}
          description={
            isSolo
              ? "Dove finiscono gli archivi: il disco di questo server, oppure un archivio S3 o Telegram fuori da qui. Una pianificazione può mandarne una copia in più destinazioni."
              : `Dove finiscono gli archivi. Una nuova va su ${nameOf(target)}.`
          }
          onChanged={refreshAll}
        />

        {/* Next to where the archives go: a bucket is where a password matters most. */}
        <EncryptionPanel key={target} memberId={target} />

        <Panel padding="flush">
          <div className="p-4 sm:p-5">
            <PanelHeader
              title="Cronologia"
              description="Ogni esecuzione, con quello che è riuscito a salvare."
            />
          </div>

          {runList.length === 0 && runsError ? (
            <LoadError what="la cronologia" error={runsError} onRetry={refreshAll} />
          ) : runList.length === 0 ? (
            <EmptyState
              icon="solar:archive-linear"
              title="Nessun backup eseguito"
              description="Appena una pianificazione parte, o premi Esegui ora, l'archivio compare qui."
            />
          ) : (
            <ul className="divide-border divide-y">
              {runList.map((run) => (
                // On a phone the row is the way to the run's page, so
                // "Dettagli" goes, and the download and the delete are in the ⋯.
                <li
                  key={`${run.memberId}:${run.id}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 max-md:relative max-md:active:bg-surface-hover sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={run.status} />
                      <Link
                        href={href(`/backups/runs/${run.id}`, run.memberId)}
                        className="text-foreground max-md:touch-chrome truncate text-sm hover:underline max-md:after:absolute max-md:after:inset-0"
                      >
                        {run.policyName ?? "Esecuzione manuale"}
                      </Link>
                      <ServerBadge memberId={run.memberId} />
                      {run.pinned && (
                        <span
                          className="text-muted"
                          title="Esente dalla retention: è il backup di sicurezza di un ripristino"
                        >
                          <Icon icon="solar:pin-linear" width={14} aria-hidden />
                        </span>
                      )}
                      {run.verification && (
                        <span
                          className={run.verification.status === "ok" ? "text-success" : "text-danger"}
                          title={
                            run.verification.status === "ok"
                              ? `Integrità verificata ${formatWhen(run.verification.checkedAt)}`
                              : `Verifica non superata ${formatWhen(run.verification.checkedAt)}: archivio danneggiato`
                          }
                        >
                          <Icon
                            icon={run.verification.status === "ok" ? "solar:shield-check-linear" : "solar:danger-circle-linear"}
                            width={14}
                            aria-label={run.verification.status === "ok" ? "Integrità verificata" : "Archivio danneggiato"}
                          />
                        </span>
                      )}
                      {run.hasArchive && run.encryption && (
                        <span
                          className={run.encryption.usable ? "text-muted" : "text-warning"}
                          title={
                            run.encryption.usable
                              ? `Cifrato con la password dei backup${run.encryption.keyCreatedAt ? ` del ${formatWhen(run.encryption.keyCreatedAt)}` : ""}`
                              : "Cifrato con una password che questo pannello non ha più: per ripristinarlo ti verrà chiesta"
                          }
                        >
                          <Icon icon="solar:lock-password-linear" width={14} aria-label="Archivio cifrato" />
                        </span>
                      )}
                      <CopiesBadge run={run} />
                    </div>
                    <p className="text-muted mt-0.5 truncate text-xs">
                      {formatWhen(run.startedAt)} · {triggerLabel(run.trigger)} ·{" "}
                      {formatDuration(run.durationMs)}
                      {run.archiveBytes ? ` · ${formatBytes(run.archiveBytes)}` : ""}
                      {run.hasArchive ? ` · ${runWhere(run)}` : ""}
                      {run.errorMessage ? ` · ${run.errorMessage}` : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 max-md:relative max-md:z-10">
                    {run.hasArchive && (
                      <LinkButton
                        href={memberApi(run.memberId, `/api/backups/runs/${run.id}/download`)}
                        variant="ghost"
                        download
                        aria-label="Scarica l'archivio"
                        className="max-md:hidden"
                      >
                        <Icon icon="solar:download-linear" width={16} aria-hidden />
                      </LinkButton>
                    )}
                    <LinkButton href={href(`/backups/runs/${run.id}`, run.memberId)} className="max-md:hidden">
                      Dettagli
                    </LinkButton>
                    <DeleteButton
                      label="Elimina questo backup"
                      className="max-md:hidden"
                      isDisabled={run.status === "running" || run.copies?.some((copy) => copy.status === "uploading")}
                      confirm={{
                        title: "Eliminare questo backup?",
                        description: `${deleteWhere(run)} Se è l'ultimo riuscito, resti senza un punto di ripristino.`,
                      }}
                      onConfirm={() => removeRun(run.id, run.memberId)}
                    />
                    <PhoneRowMenu
                      label={`Azioni per il backup del ${formatWhen(run.startedAt)}`}
                      actions={
                        run.hasArchive
                          ? [
                              {
                                id: "download",
                                label: "Scarica l'archivio",
                                icon: "solar:download-linear",
                                onAction: () => {
                                  window.location.href = memberApi(run.memberId, `/api/backups/runs/${run.id}/download`);
                                },
                              },
                            ]
                          : []
                      }
                      remove={{
                        label: "Elimina…",
                        title: "Eliminare questo backup?",
                        description: `${deleteWhere(run)} Se è l'ultimo riuscito, resti senza un punto di ripristino.`,
                        disabled: run.status === "running" || run.copies?.some((copy) => copy.status === "uploading"),
                        onConfirm: () => removeRun(run.id, run.memberId),
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Someone else's archives, kept here: after this server's own. */}
        <HostedCopiesPanel
          sources={hostedList}
          disks={hostedDisks}
          loaded={isSolo ? Boolean(hosted.data) : Boolean(cluster.data)}
          error={isSolo ? hosted.error : cluster.error}
          isSolo={isSolo}
          onChanged={refreshAll}
        />

        <Hint tone="warn" title="Gli archivi contengono segreti">
          Le variabili e le credenziali dei database vengono salvate cifrate con la chiave di questo
          pannello: un archivio portato altrove resta illeggibile senza quella chiave, a meno che tu
          non abbia scelto di includerla. Dump, volumi e codice sono cifrati solo con la cifratura
          degli archivi attiva. Sul disco locale gli archivi stanno in <code>data/backups</code>,
          leggibili solo dal pannello.
        </Hint>
      </div>

      <Fab href={href("/backups/new")} label="Nuova pianificazione" />
    </>
  );
}
