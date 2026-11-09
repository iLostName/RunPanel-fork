/**
 * How the Overview decides what goes where.
 *
 * Pure and dependency-free on purpose: the rules below are the ones a page
 * component gets subtly wrong, and a function with no React in it can be
 * asserted on in milliseconds (`tests/suites/overview-groups-unit.mjs`).
 */

export interface FolderLike {
  id: string;
  name: string;
}

interface Filed {
  folder_id: string | null;
}

interface ServiceLike extends Filed {
  project_id: string | null;
}

export interface FolderGroup<P, S, F extends FolderLike = FolderLike> {
  folder: F;
  projects: P[];
  services: S[];
}

export interface OverviewGroups<P, S, F extends FolderLike = FolderLike> {
  /** One per folder, in the order the folders were given, empty ones included. */
  folders: FolderGroup<P, S, F>[];
  /** Projects filed nowhere — or somewhere that no longer exists. */
  rootProjects: P[];
  /** Services with no project and no folder. */
  looseServices: S[];
}

/**
 * Two rules carry the weight.
 *
 * A service that belongs to a project is never listed on its own, whatever
 * its `folder_id` says: it shows under the project. And a `folder_id` naming
 * a folder the list does not have — one deleted between two polls, since the
 * folders and the rows are fetched separately — reads as the root rather than
 * making the row vanish until the next refresh.
 */
export function groupOverview<P extends Filed, S extends ServiceLike, F extends FolderLike = FolderLike>(
  folders: F[],
  projects: P[],
  services: S[]
): OverviewGroups<P, S, F> {
  const groups = new Map<string, FolderGroup<P, S, F>>();
  for (const folder of folders) groups.set(folder.id, { folder, projects: [], services: [] });

  const rootProjects: P[] = [];
  for (const project of projects) {
    const group = project.folder_id ? groups.get(project.folder_id) : undefined;
    if (group) group.projects.push(project);
    else rootProjects.push(project);
  }

  const looseServices: S[] = [];
  for (const service of services) {
    if (service.project_id) continue;
    const group = service.folder_id ? groups.get(service.folder_id) : undefined;
    if (group) group.services.push(service);
    else looseServices.push(service);
  }

  return { folders: [...groups.values()], rootProjects, looseServices };
}

// --- Folders across servers -------------------------------------------------

interface OnServer {
  memberId: string;
}

/** Two servers can hold rows with the same id: a card, a move and a key always name the server too. */
export function itemKey(memberId: string, id: string): string {
  return `${memberId}:${id}`;
}

/**
 * The folders of the cluster from what each server answered.
 *
 * A folder is replicated, so every server that answers lists the same one; it
 * is the same folder, and it is listed once. While a rename is still on its
 * way the newest copy is the one shown. A server that is down only takes its
 * copy with it, which is why a folder never goes when a server does.
 */
