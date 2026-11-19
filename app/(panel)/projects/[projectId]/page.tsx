"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useProjectStream } from "@/lib/hooks/useProjectStream";
import { useResource } from "@/lib/hooks/useResource";
import { useUrlTab } from "@/lib/hooks/useUrlTab";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useLineBuffer } from "@/lib/hooks/useLineBuffer";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { LogLine } from "@/components/ui/LogViewer";
import { Tabs } from "@/components/ui/Tabs";
import { parseContractJson } from "@/lib/deploy-contract";

import { ProjectHeader } from "./_components/ProjectHeader";
import { EnvironmentSwitch } from "./_components/EnvironmentSwitch";
import { PreviewsPanel } from "./_components/PreviewsPanel";
import { ProjectOverview } from "./_components/ProjectOverview";
import { LogsTab } from "./_components/LogsTab";
import { DeploymentsTab } from "./_components/DeploymentsTab";
import { ProjectEnvTab } from "./_components/EnvTab";
import { LoadError } from "@/components/ui/LoadError";
import { EmptyState } from "@/components/ui/EmptyState";
import { TerminalTab } from "./_components/TerminalTab";
import { SettingsTab } from "./_components/SettingsTab";
import { VersionDialog } from "./_components/VersionDialog";
import { FilesTab } from "./_components/FilesTab";
import type { Deployment, EnvironmentsResponse, ProcessInfo, Project, SettingsSectionId, TabId } from "./_components/types";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { locateMember } from "@/lib/locate-member";
import { projectControlText } from "@/lib/status";

/**
 * Orchestrates the project view: it owns the single event stream and the shared
 * state, and hands each tab exactly what it needs.
 *
 * Tabs, in order: Panoramica (the default: how it is and what to do next),
 * Deploy, Log, Variabili, File, Terminale (containers only), Impostazioni.
 */

const MAX_LOG_LINES = 2000;
const TAB_IDS: TabId[] = ["overview", "deployments", "logs", "env", "files", "terminal", "settings"];

/** Monotonic ids so log rows keep a stable key when the buffer is trimmed. */
let lineSeq = 0;
function toLine(text: string, stream: LogLine["stream"] = "stdout"): LogLine {
  return { id: ++lineSeq, text, stream };
}

