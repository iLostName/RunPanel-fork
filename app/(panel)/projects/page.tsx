"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Button, Input } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { LinkButton } from "@/components/ui/LinkButton";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSkeleton } from "@/components/ui/Skeletons";
import { StatusBadge } from "@/components/StatusBadge";
import { FolderDialogs, type FolderDialogRequest } from "@/components/folders/FolderDialogs";
import { FolderChip, FolderHeading } from "@/components/folders/FolderLook";
import { FolderTiles, type FolderTile } from "@/components/folders/FolderTiles";
import { MoveMenu } from "@/components/folders/MoveMenu";
import { useFolderMove } from "@/components/folders/useFolderMove";
import { useNode, useServerHref } from "@/lib/hooks/useNode";
import { useCan, useMe } from "@/lib/hooks/useMe";
import { formatWhen } from "@/lib/format";
import { useClusterList } from "@/lib/hooks/useClusterList";
import type { Located } from "@/lib/cluster-merge";
import { PROJECT_ACTIONS, rowAllows, type Access } from "@/lib/authz";
import { distinctFolderNames, groupOverview, itemKey, uniqueFolders, withLastSeen, type FolderLike } from "@/lib/overview-groups";
import {
  encodeProjectDrag,
  FOLDER_PARAM,
  folderHue,
  folderSelectionHref,
  inSelection,
  parseFolderParam,
  PROJECT_DRAG_TYPE,
  selectionKey,
  statusBreakdown,
  type FolderSelection,
  type ProjectDrag,
} from "@/lib/project-folders";
import { ServerBadge, ServerFilter, UnreachableServers } from "@/components/cluster/ServerBits";
import { cn } from "@/lib/utils";

interface Project {
  id: string;
  name: string;
  slug: string;
  runtime_type: string;
  status: string;
  port: number | null;
  /** Absent from the last known copy of a server that stopped answering. */
  source_branch?: string;
  deploy_count: number;
  last_deploy_at: string | null;
  access_mode: string | null;
  folder_id: string | null;
  permission?: Access;
  /** A last known copy: the server holding it did not answer. */
  unreachable?: boolean;
}

interface Folder extends FolderLike {
  updated_at: string;
  permission?: Access;
}

/** What a move needs to know about the project, and to say about it. */
type Movable = Pick<Located<Project>, "memberId" | "id" | "name" | "folder_id">;

/**
 * A dense list, as opposed to the Overview's cards.
 *
 * This route used to be a bare `redirect("/home")`, which meant the sidebar
 * could not offer "Projects" as a destination at all.
 *
 * A row the account may edit can be dragged onto a folder; its "⋯" does the
 * same from a keyboard or a phone. The menu sits beside the link, never inside
 * it, so pressing it does not open the project.
 */
