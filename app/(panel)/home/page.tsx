"use client";

import { memo, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Button, Dropdown, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useMemberApi, useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { useClusterList } from "@/lib/hooks/useClusterList";
import type { Located } from "@/lib/cluster-merge";
import { ServerBadge, ServerFilter, UnreachableServers } from "@/components/cluster/ServerBits";
import { PageHeader } from "@/components/ui/PageHeader";
import { LinkButton } from "@/components/ui/LinkButton";
import { LoadError } from "@/components/ui/LoadError";
import { Panel } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { StatTile } from "@/components/ui/StatTile";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormDialog } from "@/components/ui/FormDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { HealthBanner } from "@/components/HealthBanner";
import { ClusterOverview } from "@/components/ClusterOverview";
import { statusMeta, TONE_DOT } from "@/lib/status";
import { formatBytes, formatUptime } from "@/lib/format";
import {
  distinctFolderNames,
  groupOverview,
  itemKey,
  moveFailureText,
  serverSections,
  uniqueFolders,
  withLastSeen,
  type FolderLike,
} from "@/lib/overview-groups";
import { PROJECT_ACTIONS, SERVICE_ACTIONS, rowAllows, type Access } from "@/lib/authz";
import { cn } from "@/lib/utils";
import { useCan, useMe } from "@/lib/hooks/useMe";
import { serviceDisplayName } from "@/lib/service-name";
import { deployCountLabel, engineLabel, engineWithVersion, runtimeLabel } from "@/lib/labels";
import { Technical } from "@/components/ui/Technical";
import { OverviewStatus } from "@/components/overview/OverviewStatus";
import { SetupChecklist } from "@/components/overview/SetupChecklist";
import { ActivityFeed } from "@/components/overview/ActivityFeed";
import { useHostTrend } from "@/components/metrics/useHostTrend";

interface Service {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  version: string;
  status: string;
  port: number;
  project_id: string | null;
  folder_id: string | null;
  permission?: Access;
  /** A last known copy: the server holding it did not answer. */
  unreachable?: boolean;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: string;
  source_url: string | null;
  runtime_type: string;
  status: string;
  port: number | null;
  deploy_count: number;
  folder_id: string | null;
  services: Service[];
  /** Where it answers; absent from servers that do not send it yet. */
  hosts?: { hostname: string; url: string }[];
  permission?: Access;
  /** A last known copy: the server holding it did not answer. */
  unreachable?: boolean;
}

interface Folder extends FolderLike {
  created_at: string;
  updated_at: string;
  permission?: Access;
}

interface Metrics {
  cpu: { usage: number; cores: number };
  memory: { total: number; used: number };
  disk: { total: number; used: number; free: number };
  uptime: number;
}

/** Sentinel for the section that is not a folder. */
const LOOSE_SERVICES = "__loose-services";

/**
 * Which sections are closed, per browser.
 *
 * localStorage rather than the store: the server has one answer for every
 * device, and which folders someone keeps shut on a phone has nothing to do
 * with what they keep open on a desk. Every read and write is guarded because
 * a private window, a blocked origin or a thumbnail capture can each throw.
 */
const COLLAPSED_KEY = "runpanel.home.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* nothing to do: the section still toggles, it just will not be remembered */
  }
}

const TYPE_ICONS: Record<string, string> = {
  postgresql: "solar:database-linear",
  mysql: "solar:database-linear",
  mongodb: "solar:database-linear",
  redis: "solar:bolt-linear",
};

async function patchJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true, status: res.status };
  const data = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, error: typeof data.error === "string" ? data.error : undefined };
}

