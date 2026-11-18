"use client";

import { memo, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { StatusBadge } from "@/components/StatusBadge";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { Advanced } from "@/components/ui/Technical";
import { LiveDeploy } from "@/components/deploy/LiveDeploy";
import { formatDurationBetween, formatRelative } from "@/lib/format";
import { deploymentActive, deploymentSucceeded, explainDeployError } from "@/lib/deploy-explain";
import { type Deployment, type Project } from "./types";
import { useNodeApi } from "@/lib/hooks/useNode";

/**
 * What started this deploy, when the commit message cannot say.
 *
 * A deploy of an uploaded project has no commit, and the fallback used to
 * render the column value raw — "Deploy manual", an English word in an Italian
 * panel, and "Deploy poll" once polling existed.
 */
const TRIGGER_LABEL: Record<string, string> = {
  manual: "Deploy manuale",
  webhook: "Deploy da un push",
  poll: "Deploy da un push (controllo periodico)",
};

const DeploymentCard = memo(function DeploymentCard({
  deployment,
  canRestore,
  onRestore,
}: {
  deployment: Deployment;
  /** A GitHub project, an operator, and a commit to go back to. */
  canRestore: boolean;
  onRestore: (commitSha: string) => void;
}) {
  const api = useNodeApi();
  const [buildLog, setBuildLog] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const failed = deployment.status === "failed";
  const explanation = failed ? explainDeployError(deployment.error_message) : null;
  const live = deployment.status === "running";
  const restorable = canRestore && deployment.status === "superseded" && Boolean(deployment.commit_sha);

  async function toggleLog() {
    if (buildLog !== null) {
      setExpanded((e) => !e);
      return;
    }
    setLoading(true);
    try {
      // Only the tail: a Docker build can produce thousands of lines and
      // nobody reads the middle of one in a panel.
      const res = await fetch(api(`/api/deployments/${deployment.id}?tail=500`));
      if (res.ok) {
        const data = await res.json();
        setBuildLog(data.build_log?.trim() || "(nessun log)");
        setExpanded(true);
      }
    } catch {
      setBuildLog("(impossibile leggere il log)");
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel padding="compact">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <StatusBadge status={deployment.status} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-foreground flex flex-wrap items-center gap-2 text-sm">
              <span className="truncate">{deployment.commit_message || TRIGGER_LABEL[deployment.trigger_type] || "Deploy"}</span>
              {live && <Badge tone="success">versione attuale</Badge>}
            </p>
            <p className="text-muted mt-0.5 text-xs">
              {deployment.commit_sha && <span className="font-mono">{deployment.commit_sha.slice(0, 7)} · </span>}
              {formatRelative(deployment.started_at)}
              {deployment.finished_at && ` · ${formatDurationBetween(deployment.started_at, deployment.finished_at)}`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {restorable && (
            <Button variant="ghost" size="sm" onPress={() => setRestoreOpen(true)}>
              <Icon icon="solar:history-linear" width={16} aria-hidden />
              <span className="hidden sm:inline">Ripristina</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            onPress={toggleLog}
            aria-expanded={expanded}
            aria-label={expanded ? "Nascondi il log" : "Mostra il log"}
          >
            {loading ? <Spinner /> : <Icon icon={expanded ? "solar:alt-arrow-up-linear" : "solar:document-text-linear"} width={16} />}
          </Button>
        </div>
      </div>

      {explanation && (
        <div className="bg-danger/10 mt-3 space-y-1 rounded-[var(--radius)] px-3 py-2">
          <p className="text-danger text-sm font-medium">{explanation.title}</p>
          <p className="text-foreground/80 text-sm">{explanation.hint}</p>
          {/* The raw text can be a whole `docker build` stderr dump: under
              "Dettagli", in mono, it reads as the output of the thing that failed. */}
          {deployment.error_message && (
            <Advanced summary="messaggio originale" title="Dettagli">
              <pre className="text-danger overflow-auto font-mono text-xs break-words whitespace-pre-wrap">{deployment.error_message}</pre>
            </Advanced>
          )}
        </div>
      )}

      {expanded && buildLog && (
        <pre className="border-border bg-background text-muted mt-3 max-h-96 overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs break-words whitespace-pre-wrap">
          {buildLog}
        </pre>
      )}

      {restorable && deployment.commit_sha && (
        <ConfirmDialog
          isOpen={restoreOpen}
          onOpenChange={setRestoreOpen}
          title={`Tornare a ${deployment.commit_sha.slice(0, 7)}?`}
          description="Ricostruisce e mette online questa versione. Il progetto resta fermo su questo commit, e gli aggiornamenti automatici sono sospesi, finché non torni all'ultimo commit."
          confirmLabel="Ripristina"
          onConfirm={() => onRestore(deployment.commit_sha!)}
        />
      )}
    </Panel>
  );
});

/**
 * Why this project is not on its branch, and the two ways out.
 *
 * A banner rather than a toast: being held at a commit is a state, not an
 * event, and it has to still be there when someone opens the tab tomorrow
 * wondering why a push changed nothing.
 */
const PinnedBanner = memo(function PinnedBanner({
  project,
  onOpenVersions,
  onReleasePin,
}: {
  project: Project;
  onOpenVersions: () => void;
  onReleasePin: () => void;
}) {
  if (!project.pinned_sha) return null;

  return (
    <Panel padding="compact">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <Icon icon="solar:pin-linear" width={16} className="text-warning mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="text-foreground text-sm">
              Fermo su <span className="font-mono">{project.pinned_sha.slice(0, 7)}</span>
              {project.pinned_at && ` · ${formatRelative(project.pinned_at)}`}
            </p>
            <p className="text-muted mt-0.5 text-xs">
              Ogni deploy ricostruisce questo commit di {project.source_branch}, e gli aggiornamenti automatici sono sospesi
              finché resta fermo.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button variant="ghost" size="sm" onPress={onOpenVersions}>
            Cambia versione
          </Button>
          <Button variant="outline" size="sm" onPress={onReleasePin}>
            <Icon icon="solar:rewind-back-linear" width={16} aria-hidden />
            Torna all&apos;ultimo commit
          </Button>
        </div>
      </div>
    </Panel>
  );
});

/**
 * Every deploy, newest first, with the one in progress followed live.
 *
 * A deploy that worked and was replaced can be brought back ("Ripristina"):
 * it pins the project to that commit and rebuilds it, which is what the
 * version picker already did, offered where the history is read.
 */
export const DeploymentsTab = memo(function DeploymentsTab({
  project,
  deployments,
  loading,
  onOpenVersions,
  onReleasePin,
  onRestore,
  onCancel,
}: {
  project: Project;
  deployments: Deployment[];
  loading: boolean;
  onOpenVersions: () => void;
  onReleasePin: () => void;
  onRestore: (commitSha: string) => void;
  onCancel: () => void;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const canOperate = project.permission?.level !== "read";
  const canRestore = canOperate && project.source_type === "github" && Boolean(project.source_url);
  const current = project.last_deployment && deploymentActive(project.last_deployment.status) ? project.last_deployment : null;
  const history = current ? deployments.filter((d) => d.id !== current.id) : deployments;
  const anySucceeded = deployments.some((d) => deploymentSucceeded(d.status));

  return (
    <div className="space-y-3">
      {current && (
        <Panel className="space-y-3">
          <PanelHeader
            title="Deploy in corso"
            actions={
              canOperate ? (
                <Button variant="outline" size="sm" onPress={() => setCancelOpen(true)}>
                  <Icon icon="solar:stop-linear" width={16} aria-hidden />
                  Annulla
                </Button>
              ) : undefined
            }
          />
          <LiveDeploy key={current.id} deploymentId={current.id} />
        </Panel>
      )}

      <PinnedBanner project={project} onOpenVersions={onOpenVersions} onReleasePin={onReleasePin} />

      {/* Both the skeleton and the empty state belong to the list alone: as the
          whole tab's body they hid the banner above. */}
      {loading ? (
        Array.from({ length: 3 }, (_, i) => <SkeletonBlock key={i} className="h-20" />)
      ) : history.length === 0 && !current ? (
        <Panel>
          <EmptyState icon="solar:history-linear" title="Nessun deploy" description="La cronologia comparirà qui dopo il primo deploy del progetto." />
        </Panel>
      ) : (
        history.map((d) => <DeploymentCard key={d.id} deployment={d} canRestore={canRestore && anySucceeded} onRestore={onRestore} />)
      )}

      <ConfirmDialog
        isOpen={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Annullare il deploy?"
        description="Il deploy viene interrotto e l'app si ferma: riavviala dopo, o fai un nuovo deploy."
        confirmLabel="Annulla il deploy"
        cancelLabel="Lascialo finire"
        destructive
        onConfirm={onCancel}
      />
    </div>
  );
});