const ProjectRow = memo(function ProjectRow({
  project,
  href,
  folderName,
  hue,
  folders,
  canMove,
  dragged,
  onMove,
  onDrag,
}: {
  project: Located<Project>;
  href: string;
  /** The folder it is in, on the list that shows every folder at once. */
  folderName?: string;
  hue?: number;
  folders: FolderLike[];
  canMove: boolean;
  dragged: boolean;
  onMove: (project: Movable, folderId: string | null) => void;
  onDrag: (drag: ProjectDrag | null) => void;
}) {
  const content = (
    <>
      <div className="min-w-0 flex-1">
        {/* Wraps instead of squeezing: the name must not be what gives way to the chips. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground max-w-full truncate text-sm font-medium">{project.name}</span>
          <StatusBadge status={project.status} />
          {folderName !== undefined && <FolderChip name={folderName} hue={hue} />}
          <ServerBadge memberId={project.memberId} />
        </div>
        <p className="text-muted mt-0.5 flex items-center gap-x-2 truncate font-mono text-xs">
          <span className="truncate">
            {project.runtime_type}
            {project.port ? ` · :${project.port}` : ""}
            {project.source_branch ? ` · ${project.source_branch}` : ""}
          </span>
          {project.access_mode === "restricted" && (
            <span className="inline-flex shrink-0 items-center gap-1" title="Accesso limitato a reti specifiche">
              <Icon icon="solar:lock-keyhole-minimalistic-linear" width={13} aria-hidden />
              limitato
            </span>
          )}
        </p>
      </div>

      {/* A server that does not answer has no deploy history to tell. */}
      {!project.unreachable && (
        <div className="text-muted hidden shrink-0 text-right text-xs sm:block">
          <p className="tabular-nums">{project.deploy_count} deploy</p>
          {project.last_deploy_at && <p className="mt-0.5">{formatWhen(project.last_deploy_at)}</p>}
        </div>
      )}
    </>
  );

  return (
    <Panel
      interactive={!project.unreachable}
      padding="flush"
      data-project-row=""
      className={cn("flex items-center", dragged && "opacity-50")}
    >
      {project.unreachable ? (
        <div className="flex min-w-0 flex-1 items-center gap-3 p-3">{content}</div>
      ) : (
        <Link
          href={href}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--radius)] p-3"
          onDragStart={
            canMove
              ? (event) => {
                  const drag = { memberId: project.memberId, id: project.id, folderId: project.folder_id };
                  event.dataTransfer.setData(PROJECT_DRAG_TYPE, encodeProjectDrag(drag));
                  // Said outright rather than left to each browser's default
                  // for a link, which a folder's "move" must be part of; copy
                  // and link stay, so the row still drops into a new tab.
                  event.dataTransfer.effectAllowed = "all";
                  // The whole row follows the pointer, from where it was picked
                  // up, rather than the link's text alone.
                  const row = event.currentTarget.closest<HTMLElement>("[data-project-row]");
                  if (row) {
                    const box = row.getBoundingClientRect();
                    event.dataTransfer.setDragImage(row, event.clientX - box.left, event.clientY - box.top);
                  }
                  onDrag(drag);
                }
              : undefined
          }
          onDragEnd={canMove ? () => onDrag(null) : undefined}
        >
          {content}
          <Icon icon="solar:alt-arrow-right-linear" width={16} className="text-muted shrink-0" aria-hidden />
        </Link>
      )}
      {canMove && (
        <MoveMenu
          label={project.name}
          folderId={project.folder_id}
          folders={folders}
          onMove={(folderId) => onMove(project, folderId)}
          className="mr-2"
        />
      )}
    </Panel>
  );
});