export function uniqueFolders<F extends FolderLike & { updated_at?: string }>(rows: F[]): F[] {
  const byId = new Map<string, F>();
  for (const row of rows) {
    const seen = byId.get(row.id);
    if (!seen || (row.updated_at ?? "") > (seen.updated_at ?? "")) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/**
 * Names that tell folders apart wherever they are listed side by side. Two
 * folders can read the same: the ones from before folders were replicated, and
 * two creates or renames that crossed before either reached the other server.
 * A server's name cannot separate them, since a folder is on every server, so
 * only the duplicates take the start of their id, which never changes.
 */
export function distinctFolderNames<F extends FolderLike>(folders: F[]): F[] {
  const key = (folder: FolderLike) => folder.name.trim().toLowerCase();
  const seen = new Map<string, number>();
  for (const folder of folders) seen.set(key(folder), (seen.get(key(folder)) ?? 0) + 1);
  return folders.map((folder) => ((seen.get(key(folder)) ?? 0) > 1 ? { ...folder, name: `${folder.name} · ${folder.id.slice(0, 4)}` } : folder));
}

/**
 * The folders only a remembered row still holds up. An account with no grant on
 * a folder sees it for what it holds, and each server answers for its own rows:
 * when the one holding them stops answering nobody lists the folder, and its
 * cards would fall out of it. `known` is what this panel stores, so a remembered
 * `folder_id` naming a folder since deleted brings nothing back.
 */
export function rememberedFolders<F extends { id: string }>(known: F[], listed: Array<{ id: string }>, lastSeen: Filed[]): F[] {
  const listedIds = new Set(listed.map((folder) => folder.id));
  const filedIn = new Set(lastSeen.map((row) => row.folder_id));
  return known.filter((folder) => filedIn.has(folder.id) && !listedIds.has(folder.id));
}

/**
 * Why a card did not move. A 404 from the server holding it means one of two
 * things, and only one goes away by itself: the folder has not reached that
 * server yet, which the exchange repairs within a minute (on a server still on
 * an older release, at its next update), or the account has no grant on it and
 * sees it only for what it holds elsewhere, which that server cannot know.
 * Grants are the same everywhere, so a null level here settles it.
 */
export function moveFailureText(
  result: { status: number; error?: string },
  target: { solo: boolean; serverName: string; folder?: FolderLike & { permission?: { level: string | null } } }
): string {
  const { folder, serverName } = target;
  if (result.status !== 404 || target.solo || !folder) return result.error ?? "Spostamento non riuscito";
  if (folder.permission?.level === null) {
    return `Su ${serverName} non hai accesso alla cartella "${folder.name}": la vedi solo per quello che contiene su un altro server. Serve un accesso alla cartella.`;
  }
  return `Cartella non trovata su ${serverName}: se è nuova, riprova tra un minuto.`;
}

export interface ServerSection<P, S> {
  memberId: string;
  projects: P[];
  services: S[];
  /** This server has nothing at all, filed or not. */
  empty: boolean;
}

/**
 * What is in no folder, server by server, in the order given. A server whose
 * every card sits in a folder has nothing to add here and gets no section.
 */
export function serverSections<P extends OnServer, S extends OnServer>(
  memberIds: string[],
  grouped: OverviewGroups<P, S>
): ServerSection<P, S>[] {
  const sections: ServerSection<P, S>[] = [];
  for (const memberId of memberIds) {
    const mine = (row: OnServer) => row.memberId === memberId;
    const projects = grouped.rootProjects.filter(mine);
    const services = grouped.looseServices.filter(mine);
    const filed = grouped.folders.some((g) => g.projects.some(mine) || g.services.some(mine));
    if (projects.length > 0 || services.length > 0 || !filed) {
      sections.push({ memberId, projects, services, empty: projects.length === 0 && services.length === 0 && !filed });
    }
  }
  return sections;
}

// --- A server that stopped answering ----------------------------------------

export type LastSeenKind = "projects" | "services";

const LAST_SEEN_FIELDS: Record<LastSeenKind, readonly string[]> = {
  projects: ["id", "name", "runtime_type", "port", "folder_id"],
  services: ["id", "name", "display_name", "type", "version", "port", "project_id", "folder_id"],
};

/**
 * What a panel remembers of a server's rows, to keep them on the Overview when
 * the server stops answering: only what a card needs to be recognised. Nothing
 * that changes by itself, like a status, so the copy is rewritten when something
 * really moved and not on every poll. A linked service shows as a chip of its
 * project, never as a card, so it is left out.
 */
export function lastSeenRows(kind: LastSeenKind, rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    if (kind === "services" && row.project_id) continue;
    const kept: Record<string, unknown> = {};
    for (const field of LAST_SEEN_FIELDS[kind]) kept[field] = row[field] ?? null;
    out.push(kept);
  }
  return out;
}

/**
 * The live rows, then the last known rows of the servers that did not answer,
 * marked `unreachable`. `fill` supplies what a remembered row does not carry.
 * A row that is live after all is never doubled by its old copy.
 */
export function withLastSeen<T extends OnServer & { id: string }>(
  live: T[],
  lastSeen: T[],
  fill: Partial<T>
): Array<T & { unreachable?: boolean }> {
  const liveKeys = new Set(live.map((row) => itemKey(row.memberId, row.id)));
  const ghosts = lastSeen
    .filter((row) => !liveKeys.has(itemKey(row.memberId, row.id)))
    .map((row) => ({ ...row, ...fill, unreachable: true }));
  return [...live, ...ghosts];
}
