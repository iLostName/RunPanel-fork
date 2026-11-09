import { createReporter } from "../harness.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Two panels edit the same accounts; both must end up with the same answer.
 *
 * The merge decides who may log in where. If it does not converge, one panel
 * lets a user in that another has disabled; if a tombstone loses, a deleted
 * account comes back from a stale copy. Both are silent.
 *
 * Standalone: `lib/cluster-directory.ts` has no imports.
 */
export const meta = { name: "cluster-directory-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("cluster-directory-unit");
  const { exportDirectory, mergeDirectory, canonicalDirectory, bumpedUpdatedAt, isSharedSettingKey, mergeFolders, canonicalFolders } = await import(
    pathToFileURL(join(repoRoot, "lib", "cluster-directory.ts")).href
  );

  const t0 = "2026-10-15T10:00:00.000Z";
  const t1 = "2026-10-15T10:01:00.000Z";
  const t2 = "2026-10-15T10:02:00.000Z";
  const user = (id, patch = {}) => ({
    id,
    email: `${id}@x.y`,
    password_hash: "$2b$12$h",
    is_owner: 0,
    disabled: 0,
    created_by: null,
    created_at: t0,
    updated_at: t0,
    permissions: [],
    grants: [],
    ...patch,
  });
  const member = (id, patch = {}) => ({ id, name: id, url: `http://${id}:3000`, role: "panel", created_at: t0, updated_at: t0, ...patch });
  const snap = (patch = {}) => ({ users: [], members: [], tombstones: [], sharedSettings: [], ...patch });

  // --- newer wins, in both directions -----------------------------------------
  {
    const a = snap({ users: [user("u1", { disabled: 1, updated_at: t1 })] });
    const b = snap({ users: [user("u1", { disabled: 0, updated_at: t0 })] });
    const ab = mergeDirectory(a, b);
    const ba = mergeDirectory(b, a);
    r.check("the newer record wins (a already has it)", ab.users.upsert.length === 0 && ab.result.users[0].disabled === 1);
    r.check("the newer record wins (b must adopt it)", ba.users.upsert.length === 1 && ba.result.users[0].disabled === 1);
    r.check("both sides converge", canonicalDirectory(ab.result) === canonicalDirectory(ba.result));
    r.check("the adopting side reports the user as changed", ba.changedUserIds.join() === "u1" && ab.changedUserIds.length === 0);
  }

  // --- an exact tie is broken the same way from either side -------------------
  {
    const a = snap({ users: [user("u1", { email: "zeta@x.y" })] });
    const b = snap({ users: [user("u1", { email: "alpha@x.y" })] });
    const ab = mergeDirectory(a, b).result;
    const ba = mergeDirectory(b, a).result;
    r.check("a tie converges", canonicalDirectory(ab) === canonicalDirectory(ba), `${ab.users[0].email} vs ${ba.users[0].email}`);
  }

  // --- a winning user record replaces permissions and grants wholesale --------
  {
    const g = (id, scope_id) => ({ id, scope: "project", scope_id, level: "read", terminal: 0, created_at: t0 });
    const a = snap({ users: [user("u1", { permissions: ["backup"], grants: [g("g1", "p1")], updated_at: t0 })] });
    const b = snap({ users: [user("u1", { permissions: ["monitor"], grants: [g("g2", "p2")], updated_at: t1 })] });
    const res = mergeDirectory(a, b).result.users[0];
    r.check("permissions are replaced, not unioned", res.permissions.join() === "monitor", res.permissions.join());
    r.check("grants are replaced, not unioned", res.grants.map((x) => x.id).join() === "g2", JSON.stringify(res.grants));
  }

  // --- tombstones ---------------------------------------------------------------
  {
    const stale = snap({ users: [user("u1", { updated_at: t0 })] });
    const deleted = snap({ tombstones: [{ kind: "user", id: "u1", deleted_at: t1 }] });
    const plan = mergeDirectory(stale, deleted);
    r.check("a tombstone removes the stale copy", plan.users.remove.join() === "u1" && plan.result.users.length === 0);
    r.check("the removed user is reported as changed", plan.changedUserIds.join() === "u1");
    r.check("the tombstone is kept", plan.tombstones.length === 1);
    const reverse = mergeDirectory(deleted, stale);
    r.check("the stale copy cannot resurrect the user", reverse.users.upsert.length === 0 && reverse.result.users.length === 0);

    const edited = snap({ users: [user("u1", { updated_at: t2 })] });
    const later = mergeDirectory(deleted, edited);
    r.check("an edit after the deletion survives it", later.result.users.length === 1);

    const m = snap({ members: [member("n1")] });
    const mDel = snap({ tombstones: [{ kind: "member", id: "n1", deleted_at: t1 }] });
    r.check("member tombstones work the same way", mergeDirectory(m, mDel).members.remove.join() === "n1");
    r.check("a user tombstone does not touch a member with the same id", mergeDirectory(snap({ members: [member("u1")] }), deleted).members.remove.length === 0);
  }

  // --- members and shared settings ----------------------------------------------
  {
    const a = snap({ members: [member("n1", { role: "node", updated_at: t1 })], sharedSettings: [{ key: "github_token", value: "old", updated_at: t0 }] });
    const b = snap({ members: [member("n1", { role: "panel", updated_at: t0 }), member("n2")], sharedSettings: [{ key: "github_token", value: "new", updated_at: t1 }] });
    const plan = mergeDirectory(a, b);
    r.check("a's newer member row wins, b's new member is adopted", plan.members.upsert.map((m) => m.id).join() === "n2" && plan.result.members.find((m) => m.id === "n1").role === "node");
    r.check("the newer shared setting wins", plan.sharedSettings.upsert.length === 1 && plan.sharedSettings.upsert[0].value === "new");
    r.check("an identical snapshot yields an empty plan", (() => {
      const p = mergeDirectory(plan.result, plan.result);
      return p.users.upsert.length === 0 && p.members.upsert.length === 0 && p.sharedSettings.upsert.length === 0 && p.users.remove.length === 0;
    })());
  }

  // --- canonical form -----------------------------------------------------------
  {
    const x = snap({ users: [user("u2"), user("u1", { permissions: ["b", "a", "a"] })], members: [member("n2"), member("n1")] });
    const y = snap({ users: [user("u1", { permissions: ["a", "b"] }), user("u2")], members: [member("n1"), member("n2")] });
    r.check("order and duplicates do not change the canonical form", canonicalDirectory(x) === canonicalDirectory(y));
    r.check("content does", canonicalDirectory(x) !== canonicalDirectory(snap({ users: [user("u1")] })));
  }

  // --- exportDirectory groups flat rows -----------------------------------------
  {
    const out = exportDirectory({
      users: [{ id: "u1", email: null, password_hash: null, is_owner: 1, disabled: 0, created_by: null, created_at: t0, updated_at: null }],
      permissions: [{ user_id: "u1", permission: "backup" }, { user_id: "ghost", permission: "x" }],
      grants: [{ id: "g1", user_id: "u1", scope: "all", scope_id: "", level: "manage", terminal: 1, created_at: t0 }],
      members: [],
      tombstones: [],
      sharedSettings: [],
    });
    r.check("a null updated_at reads as created_at", out.users[0].updated_at === t0);
    r.check("permissions and grants are attached to their user", out.users[0].permissions.join() === "backup" && out.users[0].grants[0].id === "g1");
  }

  // --- bumpedUpdatedAt ----------------------------------------------------------
  {
    r.check("a later clock just uses now", bumpedUpdatedAt(t0, t1) === t1);
    r.check("a clock that is behind still moves forward", bumpedUpdatedAt(t1, t0) > t1, bumpedUpdatedAt(t1, t0));
    r.check("the same instant moves forward too", bumpedUpdatedAt(t1, t1) > t1);
    r.check("no previous value uses now", bumpedUpdatedAt(null, t0) === t0);
  }

  r.check("shared setting keys are the three agreed ones", isSharedSettingKey("github_token") && isSharedSettingKey("telegram_chat_id") && !isSharedSettingKey("panel_public_url"));

  // --- folders ------------------------------------------------------------------
  // A folder's row is the same on every server; what sits in it stays on the
  // server that holds the project. If the merge diverges, a project is filed in
  // a folder another server does not list; if a tombstone loses, a deleted
  // folder comes back.
  {
    const folder = (id, patch = {}) => ({ id, name: id, created_at: t0, updated_at: t0, ...patch });
    const set = (patch = {}) => ({ folders: [], tombstones: [], ...patch });

    const a = set({ folders: [folder("f1"), folder("shared", { name: "Vecchio" })] });
    const b = set({ folders: [folder("f2"), folder("shared", { name: "Nuovo", updated_at: t1 })] });
    const ab = mergeFolders(a, b);
    const ba = mergeFolders(b, a);
    r.check("both servers end up with the same folders", canonicalFolders(ab.result) === canonicalFolders(ba.result), canonicalFolders(ab.result));
    r.check("a folder from another server is taken in", ab.upsert.some((f) => f.id === "f2") && ab.result.folders.length === 3);
    r.check("the newer rename wins, whichever side it is on", ab.result.folders.find((f) => f.id === "shared")?.name === "Nuovo");
    r.check("what is already here and newer is not rewritten", !ba.upsert.some((f) => f.id === "shared"), JSON.stringify(ba.upsert));

    const tomb = { id: "f1", deleted_at: t1 };
    const gone = mergeFolders(set({ folders: [folder("f1")] }), set({ tombstones: [tomb] }));
    r.check("a tombstone removes a folder changed before it", gone.remove.join() === "f1" && gone.result.folders.length === 0, JSON.stringify(gone));
    const stale = mergeFolders(set({ tombstones: [tomb] }), set({ folders: [folder("f1")] }));
    r.check("a stale copy does not bring it back", stale.upsert.length === 0 && stale.remove.length === 0 && stale.result.folders.length === 0, JSON.stringify(stale));
    const later = mergeFolders(set({ tombstones: [tomb] }), set({ folders: [folder("f1", { updated_at: t2 })] }));
    r.check("a folder renamed after the delete does not come back: its content and grants are already gone", later.upsert.length === 0 && later.result.folders.length === 0, JSON.stringify(later));
    const renamedHere = mergeFolders(set({ folders: [folder("f1", { updated_at: t2 })] }), set({ tombstones: [tomb] }));
    r.check("the side holding the later rename gives it up too", renamedHere.remove.join() === "f1" && renamedHere.result.folders.length === 0, JSON.stringify(renamedHere));
    r.check("the delete and the rename settle on the same hash from either side", canonicalFolders(later.result) === canonicalFolders(renamedHere.result), `${canonicalFolders(later.result)} / ${canonicalFolders(renamedHere.result)}`);
    r.check("a tombstone leaves another folder alone", mergeFolders(set({ folders: [folder("f2", { updated_at: t2 })] }), set({ tombstones: [tomb] })).result.folders.length === 1);
    r.check("tombstones are the union of both sides, newest kept", mergeFolders(set({ tombstones: [tomb] }), set({ tombstones: [{ id: "f1", deleted_at: t2 }, { id: "f9", deleted_at: t0 }] })).tombstones.map((t) => `${t.id}@${t.deleted_at}`).join() === `f1@${t2},f9@${t0}`);

    const once = mergeFolders(a, b).result;
    const twice = mergeFolders(once, b);
    r.check("merging again changes nothing", twice.upsert.length === 0 && twice.remove.length === 0);
    r.check("the hash ignores row order", canonicalFolders(set({ folders: [folder("a"), folder("b")] })) === canonicalFolders(set({ folders: [folder("b"), folder("a")] })));

    // The same plan against a real store: what a deleted folder leaves behind.
    const require = createRequire(join(repoRoot, "package.json"));
    const { Kysely, SqliteDialect } = require("kysely");
    const SQLite = require("better-sqlite3");
    const { applyFolderPlan } = await import(pathToFileURL(join(repoRoot, "services", "folders.ts")).href);
    const sqlite = new SQLite(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      create table folders (id text primary key, name text not null, created_at text not null, updated_at text not null);
      create table projects (id text primary key, folder_id text references folders(id) on delete set null, updated_at text);
      create table services (id text primary key, folder_id text references folders(id) on delete set null, updated_at text);
      create table cluster_tombstones (kind text not null, id text not null, deleted_at text not null, primary key (kind, id));
      insert into folders values ('f1', 'Clienti', '${t0}', '${t0}'), ('keep', 'Resta', '${t0}', '${t0}');
      insert into projects values ('p1', 'f1', '${t0}'), ('p2', 'keep', '${t0}');
      insert into services values ('s1', 'f1', '${t0}');
    `);
    const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    try {
      const plan = mergeFolders(
        set({ folders: [folder("f1"), folder("keep")] }),
        set({ folders: [folder("new", { name: "Nuova" }), folder("keep", { name: "Rinominata", updated_at: t1 })], tombstones: [tomb] })
      );
      await applyFolderPlan(db, plan, t2);
      await applyFolderPlan(db, plan, t2);
      const rows = sqlite.prepare("select id, name from folders order by id").all();
      r.check("the store takes the plan: new, renamed and deleted folders, twice over", rows.map((x) => `${x.id}:${x.name}`).join() === "keep:Rinominata,new:Nuova", JSON.stringify(rows));
      r.check("what sat in a deleted folder goes back to the root, not away", sqlite.prepare("select folder_id from projects where id = 'p1'").get()?.folder_id === null && sqlite.prepare("select folder_id from services where id = 's1'").get()?.folder_id === null);
      r.check("what sat in a folder that stayed does not move", sqlite.prepare("select folder_id from projects where id = 'p2'").get()?.folder_id === "keep");
      r.check("the tombstone is stored", sqlite.prepare("select deleted_at from cluster_tombstones where kind = 'folder' and id = 'f1'").get()?.deleted_at === t1);
    } finally {
      await db.destroy();
    }
  }

  return r.result();
}