export default function ProjectsPage() {
  const href = useServerHref();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isSolo } = useNode();
  const canCreate = useCan("projects.create");
  // Folders are the whole panel's: see the folders route.
  const me = useMe();
  const canCreateFolder = canCreate && me.seesEverything;
  const poll5000 = usePollInterval(5000);
  const [search, setSearch] = useState("");

  const {
    items: data,
    offline,
    failed,
    loading,
    error: loadError,
    refresh,
  } = useClusterList<Project>("/api/cluster/projects", "/api/projects", { intervalMs: poll5000 });
  // A folder is the same on every server, so the filter by server does not
  // narrow this list: a server that is down still has its folders to sit in.
  const {
    items: folderRows,
    loading: foldersLoading,
    error: foldersError,
    refresh: refreshFolders,
  } = useClusterList<Folder>("/api/cluster/folders", "/api/folders", { intervalMs: poll5000, everyServer: true });

  const folders = useMemo(() => uniqueFolders(folderRows ?? []), [folderRows]);
  // What the page shows; `folders` keeps the real names for the dialogs and the colours.
  const namedFolders = useMemo(() => distinctFolderNames(folders), [folders]);
  const namedById = useMemo(() => new Map(namedFolders.map((folder) => [folder.id, folder])), [namedFolders]);
  const hues = useMemo(() => new Map(folders.map((folder) => [folder.id, folderHue(folder.name)])), [folders]);
  const knownFolders = useMemo(() => (folderRows ? new Set(folders.map((folder) => folder.id)) : null), [folderRows, folders]);

  // Moves sent but not yet seen in a refresh: a dropped row lands at once
  // rather than a poll later, and goes back by itself if the move is refused.
  const [pendingMoves, setPendingMoves] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const projects = useMemo(() => {
    const rows = withLastSeen(data ?? [], offline, { status: "unreachable", slug: "", deploy_count: 0, last_deploy_at: null, access_mode: null });
    if (pendingMoves.size === 0) return rows;
    return rows.map((project) => {
      const key = itemKey(project.memberId, project.id);
      return pendingMoves.has(key) ? { ...project, folder_id: pendingMoves.get(key) ?? null } : project;
    });
  }, [data, offline, pendingMoves]);

  const folderParam = searchParams.get(FOLDER_PARAM);
  const selection = useMemo(() => parseFolderParam(folderParam), [folderParam]);
  const query = searchParams.toString();
  const selectionHref = useCallback((target: FolderSelection) => folderSelectionHref(pathname, query, target), [pathname, query]);
  // `history.pushState`, which Next keeps `useSearchParams` in step with: no
  // request and no jump to the top, and Back still walks through the folders.
  const select = useCallback((target: string) => {
    // The tile already open: a second entry would only make Back do nothing once.
    if (`${window.location.pathname}${window.location.search}` === target) return;
    window.history.pushState(null, "", target);
  }, []);

  // --- moving ---------------------------------------------------------------
  const move = useFolderMove(namedFolders);
  const folderName = useCallback((id: string | null) => (id ? namedById.get(id)?.name : undefined), [namedById]);

  const file = useCallback(
    async (project: Movable, folderId: string | null): Promise<boolean> => {
      const key = itemKey(project.memberId, project.id);
      setPendingMoves((moves) => new Map(moves).set(key, folderId));
      const moved = await move("projects", project.memberId, project.id, folderId);
      // Dropped only once the list carries the move itself, so the row does not
      // blink back to its old folder in between.
      if (moved) await refresh();
      setPendingMoves((moves) => {
        const next = new Map(moves);
        next.delete(key);
        return next;
      });
      return moved;
    },
    [move, refresh]
  );

  // Moving is reversible, so it asks nothing and offers to undo instead.
  const moveProject = useCallback(
    async (project: Movable, folderId: string | null) => {
      const from = project.folder_id;
      if (from === folderId || !(await file(project, folderId))) return;
      const subject = project.name ? `«${project.name}»` : "Il progetto";
      const where = folderName(folderId);
      toast.success(where ? `${subject} spostato in «${where}»` : `${subject} ora è senza cartella`, {
        // Long enough to reach "Annulla" after reading it; sonner's 4s was not.
        duration: 8000,
        action: { label: "Annulla", onClick: () => void file({ ...project, folder_id: folderId }, from) },
      });
    },
    [file, folderName]
  );

  // --- dragging ---------------------------------------------------------------
  const [drag, setDrag] = useState<ProjectDrag | null>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onDrag = useCallback((next: ProjectDrag | null) => {
    clearTimeout(dragTimer.current);
    // Not in the dragstart itself: the browser takes its picture of the row
    // after that handler, and a row already dimmed would be pictured dimmed.
    if (next) dragTimer.current = setTimeout(() => setDrag(next), 0);
    else setDrag(null);
  }, []);
  useEffect(() => {
    if (!drag) return;
    // A row that leaves the page mid-drag takes its dragend with it. No pointer
    // event fires during a drag, so the first one after it says it is over.
    const end = () => setDrag(null);
    window.addEventListener("pointermove", end, { once: true });
    return () => window.removeEventListener("pointermove", end);
  }, [drag]);

  const dropOnFolder = useCallback(
    (dropped: ProjectDrag, folderId: string | null) => {
      onDrag(null);
      if (dropped.folderId === folderId) return;
      const project = projects.find((p) => p.memberId === dropped.memberId && p.id === dropped.id);
      void moveProject(project ?? { memberId: dropped.memberId, id: dropped.id, name: "", folder_id: dropped.folderId }, folderId);
    },
    [onDrag, projects, moveProject]
  );

  // --- folders ------------------------------------------------------------------
  const [folderDialog, setFolderDialog] = useState<FolderDialogRequest<Folder> | null>(null);
  const grouped = useMemo(() => groupOverview(namedFolders, projects, []), [namedFolders, projects]);
  const movable = useCallback((project: Located<Project>) => !project.unreachable && rowAllows(project, PROJECT_ACTIONS.settings), []);
  const anyMovable = useMemo(() => namedFolders.length > 0 && projects.some(movable), [namedFolders, projects, movable]);

  const savedFolder = useCallback(
    async (folder: FolderLike, created: boolean) => {
      await refreshFolders();
      if (created && folder.name) {
        toast.success(`Cartella «${folder.name}» creata`, {
          description: projects.some(movable) ? "Trascinaci un progetto, oppure usa «Sposta in…» dal suo menu ⋯." : undefined,
        });
      }
    },
    [refreshFolders, projects, movable]
  );

  const deletedFolder = useCallback(
    async (folder: Located<Folder>) => {
      // An open folder that no longer exists gives way to every project, in
      // place, so Back does not return to it.
      if (selection.kind === "folder" && selection.id === folder.id) {
        window.history.replaceState(null, "", selectionHref({ kind: "all" }));
      }
      // Its projects are in no folder now, so the list is stale as well.
      await Promise.all([refreshFolders(), refresh()]);
    },
    [selection, selectionHref, refreshFolders, refresh]
  );

  const tiles = useMemo(() => {
    const unfiled = grouped.rootProjects.length;
    const list: FolderTile[] = [
      {
        key: "all",
        href: selectionHref({ kind: "all" }),
        label: "Tutti",
        kind: "all",
        count: projects.length,
        slices: statusBreakdown(projects),
      },
    ];
    for (const group of grouped.folders) {
      list.push({
        key: selectionKey({ kind: "folder", id: group.folder.id }),
        href: selectionHref({ kind: "folder", id: group.folder.id }),
        label: group.folder.name,
        kind: "folder",
        hue: hues.get(group.folder.id),
        count: group.projects.length,
        slices: statusBreakdown(group.projects),
        dropTo: { folderId: group.folder.id },
      });
    }
    // Only when something is filed nowhere — or a filed project is on its way
    // out, which needs somewhere to be dropped.
    if ((folders.length > 0 && unfiled > 0) || selection.kind === "none" || drag?.folderId) {
      list.push({
        key: "none",
        href: selectionHref({ kind: "none" }),
        label: "Senza cartella",
        kind: "none",
        count: unfiled,
        slices: statusBreakdown(grouped.rootProjects),
        dropTo: { folderId: null },
      });
    }
    return list;
  }, [grouped, projects, folders.length, hues, selection.kind, selectionHref, drag?.folderId]);

  // "Senza cartella" that appears only for a drag takes the place of "Nuova
  // cartella", which no project can be dropped on, so nothing below moves.
  const noneOnlyForDrag = Boolean(drag?.folderId) && grouped.rootProjects.length === 0 && selection.kind !== "none";
  const showCreate = canCreateFolder && !noneOnlyForDrag;
  const showTiles = folders.length > 0 || canCreateFolder || selection.kind !== "all";

  const inView = useMemo(() => projects.filter((p) => inSelection(p.folder_id, selection, knownFolders)), [projects, selection, knownFolders]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? inView.filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q)) : inView;
  }, [inView, search]);

  if ((loading && !data) || (foldersLoading && !folderRows && !foldersError)) return <PageSkeleton />;

  const openFolder = selection.kind === "folder" ? (namedById.get(selection.id) ?? null) : null;
  const openGroup = openFolder ? grouped.folders.find((g) => g.folder.id === openFolder.id) : undefined;
  // Only once the folders are in: before that every id is unknown.
  const folderGone = selection.kind === "folder" && folderRows !== null && !openFolder;
  const showAll = (
    <Button variant="secondary" onPress={() => select(selectionHref({ kind: "all" }))}>
      Mostra tutti i progetti
    </Button>
  );

  function emptyState() {
    if (folderGone) {
      return (
        <EmptyState
          icon="solar:folder-linear"
          title="Questa cartella non esiste più"
          description="È stata eliminata, oppure il link è sbagliato."
          action={showAll}
        />
      );
    }
    if (projects.length === 0 && selection.kind === "all") {
      return (
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
      );
    }
    if (search.trim()) {
      return (
        <EmptyState
          icon="solar:widget-2-linear"
          title="Nessun risultato"
          description={openFolder ? `Nessun progetto di «${openFolder.name}» corrisponde alla ricerca.` : "Nessun progetto corrisponde alla ricerca."}
        />
      );
    }
    if (openFolder) {
      return (
        <EmptyState
          icon="solar:folder-open-linear"
          title="Cartella vuota"
          description={
            anyMovable
              ? `Trascina un progetto sulla scheda «${openFolder.name}» qui sopra, oppure scegli «Sposta in…» dal menu ⋯ del progetto.`
              : "Non c'è ancora nessun progetto in questa cartella."
          }
          action={showAll}
        />
      );
    }
    return (
      <EmptyState
        icon="solar:inbox-linear"
        title="Ogni progetto è in una cartella"
        description="Non c'è nessun progetto senza cartella."
        action={showAll}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Progetti"
        description={isSolo ? "Tutti i progetti gestiti da questo pannello" : "I progetti di ogni server"}
        actions={
          <>
            <ServerFilter />
            {canCreate && (
              <LinkButton href={href("/projects/new")} variant="secondary">
                <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                Nuovo progetto
              </LinkButton>
            )}
          </>
        }
      />

      {showTiles && (
        <FolderTiles
          tiles={tiles}
          selectedKey={selectionKey(selection)}
          drag={drag}
          onSelect={select}
          onDrop={dropOnFolder}
          onCreate={showCreate ? () => setFolderDialog({ kind: "create" }) : undefined}
        />
      )}

      {/* Without the folders every row reads as unfiled, which is not what happened. */}
      {foldersError && (
        <LoadError
          what="le cartelle"
          error={foldersError}
          note={folderRows ? "Il pannello riprova da solo." : "Finché non tornano, i progetti appaiono senza cartella."}
          onRetry={() => void refreshFolders()}
          className="mb-4"
        />
      )}

      {openFolder && (
        <FolderHeading
          name={openFolder.name}
          hue={hues.get(openFolder.id)}
          count={openGroup?.projects.length ?? 0}
          slices={statusBreakdown(openGroup?.projects ?? [])}
          actions={
            rowAllows(openFolder, { level: "manage" }) && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    const real = folders.find((f) => f.id === openFolder.id);
                    if (real) setFolderDialog({ kind: "rename", folder: real });
                  }}
                >
                  <Icon icon="solar:pen-linear" width={15} aria-hidden />
                  Rinomina
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    const real = folders.find((f) => f.id === openFolder.id);
                    if (real) setFolderDialog({ kind: "delete", folder: real });
                  }}
                >
                  <Icon icon="solar:trash-bin-minimalistic-linear" width={15} aria-hidden />
                  Elimina
                </Button>
              </>
            )
          }
        />
      )}

      {/* Nothing to search in an empty folder; still there while a search is typed, so it can be cleared. */}
      {((projects.length > 5 && inView.length > 0) || search.trim() !== "") && !folderGone && (
        <div className="mb-4 max-w-sm">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={openFolder ? `Cerca in ${openFolder.name}…` : "Cerca per nome…"}
            aria-label="Cerca progetti"
          />
        </div>
      )}

      <UnreachableServers failed={failed} what="i progetti" lastKnown={offline.map((row) => row.memberId)} className="mb-4" />

      {!data && loadError ? (
        <LoadError what="i progetti" error={loadError} onRetry={() => void refresh()} />
      ) : shown.length === 0 || folderGone ? (
        <Panel>{emptyState()}</Panel>
      ) : (
        <div className="space-y-2">
          {shown.map((project) => {
            // The chip only where folders are mixed: inside one it would repeat the heading.
            const filedIn = selection.kind === "all" && project.folder_id ? namedById.get(project.folder_id) : undefined;
            const key = itemKey(project.memberId, project.id);
            return (
              <ProjectRow
                key={key}
                project={project}
                href={href(`/projects/${project.id}`, project.memberId)}
                folderName={filedIn?.name}
                hue={filedIn ? hues.get(filedIn.id) : undefined}
                folders={namedFolders}
                canMove={namedFolders.length > 0 && movable(project)}
                dragged={drag !== null && itemKey(drag.memberId, drag.id) === key}
                onMove={moveProject}
                onDrag={onDrag}
              />
            );
          })}
        </div>
      )}

      <FolderDialogs request={folderDialog} onClose={() => setFolderDialog(null)} onSaved={savedFolder} onDeleted={deletedFolder} />
    </>
  );
}
