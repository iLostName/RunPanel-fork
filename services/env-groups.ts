import { getDb } from "@/lib/db";
import { tryDecrypt } from "@/lib/crypto";
import { parseValue, sharedClosure, type EnvPair } from "@/lib/env-refs";

/**
 * The shared variable groups of this server, read from the store.
 *
 * Groups belong to the server, like its projects and databases: a project on a
 * linked server receives the groups of that server, and a reference is
 * resolved against the server the project runs on. Nothing here is replicated,
 * so there is never a second copy of a secret to fall out of step.
 */

export interface LoadedGroup {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** Decrypted, by name. */
  vars: EnvPair[];
  /**
   * Names whose value cannot be decrypted with this panel's key — a store
   * restored under another secret. They still count as set: delivering a lower
   * layer's value in their place would be the wrong secret, silently.
   */
  unreadable: string[];
}

/** Every group of this server, with its variables decrypted. */
export async function loadGroups(): Promise<LoadedGroup[]> {
  const db = await getDb();
  const [groups, rows] = await Promise.all([
    db.selectFrom("env_groups").selectAll().orderBy("name").execute(),
    db.selectFrom("env_group_vars").select(["group_id", "key", "value"]).orderBy("key").execute(),
  ]);
  const byGroup = new Map<string, LoadedGroup>(
    groups.map((g) => [
      g.id,
      { id: g.id, name: g.name, description: g.description, createdAt: g.created_at, updatedAt: g.updated_at, vars: [], unreadable: [] },
    ])
  );
  for (const row of rows) {
    const group = byGroup.get(row.group_id);
    if (!group) continue;
    const value = tryDecrypt(row.value);
    if (value === null) group.unreadable.push(row.key);
    else group.vars.push({ key: row.key, value });
  }
  return [...byGroup.values()];
}

/** The ids of the groups a project receives, first to last. */
export async function attachedGroupIds(projectId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("project_env_groups")
    .select("group_id")
    .where("project_id", "=", projectId)
    .orderBy("position")
    .execute();
  return rows.map((row) => row.group_id);
}

/** A project's own variables, decrypted; unreadable ones by name. */
export async function loadOwnVars(projectId: string): Promise<{ vars: EnvPair[]; unreadable: string[] }> {
  const db = await getDb();
  const rows = await db.selectFrom("env_vars").select(["key", "value"]).where("project_id", "=", projectId).orderBy("key").execute();
  const vars: EnvPair[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    const value = tryDecrypt(row.value);
    if (value === null) unreadable.push(row.key);
    else vars.push({ key: row.key, value });
  }
  return { vars, unreadable };
}

/** A way to read any shared variable's raw value, for following references. */
export function sharedReader(groups: readonly LoadedGroup[]): (group: string, key: string) => string | null {
  const byName = new Map(groups.map((g) => [g.name, new Map(g.vars.map((v) => [v.key, v.value]))]));
  return (group, key) => byName.get(group)?.get(key) ?? null;
}

export interface ProjectBrief {
  id: string;
  name: string;
  slug: string;
  status: string;
  runtime_type: string;
  builder_config: string;
}

export interface GroupUsage {
  /** Attached to the group itself. */
  attached: { project: ProjectBrief; position: number }[];
  /** Not attached, but reached all the same: their own variables, or a group they have, read the group. */
  referencing: ProjectBrief[];
  /** Other groups whose values read this one, by name. */
  groups: string[];
  /** Variable names of this group that something reads directly, with who. */
  readers: Map<string, Reader[]>;
}

/** Something that reads a group's variable by name: a project's own variable, or another group's. */
export interface Reader {
  kind: "project" | "group";
  id: string;
  name: string;
}

/**
 * Everything a change to a group can reach.
 *
 * A project is affected when it is attached to the group, when one of its own
 * variables reads the group (directly or through another group), or when a
 * group it is attached to reads it. That last one is easy to miss and is what
 * makes this a walk rather than a join: `base` can read `smtp` without anyone
 * attaching `smtp` anywhere, and editing `smtp` then changes every project
 * that has `base`.
 */
export async function groupUsage(group: { id: string; name: string }, groups?: readonly LoadedGroup[]): Promise<GroupUsage> {
  const db = await getDb();
  const all = groups ?? (await loadGroups());
  const read = sharedReader(all);
  const touches = (values: readonly string[]) => [...sharedClosure(values, read)].some((node) => node.startsWith(`${group.name}.`));

  // Groups that read this one, however deep.
  const dependents = new Set<string>([group.id]);
  const dependentNames: string[] = [];
  for (const other of all) {
    if (other.id === group.id) continue;
    if (touches(other.vars.map((v) => v.value))) {
      dependents.add(other.id);
      dependentNames.push(other.name);
    }
  }

  const [projects, links, own] = await Promise.all([
    db.selectFrom("projects").select(["id", "name", "slug", "status", "runtime_type", "builder_config"]).orderBy("name").execute(),
    db.selectFrom("project_env_groups").select(["project_id", "group_id", "position"]).execute(),
    db.selectFrom("env_vars").select(["project_id", "key", "value"]).execute(),
  ]);

  const ownByProject = new Map<string, { key: string; value: string }[]>();
  for (const row of own) {
    const value = tryDecrypt(row.value);
    if (value === null) continue;
    const list = ownByProject.get(row.project_id) ?? [];
    list.push({ key: row.key, value });
    ownByProject.set(row.project_id, list);
  }

  const attached: GroupUsage["attached"] = [];
  const referencing: ProjectBrief[] = [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const link of links) {
    if (link.group_id !== group.id) continue;
    const project = byId.get(link.project_id);
    if (project) {
      attached.push({ project, position: link.position });
      seen.add(project.id);
    }
  }
  for (const project of projects) {
    if (seen.has(project.id)) continue;
    const viaGroup = links.some((l) => l.project_id === project.id && dependents.has(l.group_id));
    const viaOwn = touches((ownByProject.get(project.id) ?? []).map((v) => v.value));
    if (viaGroup || viaOwn) referencing.push(project);
  }

  // Who reads which name directly: removing one of these breaks its reader.
  const readers = new Map<string, Reader[]>();
  const note = (key: string, who: Reader) => {
    const list = readers.get(key) ?? [];
    if (!list.some((r) => r.kind === who.kind && r.id === who.id)) list.push(who);
    readers.set(key, list);
  };
  const scan = (values: readonly string[], who: Reader) => {
    for (const value of values) {
      for (const ref of parseValue(value).refs) {
        if (ref.kind === "shared" && ref.group === group.name) note(ref.key, who);
      }
    }
  };
  for (const other of all) {
    if (other.id !== group.id) scan(other.vars.map((v) => v.value), { kind: "group", id: other.id, name: other.name });
  }
  for (const project of projects) {
    scan((ownByProject.get(project.id) ?? []).map((v) => v.value), { kind: "project", id: project.id, name: project.name });
  }

  return { attached, referencing, groups: dependentNames, readers };
}