export default function ProjectDetailPage() {
  const api = useNodeApi();
  const href = useServerHref();
  const { isSolo, selected } = useNode();
  const poll5000 = usePollInterval(5000);
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [activeTab, setActiveTab] = useUrlTab(TAB_IDS, "overview");

  const [project, setProject] = useState<Project | null>(null);
  useCrumbLabel(projectId, project?.name);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);

  // Batched: a build emits faster than React can usefully re-render, and each
  // of these holds up to MAX_LOG_LINES rows.
  const processLog = useLineBuffer<LogLine>(MAX_LOG_LINES);
  const deployLog = useLineBuffer<LogLine>(MAX_LOG_LINES);
  const termLines = useLineBuffer<LogLine>(MAX_LOG_LINES);
  const operationLog = useLineBuffer<LogLine>(MAX_LOG_LINES);
  const [shellActive, setShellActive] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // The tab row is plain buttons, so leaving Variabili would drop unsaved
  // edits without the page's leave guard ever seeing it: asked here instead.
  const [envDirty, setEnvDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<TabId | null>(null);

  const prevStatus = useRef<string | undefined>(undefined);
  const refreshDeploymentsRef = useRef<(() => Promise<unknown>) | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const refreshProject = useCallback(
    (signal?: AbortSignal) =>
      fetch(api(`/api/projects/${projectId}`), { signal })
        .then(async (res) => {
          // Only a 404 means the project is gone. Anything else (a 500, a
          // dropped connection mid-deploy) keeps the page where it is.
          if (res.status === 404) {
            // In a cluster the link may have been made on another server:
            // follow the project there before giving up.
            if (!isSolo) {
              const memberId = await locateMember("project", projectId);
              if (memberId && memberId !== selected) {
                const tabNow = new URLSearchParams(window.location.search).get("tab");
                const tab = tabNow ? `?tab=${encodeURIComponent(tabNow)}` : "";
                router.replace(href(`/projects/${projectId}${tab}`, memberId));
                return null;
              }
            }
            router.push(href("/home"));
            return null;
          }
          if (!res.ok) throw new Error(`Il server ha risposto ${res.status}`);
          return res.json();
        })
        .then((p: Project | null) => {
          if (!p) return;
          setLoadError(null);
          setProject(p);
          prevStatus.current = p.status;
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setLoadError(err instanceof Error ? err.message : MSG.unreachable);
        }),
    [projectId, router, api, href, isSolo, selected]
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshProject(controller.signal);
    return () => controller.abort();
  }, [refreshProject]);

  // One stream carries deploy progress, build output, process output and
  // terminal output.
  const { connected } = useProjectStream(projectId, (event) => {
    switch (event.type) {
      case "deploy:log":
        deployLog.push(toLine(event.line));
        break;
      case "process:log":
        processLog.push(toLine(event.line, event.stream));
        break;
      case "process:reset":
        // A new run starts from an empty log on the server; the buffer follows.
        processLog.reset();
        break;
      case "terminal:output":
        termLines.push(toLine(event.text));
        break;
      case "terminal:closed":
        setShellActive(false);
        break;
      case "ready":
        // The stream replays what an operation in flight has said so far.
        operationLog.reset();
        break;
      case "mount:log":
        operationLog.push(toLine(event.line));
        break;
      case "mount:phase":
        void refreshProject();
        break;
      case "deploy:status": {
        const previous = prevStatus.current;
        prevStatus.current = event.status;
        if (event.status === "building") deployLog.reset();
        if (previous !== "running" && event.status === "running") toast.success("Deploy completato");
        if (event.status === "failed") toast.error(event.message ?? "Deploy fallito");
        void refreshProject();
        void refreshDeploymentsRef.current?.();
        break;
      }
    }
  });

  // Process stats are a snapshot, not an event, so they still poll — but the
  // hook stops while the tab is hidden.
  const { data: statusData } = useResource<{ status?: string; process?: ProcessInfo | null }>(
    api(`/api/projects/${projectId}/status`),
    { intervalMs: poll5000 }
  );
  const processInfo = statusData?.process ?? null;

  // The family for the switch at the top. Its statuses change with the
  // siblings' deploys, which this page's stream does not carry: polled, slowly.
  const poll15000 = usePollInterval(15000);
  const { data: environments } = useResource<EnvironmentsResponse>(
    api(`/api/projects/${projectId}/environments`),
    { intervalMs: poll15000 }
  );
  const family = environments?.family ?? null;

  // The row changes without a deploy too (a crash noticed by the sweep, a
  // scheduled restart, someone else pressing Stop): when the polled status
  // disagrees, the project is read again.
  const polledStatus = statusData?.status;
  const shownStatus = project?.status;
  useEffect(() => {
    if (polledStatus && shownStatus && polledStatus !== shownStatus) void refreshProject();
  }, [polledStatus, shownStatus, refreshProject]);

  // Seed the process log from the saved archive, which keeps each line's
  // stream; the event stream carries it from there. A server of the cluster
  // still on an older version has no archive: its plain tail, as before.
  // Depends on `reset`, which is stable, rather than on the rebuilt buffer.
  const resetProcessLog = processLog.reset;
  useEffect(() => {
    if (activeTab !== "logs") return;
    const controller = new AbortController();
    const signal = controller.signal;
    (async () => {
      const saved = await fetch(api(`/api/projects/${projectId}/logs/app?lines=500`), { signal });
      if (saved.ok) {
        const data = (await saved.json()) as { entries?: { stream?: string; text: string }[] };
        resetProcessLog((data.entries ?? []).map((e) => toLine(e.text, e.stream === "stderr" ? "stderr" : "stdout")));
        return;
      }
      const tail = await fetch(api(`/api/projects/${projectId}/logs?source=process`), { signal });
      const data = (tail.ok ? await tail.json() : { logs: [] }) as { logs?: string[] };
      resetProcessLog((data.logs ?? []).map((l) => toLine(l)));
    })().catch(() => {});
    return () => controller.abort();
  }, [activeTab, projectId, resetProcessLog, api]);

  const {
    data: deploymentsData,
    loading: deploymentsLoading,
    error: deploymentsError,
    refresh: refreshDeployments,
  } = useResource<Deployment[]>(activeTab === "deployments" ? api(`/api/projects/${projectId}/logs`) : null);
  // Read by the stream handler, which is registered once: a deploy that
  // settles while the history is open refreshes it.
  useEffect(() => {
    refreshDeploymentsRef.current = activeTab === "deployments" ? refreshDeployments : null;
  }, [activeTab, refreshDeployments]);
  const deployments = useMemo(() => (Array.isArray(deploymentsData) ? deploymentsData : []), [deploymentsData]);

  // The env tab explains which prefixes reach the build, and the project can
  // have redefined them in its contract.
  const buildEnvPrefixes = useMemo(() => parseContractJson(project?.builder_config).buildEnvPrefixes, [project?.builder_config]);

  /**
   * Start a deploy, optionally of one specific commit.
   *
   * With a `commitSha` the route pins the project to it first, so from then on
   * Deploy rebuilds that commit and auto-deploy stays suspended until the pin is
   * released. `branch` is persisted first when the version dialog picked a
   * different one.
   */
  const sourceBranch = project?.source_branch;
  const startDeploy = useCallback(
    async (mode: "deploy" | "rebuild", options: { commitSha?: string; branch?: string } = {}) => {
      setDeploying(true);
      try {
        if (options.branch && options.branch !== sourceBranch) {
          const patch = await fetch(api(`/api/projects/${projectId}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sourceBranch: options.branch }),
          });
          if (!patch.ok) {
            const data = await patch.json().catch(() => ({}));
            toast.error(data.details?.[0]?.message ?? data.error ?? "Salvataggio non riuscito");
            return;
          }
          setProject(await patch.json());
        }

        const res = await fetch(api(`/api/projects/${projectId}/deploy`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, ...(options.commitSha ? { commitSha: options.commitSha } : {}) }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.details?.[0]?.message ?? data.error ?? "Avvio non riuscito");
          return;
        }
        toast.success(
          data.status === "queued"
            ? "Messo in coda dopo il deploy in corso"
            : options.commitSha
              ? `Deploy di ${options.commitSha.slice(0, 7)} avviato`
              : "Deploy avviato"
        );
        if (data.status !== "queued") setProject((p) => (p ? { ...p, status: "deploying" } : p));
        // The pin and the new deployment live on the row: read it again.
        void refreshProject();
      } catch {
        toast.error("Avvio non riuscito");
      } finally {
        setDeploying(false);
      }
    },
    [projectId, refreshProject, api, sourceBranch]
  );

  // Stable, like everything the memo()'d header and tabs receive: one inline
  // arrow would re-render them on every log line.
  const handleDeploy = useCallback((mode: "deploy" | "rebuild") => void startDeploy(mode), [startDeploy]);
  const handleRestore = useCallback((commitSha: string) => void startDeploy("deploy", { commitSha }), [startDeploy]);

  // Not closed here: the dialog closes itself once this settles.
  async function handleDeployCommit(commitSha: string, branch: string) {
    await startDeploy("deploy", { commitSha, branch });
  }

  /** Release the pin and go back to the branch, in one request. */
  const handleReleasePin = useCallback(async () => {
    setDeploying(true);
    try {
      const res = await fetch(api(`/api/projects/${projectId}/pin`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", deploy: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Sblocco non riuscito");
        return;
      }
      toast.success(`Sbloccato: distribuisco l'ultimo commit di ${data.branch ?? "branch"}`);
      void refreshProject();
    } catch {
      toast.error("Sblocco non riuscito");
    } finally {
      setDeploying(false);
    }
  }, [projectId, refreshProject, api]);

  const openVersions = useCallback(() => setVersionsOpen(true), []);

  const handleRename = useCallback(
    async (name: string) => {
      const res = await fetch(api(`/api/projects/${projectId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Rinomina non riuscita");
        return false;
      }
      const updated = await res.json();
      setProject((p) => (p ? { ...p, name: updated.name } : p));
      toast.success("Progetto rinominato");
      return true;
    },
    [projectId, api]
  );

  const handleControl = useCallback(
    async (action: "start" | "stop" | "restart") => {
      try {
        const res = await fetch(api(`/api/projects/${projectId}/control`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          const data = await res.json();
          toast.error(data.error ?? projectControlText(action).failed);
          return;
        }
        toast.success(projectControlText(action).done);
        void refreshProject();
      } catch {
        toast.error(projectControlText(action).failed);
      }
    },
    [projectId, refreshProject, api]
  );
  const handleCancelDeploy = useCallback(() => void handleControl("stop"), [handleControl]);

  /** Switch tab, asking first when the variables have unsaved edits. */
  const changeTab = useCallback(
    (next: TabId) => {
      if (activeTab === "env" && envDirty && next !== "env") {
        setPendingTab(next);
        return;
      }
      setActiveTab(next);
    },
    [activeTab, envDirty, setActiveTab]
  );

  /** Open a tab, and in the settings a section of the side menu. */
  const goTo = useCallback(
    (tab: TabId, section?: SettingsSectionId) => {
      if (section) {
        const query = new URLSearchParams(window.location.search);
        if (section === "general") query.delete("section");
        else query.set("section", section);
        window.history.replaceState(null, "", `${window.location.pathname}?${query.toString()}`);
      }
      changeTab(tab);
    },
    [changeTab]
  );

  const canManage = (project?.permission?.level ?? "manage") === "manage";
  const tabs = useMemo(() => {
    if (!project) return [];
    return [
      { id: "overview" as TabId, label: "Panoramica", icon: "solar:widget-2-linear" },
      { id: "deployments" as TabId, label: "Deploy", icon: "solar:history-linear" },
      { id: "logs" as TabId, label: "Log", icon: "solar:document-text-linear" },
      { id: "env" as TabId, label: "Variabili", icon: "solar:key-linear" },
      // Files are part of managing the project; below that the API refuses them.
      ...(canManage ? [{ id: "files" as TabId, label: "File", icon: "solar:folder-with-files-linear" }] : []),
      ...(project.runtime_type === "docker" && (project.permission?.terminal ?? true)
        ? [{ id: "terminal" as TabId, label: "Terminale", icon: "solar:monitor-linear" }]
        : []),
      ...(canManage ? [{ id: "settings" as TabId, label: "Impostazioni", icon: "solar:settings-linear" }] : []),
    ];
  }, [project, canManage]);

  // A failed first load says so; a failed refresh keeps the page it has.
  if (!project && loadError) {
    return <LoadError what="il progetto" error={loadError} onRetry={() => void refreshProject()} className="p-4" />;
  }
  if (loading || !project) return <PageSkeleton />;

  // A remembered tab this account does not have shows the overview instead.
  const shownTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : "overview";
  const neverDeployed = !project.last_deploy_at && project.status !== "deploying" && deployLog.lines.length === 0;

  return (
    <div>
      <EnvironmentSwitch project={project} family={family} />
      <ProjectHeader
        project={project}
        family={family}
        busy={deploying}
        onDeploy={handleDeploy}
        onControl={handleControl}
        onRename={handleRename}
        onOpenVersions={openVersions}
        onReleasePin={handleReleasePin}
        onGoTo={goTo}
      />

      <Tabs tabs={tabs} value={shownTab} onChange={changeTab} label="Sezioni del progetto" />

      {/* Each tab is mounted only while selected. */}
      {shownTab === "overview" && (
        <ProjectOverview
          project={project}
          processInfo={processInfo}
          busy={deploying}
          onDeploy={handleDeploy}
          onControl={handleControl}
          onGoTo={goTo}
        />
      )}
      {/* Production's pull requests and their previews, under its own overview. */}
      {shownTab === "overview" && !project.environment_of && project.source_type === "github" && <PreviewsPanel project={project} />}

      {shownTab === "deployments" && deploymentsError && !deploymentsData && (
        <LoadError what="i deploy" error={deploymentsError} onRetry={() => void refreshDeployments()} />
      )}
      {shownTab === "deployments" && !(deploymentsError && !deploymentsData) && (
        <DeploymentsTab
          project={project}
          deployments={deployments}
          loading={deploymentsLoading}
          onOpenVersions={openVersions}
          onReleasePin={handleReleasePin}
          onRestore={handleRestore}
          onCancel={handleCancelDeploy}
        />
      )}

      {shownTab === "logs" && neverDeployed && (
        <EmptyState
          icon="solar:rocket-2-linear"
          title="Ancora nessun deploy"
          description={
            canManage
              ? "Quando l'app sarà online, qui comparirà quello che scrive mentre gira."
              : "Quando qualcuno la distribuirà, qui comparirà quello che scrive mentre gira."
          }
          action={
            canManage ? (
              <Button size="sm" variant="secondary" onPress={() => goTo("overview")}>
                Vai alla panoramica
              </Button>
            ) : undefined
          }
          className="border-border rounded-[var(--radius)] border border-dashed"
        />
      )}
      {shownTab === "logs" && !neverDeployed && (
        <LogsTab
          deployLog={deployLog.lines}
          processLog={processLog.lines}
          connected={connected}
          projectId={projectId}
          deploying={project.status === "deploying"}
          deploymentId={project.last_deployment?.id}
          runtimeType={project.runtime_type}
        />
      )}

      {/* Fetches its variables on every visit: see ProjectEnvTab. */}
      {shownTab === "env" && (
        <ProjectEnvTab
          projectId={projectId}
          runtimeType={project.runtime_type}
          buildEnvPrefixes={buildEnvPrefixes}
          readOnly={!canManage}
          onDirtyChange={setEnvDirty}
        />
      )}

      {shownTab === "files" && (
        <FilesTab projectId={projectId} runtimeType={project.runtime_type} onGoToOverview={() => goTo("overview")} />
      )}

      {shownTab === "terminal" && (
        <TerminalTab
          projectId={projectId}
          lines={termLines.lines}
          active={shellActive}
          onActiveChange={setShellActive}
          onLocalEcho={(text) => termLines.push(toLine(text))}
        />
      )}

      {shownTab === "settings" && (
        <SettingsTab
          project={project}
          onProjectChange={(update) => setProject((prev) => (typeof update === "function" ? (prev ? update(prev) : prev) : update))}
          onRefresh={() => void refreshProject()}
          onDeploy={() => void startDeploy("deploy")}
          operationLines={operationLog.lines}
        />
      )}

      <ConfirmDialog
        isOpen={pendingTab !== null}
        onOpenChange={(open) => !open && setPendingTab(null)}
        title="Uscire senza salvare le variabili?"
        description="Le modifiche alle variabili non salvate andranno perse."
        confirmLabel="Esci senza salvare"
        cancelLabel="Resta"
        destructive
        onConfirm={() => {
          const next = pendingTab;
          setEnvDirty(false);
          setPendingTab(null);
          if (next) setActiveTab(next);
        }}
      />

      {/* Keyed on the open state so each opening starts from the project as it is now. */}
      <VersionDialog
        key={versionsOpen ? "versions-open" : "versions-closed"}
        isOpen={versionsOpen}
        onOpenChange={setVersionsOpen}
        project={project}
        onDeployCommit={handleDeployCommit}
      />
    </div>
  );
}
