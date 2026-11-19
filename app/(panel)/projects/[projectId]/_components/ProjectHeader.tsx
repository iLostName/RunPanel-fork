"use client";

import { memo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { ResourceHeader, type ResourceMenuItem } from "@/components/resource/ResourceHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Technical } from "@/components/ui/Technical";
import { phaseLabel } from "@/lib/deploy-phases";
import { runtimeLabel } from "@/lib/labels";
import { useServerHref } from "@/lib/hooks/useNode";
import { exportProjectConfig, projectHasSource } from "./project-facts";
import { DuplicateDialog } from "./DuplicateDialog";
import { useCan } from "@/lib/hooks/useMe";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";
import type { Project, SettingsSectionId, TabId } from "./types";

/**
 * Title, identity and the controls that act on the whole project.
 *
 * The primary action follows the project: "Deploy" once it has a source,
 * "Scegli la sorgente" before. "Avvia" only appears once a deploy has worked,
 * because starting means going back to the last version that did, and before
 * the first one there is none. Stop asks first: it takes the app offline.
 */
export const ProjectHeader = memo(function ProjectHeader({
  project,
  busy,
  onDeploy,
  onControl,
  onRename,
  onOpenVersions,
  onReleasePin,
  onGoTo,
}: {
  project: Project;
  busy: boolean;
  onDeploy: (mode: "deploy" | "rebuild") => void;
  onControl: (action: "start" | "stop" | "restart") => void;
  onRename: (name: string) => Promise<boolean>;
  onOpenVersions: () => void;
  onReleasePin: () => void;
  onGoTo: (tab: TabId, section?: SettingsSectionId) => void;
}) {
  const href = useServerHref();
  const [stopOpen, setStopOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  // The copy is a new project running the same code: both permissions, as the server checks.
  const canCreate = useCan("projects.create");
  const canHost = useCan("host");
  const canAudit = useCan("audit.view");
  const router = useRouter();
  const phone = useIsPhone();

  const deploying = project.status === "deploying";
  // Read-only accounts see the state, not the controls: the server refuses
  // them anyway, and a row of buttons that only error is worse than none.
  const canOperate = project.permission?.level !== "read";
  const canManage = (project.permission?.level ?? "manage") === "manage";
  const hasSource = projectHasSource(project);
  const running = project.status === "running";
  const canStop = running || project.status === "error";
  const canStart = (project.status === "stopped" || project.status === "error") && Boolean(project.last_success_at);
  const canPickVersion = project.source_type === "github" && Boolean(project.source_url);
  const address = project.hosts?.[0] ?? null;

  /*
    A queue nobody is reminded of is a queue that runs weeks later, on a
    deploy triggered by somebody who never put anything in it. So it is said
    next to the button that will run it, and not only where it was written.
  */
  const oneTime = project.oneTimeCommands ?? [];
  const oneTimePhases = [...new Set(oneTime.map((command) => command.phase))];

  const menu: ResourceMenuItem[] = canOperate
    ? [
        // On a phone the header is a row of four tiles, and stopping is the
        // rarest of its actions: it moves in here, still asking first.
        ...(phone && canStop ? [{ id: "stop", label: "Ferma", icon: "solar:stop-linear", onAction: () => setStopOpen(true) }] : []),
        ...(canPickVersion
          ? [{ id: "versions", label: "Scegli la versione da distribuire", icon: "solar:branching-paths-up-linear", disabled: busy || deploying, onAction: onOpenVersions }]
          : []),
        ...(hasSource
          ? [{ id: "rebuild", label: "Ricostruisci da zero", icon: "solar:refresh-circle-linear", disabled: busy || deploying, onAction: () => onDeploy("rebuild") }]
          : []),
        ...(project.pinned_sha
          ? [{ id: "release", label: "Torna all'ultimo commit", icon: "solar:rewind-back-linear", disabled: busy || deploying, onAction: onReleasePin }]
          : []),
        ...(canStop && canStart
          ? [{ id: "restart", label: "Riavvia", icon: "solar:refresh-linear", onAction: () => onControl("restart") }]
          : []),
        ...(canManage
          ? [
              ...(canCreate && canHost
                ? [{ id: "duplicate", label: "Duplica", icon: "solar:copy-linear", onAction: () => setDuplicateOpen(true) }]
                : []),
              { id: "export", label: "Esporta configurazione", icon: "solar:download-minimalistic-linear", onAction: () => exportProjectConfig(project) },
              { id: "delete", label: "Elimina il progetto", icon: "solar:trash-bin-minimalistic-linear", danger: true, onAction: () => onGoTo("settings", "danger") },
            ]
          : []),
      ]
    : [];
  // The project's history in the activity log, for whoever may read it, read-only accounts included.
  if (canAudit) {
    menu.push({
      id: "activity",
      label: "Vedi attività",
      icon: "solar:history-linear",
      onAction: () => router.push(href(`/audit?scope=project&scopeId=${encodeURIComponent(project.id)}`)),
    });
  }

  return (
    <>
      <ResourceHeader
        backHref={href("/projects")}
        backLabel="Torna ai progetti"
        name={project.name}
        onRename={canManage ? onRename : undefined}
        status={project.status}
        badges={
          <>
            {/* Next to the status because it qualifies it: the app is running,
                but not from where the branch says. */}
            {project.pinned_sha && (
              <span
                title={project.pinned_at ? `Fermo dal ${new Date(project.pinned_at).toLocaleString()}` : undefined}
                className="border-warning/35 text-warning text-meta inline-flex items-center gap-1 rounded-[var(--radius)] border px-1.5 py-0.5"
              >
                <Icon icon="solar:pin-linear" width={12} aria-hidden />
                Fermo su <span className="font-mono">{project.pinned_sha.slice(0, 7)}</span>
              </span>
            )}
            {oneTime.length > 0 && (
              <span
                title={oneTimePhases.map(phaseLabel).join(", ")}
                className="border-accent/35 text-accent text-meta inline-flex items-center gap-1 rounded-[var(--radius)] border px-1.5 py-0.5"
              >
                <Icon icon="solar:bolt-circle-linear" width={12} aria-hidden />
                {oneTime.length === 1 ? "1 comando una tantum" : `${oneTime.length} comandi una tantum`}
              </span>
            )}
          </>
        }
        meta={
          <>
            <span>{runtimeLabel(project.runtime_type)}</span>
            <span aria-hidden>·</span>
            {project.source_type === "github" && project.repo ? (
              <span className="font-mono">
                {project.repo}
                <span className="text-muted"> @ {project.source_branch}</span>
              </span>
            ) : project.source_type === "github" ? (
              <span>Sorgente da scegliere</span>
            ) : (
              <span>Da archivio ZIP</span>
            )}
            <Technical>
              <span aria-hidden>·</span>
              <span className="font-mono">:{project.port ?? "auto"}</span>
            </Technical>
            {/* Up here for every account, read-only included: opening the app
                is the one thing everybody who sees the project wants. */}
            {(project.hosts ?? []).slice(1).map((host) => (
              <span key={host.hostname} className="contents">
                <span aria-hidden>·</span>
                <a href={host.url} target="_blank" rel="noreferrer" className="text-accent font-mono hover:underline">
                  {host.hostname}
                </a>
              </span>
            ))}
          </>
        }
        actions={
          <>
            {canOperate &&
              (hasSource ? (
                <Button variant="primary" size="sm" isPending={busy} isDisabled={deploying} onPress={() => onDeploy("deploy")}>
                  <Icon icon="solar:upload-linear" width={16} aria-hidden />
                  Deploy
                </Button>
              ) : canManage ? (
                <Button variant="primary" size="sm" onPress={() => onGoTo("settings", "source")}>
                  <Icon icon="solar:code-linear" width={16} aria-hidden />
                  Scegli la sorgente
                </Button>
              ) : null)}
            {address && (
              <a
                href={address.url}
                target="_blank"
                rel="noreferrer"
                title={address.locked ? "Chiede la password" : address.hostname}
                className="border-border bg-surface hover:bg-surface-hover text-foreground inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors"
              >
                <Icon icon={address.locked ? "solar:lock-keyhole-minimalistic-linear" : "solar:global-linear"} width={16} aria-hidden />
                Apri l&apos;app
              </a>
            )}
            {canOperate && canStart && (
              <Button variant="secondary" size="sm" onPress={() => onControl("start")}>
                <Icon icon="solar:play-linear" width={16} aria-hidden />
                Avvia
              </Button>
            )}
            {canOperate && running && (
              <Button variant="outline" size="sm" onPress={() => onControl("restart")}>
                <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                Riavvia
              </Button>
            )}
            {canOperate && canStop && (
              <Button variant="outline" size="sm" className="max-md:hidden" onPress={() => setStopOpen(true)}>
                <Icon icon="solar:stop-linear" width={16} aria-hidden />
                Ferma
              </Button>
            )}
          </>
        }
        menu={menu}
        menuLabel="Altre azioni sul progetto"
      />

      {duplicateOpen && <DuplicateDialog project={project} isOpen={duplicateOpen} onOpenChange={setDuplicateOpen} />}

      <ConfirmDialog
        isOpen={stopOpen}
        onOpenChange={setStopOpen}
        title={`Fermare ${project.name}?`}
        description={
          address
            ? `L'app smette di rispondere su ${address.hostname} finché non la riavvii.`
            : "L'app smette di rispondere finché non la riavvii."
        }
        confirmLabel="Ferma"
        destructive
        onConfirm={() => onControl("stop")}
      />
    </>
  );
});