/** A card links to what it shows, unless the server holding it is not answering. */
function CardBody({ href, className, children }: { href: string | null; className: string; children: React.ReactNode }) {
  if (!href) return <div className={className}>{children}</div>;
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

/**
 * The "⋯" on a card: where this card is filed, and where else it could go.
 *
 * One click, no dialog. The folders are few and named, so listing them is
 * quicker than a picker, and the current one is marked rather than hidden so
 * the menu also answers "which folder am I in" for a card seen out of context.
 */
function MoveMenu({
  label,
  folderId,
  folders,
  onMove,
}: {
  label: string;
  folderId: string | null;
  folders: FolderLike[];
  onMove: (folderId: string | null) => void;
}) {
  return (
    <Dropdown>
      <Button
        variant="ghost"
        size="sm"
        isIconOnly
        aria-label={`Azioni per ${label}`}
        className="text-muted hover:text-foreground -my-1 h-7 w-7 min-w-0 shrink-0"
      >
        <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label={`Sposta ${label}`}
          onAction={(key) => onMove(key === "root" ? null : String(key))}
        >
          <Dropdown.Section>
            <Dropdown.Item id="root" textValue="Nessuna cartella" isDisabled={folderId === null}>
              <Icon icon="solar:home-2-linear" width={14} aria-hidden />
              <span className="flex-1">Nessuna cartella</span>
              {folderId === null && <Icon icon="solar:check-read-linear" width={14} aria-hidden />}
            </Dropdown.Item>
            {folders.map((folder) => (
              <Dropdown.Item
                key={folder.id}
                id={folder.id}
                textValue={folder.name}
                isDisabled={folder.id === folderId}
              >
                <Icon icon="solar:folder-linear" width={14} aria-hidden />
                <span className="flex-1 truncate">{folder.name}</span>
                {folder.id === folderId && <Icon icon="solar:check-read-linear" width={14} aria-hidden />}
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** Memoised so a 5-second metrics refresh does not re-render every card. */
const ProjectCard = memo(function ProjectCard({
  project,
  folders,
  onMove,
  link,
  showServer,
}: {
  project: Located<Project>;
  folders: FolderLike[];
  onMove: (memberId: string, projectId: string, folderId: string | null) => void;
  link: (href: string, memberId: string) => string;
  showServer: boolean;
}) {
  return (
    <Panel interactive={!project.unreachable} padding="compact" className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <CardBody
          href={project.unreachable ? null : link(`/projects/${project.id}`, project.memberId)}
          className="flex min-w-0 flex-1 items-start justify-between gap-3"
        >
          <div className="min-w-0">
            {/* Wraps for the same reason as a row of /services: the name must not be what gives way. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-foreground max-w-full truncate text-sm font-medium">{project.name}</h3>
              <StatusBadge status={project.status} />
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              {showServer && <ServerBadge memberId={project.memberId} />}
              <p className="text-muted truncate text-xs">
                {/* The address first, when there is one: it is what people come to open. */}
                {project.hosts?.[0] ? (
                  <span className="text-foreground/80 font-mono">{project.hosts[0].hostname}</span>
                ) : (
                  runtimeLabel(project.runtime_type)
                )}
                {" · "}
                {deployCountLabel(project.deploy_count)}
                {project.port ? (
                  <Technical>
                    <span className="font-mono"> · :{project.port}</span>
                  </Technical>
                ) : null}
              </p>
            </div>
          </div>
          {!project.unreachable && (
            <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted mt-0.5 shrink-0" aria-hidden />
          )}
        </CardBody>
        {/* Filing is written on the server that holds the project, which is not answering. */}
        {!project.unreachable && rowAllows(project, PROJECT_ACTIONS.settings) && (
          <MoveMenu
            label={project.name}
            folderId={project.folder_id}
            folders={folders}
            onMove={(folderId) => onMove(project.memberId, project.id, folderId)}
          />
        )}
      </div>

      {project.services.length > 0 && (
        <ul className="border-border flex flex-wrap gap-1.5 border-t pt-3">
          {project.services.map((service) => {
            const meta = statusMeta(service.status);
            return (
              <li key={service.id}>
                <Link
                  href={link(`/services/${service.id}`, project.memberId)}
                  className="border-border bg-surface-secondary hover:bg-surface-hover flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs transition-colors"
                >
                  <span className={cn("size-1.5 rounded-full", TONE_DOT[meta.tone])} aria-hidden />
                  <span className="text-foreground">{serviceDisplayName(service)}</span>
                  <span className="text-muted">{engineLabel(service.type)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
});

/**
 * A service that belongs to no project, which used to be invisible here: the
 * Overview listed services only as chips under the project they were linked
 * to, so a standalone Redis was a thing you had to remember existed.
 */
const ServiceCard = memo(function ServiceCard({
  service,
  folders,
  onMove,
  link,
  showServer,
}: {
  service: Located<Service>;
  folders: FolderLike[];
  onMove: (memberId: string, serviceId: string, folderId: string | null) => void;
  link: (href: string, memberId: string) => string;
  showServer: boolean;
}) {
  return (
    <Panel interactive={!service.unreachable} padding="compact" className="flex items-center gap-2">
      <CardBody
        href={service.unreachable ? null : link(`/services/${service.id}`, service.memberId)}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <Icon
          icon={TYPE_ICONS[service.type] ?? "solar:database-linear"}
          width={20}
          className="text-muted shrink-0"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-foreground max-w-full truncate text-sm font-medium">{serviceDisplayName(service)}</h3>
            <StatusBadge status={service.status} />
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {showServer && <ServerBadge memberId={service.memberId} />}
            <p className="text-muted truncate text-xs">
              {engineWithVersion(service.type, service.version)}
              <Technical>
                <span className="font-mono"> · :{service.port}</span>
              </Technical>
            </p>
          </div>
        </div>
        {!service.unreachable && <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted shrink-0" aria-hidden />}
      </CardBody>
      {!service.unreachable && rowAllows(service, SERVICE_ACTIONS.settings) && (
        <MoveMenu
          label={serviceDisplayName(service)}
          folderId={service.folder_id}
          folders={folders}
          onMove={(folderId) => onMove(service.memberId, service.id, folderId)}
        />
      )}
    </Panel>
  );
});

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function countLabel(projects: number, services: number, none = "Vuota"): string {
  const parts: string[] = [];
  if (projects > 0) parts.push(projects === 1 ? "1 progetto" : `${projects} progetti`);
  if (services > 0) parts.push(services === 1 ? "1 servizio" : `${services} servizi`);
  return parts.length > 0 ? parts.join(" · ") : none;
}

type FolderDialog =
  | { kind: "create" }
  | { kind: "rename"; folder: Located<Folder> }
  | { kind: "delete"; folder: Located<Folder> }
  | null;

interface CardProps {
  folders: FolderLike[];
  onMoveProject: (memberId: string, projectId: string, folderId: string | null) => void;
  onMoveService: (memberId: string, serviceId: string, folderId: string | null) => void;
  link: (href: string, memberId: string) => string;
  showServer: boolean;
}

/**
 * The cards of one group. The key names the server: two servers can hold rows
 * with the same id, and a folder can hold rows of both.
 */
function Cards({
  projects,
  services,
  folders,
  onMoveProject,
  onMoveService,
  link,
  showServer,
}: CardProps & { projects: Located<Project>[]; services: Located<Service>[] }) {
  return (
    <CardGrid>
      {projects.map((project) => (
        <ProjectCard
          key={itemKey(project.memberId, project.id)}
          project={project}
          folders={folders}
          onMove={onMoveProject}
          link={link}
          showServer={showServer}
        />
      ))}
      {services.map((service) => (
        <ServiceCard
          key={itemKey(service.memberId, service.id)}
          service={service}
          folders={folders}
          onMove={onMoveService}
          link={link}
          showServer={showServer}
        />
      ))}
    </CardGrid>
  );
}

/** What a server holds outside every folder, the way the Overview always listed it. */
function ServerRoot({
  memberId,
  projects,
  services,
  hasFolders,
  collapsed,
  rememberExpanded,
  ...cards
}: CardProps & {
  memberId: string;
  projects: Located<Project>[];
  services: Located<Service>[];
  hasFolders: boolean;
  collapsed: Set<string>;
  rememberExpanded: (id: string, expanded: boolean) => void;
}) {
  const looseKey = `${LOOSE_SERVICES}:${memberId}`;
  return (
    <div className="space-y-4">
      {projects.length > 0 && (
        <div>
          {hasFolders && (
            <h2 className="text-muted mb-2 px-1 text-xs font-medium tracking-wide uppercase">Progetti senza cartella</h2>
          )}
          <Cards {...cards} projects={projects} services={[]} />
        </div>
      )}

      {services.length > 0 && (
        <Section
          title={
            <span className="flex items-center gap-2">
              <Icon icon="solar:database-linear" width={16} className="text-muted shrink-0" aria-hidden />
              Servizi senza progetto
            </span>
          }
          summary={countLabel(0, services.length)}
          defaultExpanded={!collapsed.has(looseKey)}
          onExpandedChange={(expanded) => rememberExpanded(looseKey, expanded)}
        >
          <Cards {...cards} projects={[]} services={services} />
        </Section>
      )}
    </div>
  );
}

export default function HomePage() {
  // Every endpoint goes through the shared hooks, so they stop polling when
  // the tab is hidden and never overlap requests.
  const api = useNodeApi();
  const memberApi = useMemberApi();
  const href = useServerHref();
  const { isSolo, nodes, selfId, serverParam, nameOf } = useNode();
  const poll5000 = usePollInterval(5000);

  const {
    items: projects,
    offline: offlineProjects,
    failed,
    loading: projectsLoading,
    error: projectsError,
    refresh: refreshProjects,
  } = useClusterList<Project>("/api/cluster/projects", "/api/projects", { intervalMs: poll5000 });
  const {
    items: services,
    offline: offlineServices,
    error: servicesError,
    refresh: refreshServices,
  } = useClusterList<Service>("/api/cluster/services", "/api/services", { intervalMs: poll5000 });
  // A folder is the same on every server, so the filter by server does not
  // narrow this list: a server that is down still has its folders to sit in.
  const {
    items: folderRows,
    error: foldersError,
    refresh: refreshFolders,
  } = useClusterList<Folder>("/api/cluster/folders", "/api/folders", {
    intervalMs: poll5000,
    everyServer: true,
  });
  const folders = useMemo(() => uniqueFolders(folderRows ?? []), [folderRows]);
  // What the page shows; `folders` keeps the real names for the rename dialog.
  const namedFolders = useMemo(() => distinctFolderNames(folders), [folders]);
  const shownProjects = useMemo(
    () => withLastSeen(projects ?? [], offlineProjects, { status: "unreachable", deploy_count: 0, services: [] }),
    [projects, offlineProjects]
  );
  const shownServices = useMemo(
    () => withLastSeen(services ?? [], offlineServices, { status: "unreachable" }),
    [services, offlineServices]
  );
  const error = projectsError ?? servicesError;
  const canMonitor = useCan("monitor");
  const canCreate = useCan("projects.create");
  // Folders are the whole panel's: see the folders route.
  const me = useMe();
  const canCreateFolder = canCreate && me.seesEverything;
  // In a cluster the server cards above carry the metrics of every server.
  const { data: metrics } = useResource<Metrics>(canMonitor && isSolo ? api("/api/metrics") : null, { intervalMs: poll5000 });
  // The last hour under each number, from the metrics history.
  const trend = useHostTrend(canMonitor && isSolo);

  // Read once, on the client, and only consulted when a section first mounts:
  // the sections are uncontrolled from then on, so a poll never snaps one shut.
  const [collapsed] = useState(readCollapsed);
  const rememberExpanded = useCallback(
    (id: string, expanded: boolean) => {
      if (expanded) collapsed.delete(id);
      else collapsed.add(id);
      writeCollapsed(collapsed);
    },
    [collapsed]
  );

  const [dialog, setDialog] = useState<FolderDialog>(null);
  const [nameValue, setNameValue] = useState("");

  // The filing is written on the server that holds the card.
  const moveFailed = useCallback(
    (memberId: string, folderId: string | null, result: { status: number; error?: string }) => {
      const folder = namedFolders.find((f) => f.id === folderId);
      toast.error(moveFailureText(result, { solo: isSolo, serverName: nameOf(memberId), folder }));
    },
    [isSolo, nameOf, namedFolders]
  );

  const moveProject = useCallback(
    async (memberId: string, projectId: string, folderId: string | null) => {
      const result = await patchJson(memberApi(memberId, `/api/projects/${projectId}`), { folderId });
      if (!result.ok) moveFailed(memberId, folderId, result);
      await refreshProjects();
    },
    [memberApi, moveFailed, refreshProjects]
  );

  const moveService = useCallback(
    async (memberId: string, serviceId: string, folderId: string | null) => {
      const result = await patchJson(memberApi(memberId, `/api/services/${serviceId}`), { folderId });
      if (!result.ok) moveFailed(memberId, folderId, result);
      await refreshServices();
    },
    [memberApi, moveFailed, refreshServices]
  );

  const onFolderAction = useCallback((action: "rename" | "delete", folder: Located<Folder>) => {
    setNameValue(action === "rename" ? folder.name : "");
    setDialog({ kind: action, folder });
  }, []);

  function openCreate() {
    setNameValue("");
    setDialog({ kind: "create" });
  }

  async function submitFolderName() {
    const name = nameValue.trim();
    if (!dialog || dialog.kind === "delete" || !name) return;
    const isRename = dialog.kind === "rename";
    // Created on this panel, whatever server is on screen: it reaches the others by itself.
    const memberId = isRename ? dialog.folder.memberId : selfId;
    const res = await fetch(memberApi(memberId, isRename ? `/api/folders/${dialog.folder.id}` : "/api/folders"), {
      method: isRename ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? (isRename ? "Rinomina non riuscita" : "Creazione non riuscita"));
      // Keeps the dialog open on what was typed.
      return false;
    }
    await refreshFolders();
  }

  async function deleteFolder() {
    if (dialog?.kind !== "delete") return;
    const res = await fetch(memberApi(dialog.folder.memberId, `/api/folders/${dialog.folder.id}`), { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Eliminazione non riuscita");
      return;
    }
    // Its contents moved to the root, so the two lists that carry `folder_id`
    // are stale as well as the folder list itself.
    await Promise.all([refreshFolders(), refreshProjects(), refreshServices()]);
  }

  // Folders first, shared by every server; then what each server holds outside
  // them, this server first. Solo mode is one section with no heading.
  const grouped = useMemo(() => groupOverview(namedFolders, shownProjects, shownServices), [namedFolders, shownProjects, shownServices]);
  const servers = useMemo(() => {
    if (isSolo) return [{ id: selfId ?? "", name: "" }];
    return nodes
      .filter((n) => !serverParam || n.id === serverParam)
      .sort((a, b) => (a.id === selfId ? -1 : b.id === selfId ? 1 : a.name.localeCompare(b.name)))
      .map((n) => ({ id: n.id, name: n.name }));
  }, [isSolo, selfId, nodes, serverParam]);
  const sections = useMemo(() => {
    const down = new Set(failed.map((f) => f.id));
    // A server that did not answer and left nothing behind has nothing to show:
    // saying it holds nothing would be a claim about a server nobody heard from.
    return serverSections(servers.map((s) => s.id), grouped).filter((s) => !(s.empty && down.has(s.memberId)));
  }, [servers, grouped, failed]);

  if (projectsLoading && !projects) return <PageSkeleton />;

  const memoryPercent = metrics?.memory.total ? (metrics.memory.used / metrics.memory.total) * 100 : undefined;
  const diskPercent = metrics?.disk.total ? (metrics.disk.used / metrics.disk.total) * 100 : undefined;

  // Not "nothing" when the list simply failed to arrive: that showed the
  // create-your-first-project invitation next to the error.
  const nothingAtAll =
    !(error && !projects) &&
    shownProjects.length === 0 &&
    shownServices.length === 0 &&
    folders.length === 0 &&
    failed.length === 0;

  const showServer = !isSolo && !serverParam;
  const cards = { folders: namedFolders, onMoveProject: moveProject, onMoveService: moveService, link: href };

  return (
    <>
      <PageHeader
        title="Panoramica"
        description={isSolo ? "Progetti, servizi e stato della macchina" : "Progetti, servizi e stato di ogni server"}
        actions={
          <>
            <ServerFilter />
            {canCreate && (
              <>
                {canCreateFolder && (
                  <Button variant="ghost" onPress={openCreate}>
                    <Icon icon="solar:folder-with-files-linear" width={16} aria-hidden />
                    Nuova cartella
                  </Button>
                )}
                {/* The page's one primary action. A Link, not window.location:
                    the latter is a full page reload, where client-side
                    navigation is instant. */}
                <LinkButton href={href("/projects/new")} variant="primary">
                  <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                  Nuovo progetto
                </LinkButton>
              </>
            )}
          </>
        }
      />

      {/* Above the metrics on purpose: a number that is merely interesting
          should never sit above a problem that needs doing. The apps first,
          then the machine they run on. */}
      <OverviewStatus projects={shownProjects} services={shownServices} link={href} />
      <HealthBanner />

      {/* Every server at a glance, in a cluster. */}
      <ClusterOverview />

      {/* Host metrics are for accounts with the monitor permission. */}
      {canMonitor && isSolo && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="CPU"
            value={metrics ? `${metrics.cpu.usage.toFixed(1)}%` : "—"}
            hint={metrics ? `${metrics.cpu.cores} core` : undefined}
            percent={metrics?.cpu.usage}
            icon="solar:cpu-linear"
            trend={trend?.cpu}
          />
          <StatTile
            label="Memoria"
            value={formatBytes(metrics?.memory.used)}
            hint={metrics ? `di ${formatBytes(metrics.memory.total)}` : undefined}
            percent={memoryPercent}
            icon="solar:server-linear"
            trend={trend?.mem}
            note={memoryPercent !== undefined && memoryPercent >= 75 ? "Quasi piena: in Salute › Monitor vedi chi usa di più" : undefined}
          />
          <StatTile
            label="Disco"
            value={formatBytes(metrics?.disk.used)}
            hint={metrics ? `di ${formatBytes(metrics.disk.total)}` : undefined}
            percent={diskPercent}
            icon="solar:ssd-square-linear"
            trend={trend?.disk}
            note={diskPercent !== undefined && diskPercent >= 75 ? "Poco spazio libero: Spazio disco può liberarne" : undefined}
          />
          <StatTile label="Acceso da" value={formatUptime(metrics?.uptime)} icon="solar:clock-circle-linear" />
        </div>
      )}

      {/* Getting set up and what happened lately, side by side when both apply. */}
      <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))] gap-4 empty:hidden">
        <SetupChecklist />
        <ActivityFeed />
      </div>

      {error && (
        <LoadError
          what={projectsError ? "i progetti" : "i servizi"}
          error={error}
          note="Il pannello riprova da solo."
          onRetry={() => void Promise.all([refreshProjects(), refreshServices()])}
          className="mb-4"
        />
      )}

      {/* Without the folders every card reads as unfiled, which is not what happened. */}
      {foldersError && (
        <LoadError
          what="le cartelle"
          error={foldersError}
          note={folderRows ? "Il pannello riprova da solo." : "Finché non tornano, le schede appaiono fuori dalle cartelle."}
          onRetry={() => void refreshFolders()}
          className="mb-4"
        />
      )}

      <UnreachableServers
        failed={failed}
        what="i progetti e i servizi"
        lastKnown={[...offlineProjects, ...offlineServices].map((row) => row.memberId)}
        className="mb-4"
      />

      {nothingAtAll ? (
        <Panel>
          <EmptyState
            icon="solar:widget-2-linear"
            title="Nessun progetto"
            description="Un progetto contiene un'app e i servizi di cui ha bisogno."
            action={
              canCreate ? (
                <LinkButton href={href("/projects/new")} variant="primary">
                  Crea il primo progetto
                </LinkButton>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <div className="space-y-8">
          {grouped.folders.length > 0 && (
            <div className="space-y-4">
              {grouped.folders.map(({ folder, projects: filedProjects, services: filedServices }) => (
                <Section
                  key={folder.id}
                  title={
                    <span className="flex items-center gap-2">
                      <Icon icon="solar:folder-linear" width={16} className="text-muted shrink-0" aria-hidden />
                      {folder.name}
                    </span>
                  }
                  summary={countLabel(filedProjects.length, filedServices.length, serverParam ? "Niente su questo server" : "Vuota")}
                  defaultExpanded={!collapsed.has(folder.id)}
                  onExpandedChange={(expanded) => rememberExpanded(folder.id, expanded)}
                  actions={
                    rowAllows(folder, { level: "manage" }) && (
                      <Dropdown>
                        <Button
                          variant="ghost"
                          size="sm"
                          isIconOnly
                          aria-label={`Azioni per la cartella ${folder.name}`}
                          className="text-muted hover:text-foreground h-7 w-7 min-w-0"
                        >
                          <Icon icon="solar:menu-dots-bold" width={16} aria-hidden />
                        </Button>
                        <Dropdown.Popover placement="bottom end">
                          <Dropdown.Menu
                            aria-label={`Cartella ${folder.name}`}
                            onAction={(key) => {
                              const f = folders.find((x) => x.id === folder.id);
                              if (f && (key === "rename" || key === "delete")) onFolderAction(key, f);
                            }}
                          >
                            <Dropdown.Item id="rename" textValue="Rinomina">
                              <Icon icon="solar:pen-linear" width={14} aria-hidden />
                              Rinomina
                            </Dropdown.Item>
                            <Dropdown.Item id="delete" textValue="Elimina" className="text-danger">
                              <Icon icon="solar:trash-bin-minimalistic-linear" width={14} aria-hidden />
                              Elimina
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    )
                  }
                >
                  {filedProjects.length === 0 && filedServices.length === 0 ? (
                    <p className="text-muted text-sm">
                      {serverParam
                        ? "Niente di questo server in questa cartella. Usa il menu ⋯ di un progetto o di un servizio per spostarlo qui."
                        : "Cartella vuota. Usa il menu ⋯ di un progetto o di un servizio per spostarlo qui."}
                    </p>
                  ) : (
                    <Cards {...cards} projects={filedProjects} services={filedServices} showServer={showServer} />
                  )}
                </Section>
              ))}
            </div>
          )}

          {sections.map((section) => {
            const server = servers.find((s) => s.id === section.memberId);
            const content = section.empty ? (
              !isSolo && <p className="text-muted px-1 text-sm">Nessun progetto né servizio su questo server.</p>
            ) : (
              <ServerRoot
                {...cards}
                memberId={section.memberId}
                projects={section.projects}
                services={section.services}
                hasFolders={folders.length > 0}
                collapsed={collapsed}
                rememberExpanded={rememberExpanded}
                showServer={false}
              />
            );
            if (isSolo || servers.length === 1) return <div key={section.memberId}>{content}</div>;
            return (
              <section key={section.memberId} aria-label={`Server ${server?.name ?? ""}`}>
                <h2 className="text-foreground mb-3 flex items-center gap-2 px-1 text-sm font-semibold">
                  <Icon icon="solar:server-2-linear" width={16} className="text-muted" aria-hidden />
                  {server?.name}
                  {section.memberId === selfId && <span className="text-muted font-normal">(questo)</span>}
                </h2>
                {content}
              </section>
            );
          })}
        </div>
      )}

      <FormDialog
        isOpen={dialog?.kind === "create" || dialog?.kind === "rename"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={dialog?.kind === "rename" ? "Rinomina cartella" : "Nuova cartella"}
        submitLabel={dialog?.kind === "rename" ? "Rinomina" : "Crea"}
        isSubmitDisabled={!nameValue.trim() || (dialog?.kind === "rename" && nameValue.trim() === dialog.folder.name)}
        onSubmit={submitFolderName}
      >
        <div className="space-y-4">
          <TextField value={nameValue} onChange={setNameValue} autoFocus>
            <Label>Nome</Label>
            <Input placeholder="Es. Clienti" maxLength={60} />
          </TextField>
          {dialog?.kind === "create" && !isSolo && (
            <p className="text-muted text-xs">La cartella vale per tutti i server: può contenere progetti e servizi di qualunque server.</p>
          )}
        </div>
      </FormDialog>

      <ConfirmDialog
        isOpen={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Eliminare la cartella?"
        description={
          dialog?.kind === "delete"
            ? `"${dialog.folder.name}" sparisce dalla Panoramica${isSolo ? "" : " di tutti i server"}. I progetti e i servizi che contiene non vengono toccati: tornano fuori da ogni cartella.`
            : undefined
        }
        confirmLabel="Elimina"
        destructive
        onConfirm={deleteFolder}
      />
    </>
  );
}
