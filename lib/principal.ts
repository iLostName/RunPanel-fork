import { getDb } from "./db";
import { getUserAccess } from "./users";
import {
  folderAccess,
  projectAccess,
  serviceAccess,
  type Principal,
  type ProjectRef,
  type ServiceRef,
} from "./authz";
import type { SessionUser } from "./auth";

/**
 * The data side of `lib/authz.ts`: load who is asking, and what a project or
 * service sits under, so the pure functions can decide.
 */

export async function loadPrincipal(user: SessionUser): Promise<Principal> {
  if (user.isOwner) return { userId: user.id, isOwner: true, permissions: new Set(), grants: [] };
  const access = await getUserAccess(user.id);
  return { userId: user.id, isOwner: false, permissions: new Set(access.permissions), grants: access.grants };
}

/**
 * What decides access to one project: its folder, or for an environment its
 * production's id and folder (see `ProjectRef.parentId`). An environment whose
 * production is gone answers for itself, like the ordinary project it now is.
 */
function refOf(
  row: { id: string; folder_id: string | null; environment_of: string | null },
  parent: { id: string; folder_id: string | null } | null | undefined
): ProjectRef {
  return row.environment_of && parent
    ? { id: row.id, folderId: parent.folder_id, parentId: parent.id }
    : { id: row.id, folderId: row.folder_id };
}

/** Only what decides access — the folder a project is filed in, or its production's. */
export async function projectRefs(): Promise<Map<string, ProjectRef>> {
  const db = await getDb();
  const rows = await db.selectFrom("projects").select(["id", "folder_id", "environment_of"]).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map(rows.map((r) => [r.id, refOf(r, r.environment_of ? byId.get(r.environment_of) : null)]));
}

export async function serviceRefs(projects?: Map<string, ProjectRef>): Promise<Map<string, ServiceRef>> {
  const db = await getDb();
  const byProject = projects ?? (await projectRefs());
  const rows = await db.selectFrom("services").select(["id", "folder_id", "project_id"]).execute();
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, folderId: r.folder_id, project: r.project_id ? byProject.get(r.project_id) ?? null : null },
    ])
  );
}

export async function projectRef(projectId: string): Promise<ProjectRef | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("projects")
    .leftJoin("projects as parent", "parent.id", "projects.environment_of")
    .select(["projects.id", "projects.folder_id", "projects.environment_of", "parent.id as parent_id", "parent.folder_id as parent_folder_id"])
    .where("projects.id", "=", projectId)
    .executeTakeFirst();
  if (!row) return null;
  return refOf(row, row.parent_id ? { id: row.parent_id, folder_id: row.parent_folder_id ?? null } : null);
}

export async function serviceRef(serviceId: string): Promise<ServiceRef | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("services")
    .leftJoin("projects", "projects.id", "services.project_id")
    // A database linked to an environment follows production's grants too.
    .leftJoin("projects as parent", "parent.id", "projects.environment_of")
    .select([
      "services.id",
      "services.folder_id",
      "services.project_id",
      "projects.folder_id as project_folder_id",
      "projects.environment_of as project_environment_of",
      "parent.id as parent_id",
      "parent.folder_id as parent_folder_id",
    ])
    .where("services.id", "=", serviceId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    folderId: row.folder_id,
    project: row.project_id
      ? refOf(
          { id: row.project_id, folder_id: row.project_folder_id ?? null, environment_of: row.project_environment_of ?? null },
          row.parent_id ? { id: row.parent_id, folder_id: row.parent_folder_id ?? null } : null
        )
      : null,
  };
}

/** Projects this principal can at least read. `"all"` for the owner. */
export async function visibleProjectIds(principal: Principal): Promise<Set<string> | "all"> {
  if (principal.isOwner) return "all";
  const refs = await projectRefs();
  return new Set([...refs.values()].filter((ref) => projectAccess(principal, ref).level !== null).map((ref) => ref.id));
}

export async function visibleServiceIds(principal: Principal): Promise<Set<string> | "all"> {
  if (principal.isOwner) return "all";
  const refs = await serviceRefs();
  return new Set([...refs.values()].filter((ref) => serviceAccess(principal, ref).level !== null).map((ref) => ref.id));
}

/**
 * Folders worth showing: one granted directly (or through `all`), or one that
 * holds something visible. An empty folder nobody granted stays hidden — its
 * name alone can say more than the operator meant to share.
 */
export async function visibleFolderIds(principal: Principal): Promise<Set<string> | "all"> {
  if (principal.isOwner) return "all";
  const db = await getDb();
  const folders = await db.selectFrom("folders").select("id").execute();
  const projects = await projectRefs();
  const services = await serviceRefs(projects);
  const visible = new Set<string>();
  for (const f of folders) if (folderAccess(principal, f.id).level !== null) visible.add(f.id);
  for (const ref of projects.values()) {
    if (ref.folderId && projectAccess(principal, ref).level !== null) visible.add(ref.folderId);
  }
  for (const ref of services.values()) {
    if (!ref.project && ref.folderId && serviceAccess(principal, ref).level !== null) visible.add(ref.folderId);
  }
  return visible;
}

export function isVisible(set: Set<string> | "all", id: string): boolean {
  return set === "all" || set.has(id);
}
