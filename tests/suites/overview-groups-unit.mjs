import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * How the Overview decides what goes where.
 *
 * The page shows a section per folder, then the projects that are in none,
 * then the services that belong to no project and sit in no folder. Two rules
 * carry the weight and both are easy to get subtly wrong in a component: a
 * service with a project is never listed on its own, whatever its `folder_id`
 * says, and a `folder_id` naming a folder the list no longer has — a folder
 * deleted between two polls — reads as the root rather than vanishing.
 */
export const meta = { name: "overview-groups-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("overview-groups-unit");

  const { groupOverview, uniqueFolders, serverSections, itemKey, lastSeenRows, withLastSeen, distinctFolderNames, rememberedFolders, moveFailureText } = await import(
    pathToFileURL(join(repoRoot, "lib", "overview-groups.ts")).href
  );

  const folders = [
    { id: "f1", name: "Clienti" },
    { id: "f2", name: "Interni" },
  ];
  const projects = [
    { id: "p1", folder_id: "f1" },
    { id: "p2", folder_id: null },
    { id: "p3", folder_id: "gone" },
    { id: "p4", folder_id: "f1" },
  ];
  const services = [
    { id: "s1", project_id: "p1", folder_id: null },
    { id: "s2", project_id: null, folder_id: "f2" },
    { id: "s3", project_id: null, folder_id: null },
    { id: "s4", project_id: "p2", folder_id: "f1" },
    { id: "s5", project_id: null, folder_id: "gone" },
  ];

  const grouped = groupOverview(folders, projects, services);

  r.check("one group per folder, in the order the folders came", grouped.folders.map((g) => g.folder.id).join(",") === "f1,f2",
    JSON.stringify(grouped.folders.map((g) => g.folder.id)));
  r.check("a folder lists the projects filed in it, in the order they came",
    grouped.folders[0].projects.map((p) => p.id).join(",") === "p1,p4",
    JSON.stringify(grouped.folders[0].projects.map((p) => p.id)));
  r.check("a folder lists the standalone services filed in it",
    grouped.folders[1].services.map((s) => s.id).join(",") === "s2",
    JSON.stringify(grouped.folders[1].services.map((s) => s.id)));
  r.check("an empty folder is still a group", grouped.folders[1].projects.length === 0);

  r.check("projects in no folder go to the root", grouped.rootProjects.map((p) => p.id).includes("p2"),
    JSON.stringify(grouped.rootProjects.map((p) => p.id)));
  r.check("a project whose folder is gone goes to the root, not nowhere", grouped.rootProjects.map((p) => p.id).includes("p3"),
    JSON.stringify(grouped.rootProjects.map((p) => p.id)));
  r.check("the root keeps the projects' order", grouped.rootProjects.map((p) => p.id).join(",") === "p2,p3");

  r.check("a service with a project is never listed on its own — even with a folder_id",
    ![...grouped.looseServices, ...grouped.folders.flatMap((g) => g.services)].some((s) => s.id === "s1" || s.id === "s4"),
    JSON.stringify(grouped.looseServices.map((s) => s.id)));
  r.check("standalone services in no folder are loose", grouped.looseServices.map((s) => s.id).includes("s3"));
  r.check("a standalone service whose folder is gone is loose", grouped.looseServices.map((s) => s.id).includes("s5"));
  r.check("loose services keep their order", grouped.looseServices.map((s) => s.id).join(",") === "s3,s5",
    JSON.stringify(grouped.looseServices.map((s) => s.id)));

  const empty = groupOverview([], [], []);
  r.check("nothing in, nothing out", empty.folders.length === 0 && empty.rootProjects.length === 0 && empty.looseServices.length === 0);

  // --- folders across servers ------------------------------------------------------
  // A folder is replicated, so every server answers with the same row, and a
  // project of any server files itself in it through its own `folder_id`.
  const t0 = "2026-11-01T10:00:00.000Z";
  const t1 = "2026-11-01T10:01:00.000Z";
  const replicated = uniqueFolders([
    { id: "f2", name: "Interni", updated_at: t0, memberId: "a" },
    { id: "f1", name: "Clienti", updated_at: t0, memberId: "a" },
    { id: "f1", name: "Clienti", updated_at: t0, memberId: "b" },
    { id: "f2", name: "Interni rinominata", updated_at: t1, memberId: "b" },
  ]);
  r.check("a folder every server answers with is one folder", replicated.length === 2, JSON.stringify(replicated));
  r.check("folders come sorted by name, wherever they came from", replicated.map((f) => f.id).join(",") === "f1,f2", JSON.stringify(replicated));
  r.check("the copy edited last wins while a rename is on its way", replicated[1].name === "Interni rinominata" && replicated[1].memberId === "b", JSON.stringify(replicated[1]));
  r.check("on a tie the first server to answer is kept", replicated[0].memberId === "a", JSON.stringify(replicated[0]));

  const crossProjects = [
    { id: "same", folder_id: "f1", memberId: "a" },
    { id: "same", folder_id: "f2", memberId: "b" },
    { id: "other", folder_id: "f1", memberId: "b" },
    { id: "alone", folder_id: null, memberId: "b" },
  ];
  const crossServices = [
    { id: "s9", project_id: null, folder_id: "f1", memberId: "b" },
    { id: "s9", project_id: null, folder_id: null, memberId: "a" },
  ];
  const cross = groupOverview(replicated, crossProjects, crossServices);
  const inFolder = (i) => cross.folders[i].projects.map((p) => itemKey(p.memberId, p.id)).join(",");
  r.check("projects of different servers share a folder", inFolder(0) === "a:same,b:other", inFolder(0));
  r.check("two projects with one id on two servers each keep their own folder", inFolder(1) === "b:same", inFolder(1));
  r.check("a service of another server shares the folder too", cross.folders[0].services.map((s) => itemKey(s.memberId, s.id)).join(",") === "b:s9");
  r.check("the card key tells two servers apart", itemKey("a", "x") !== itemKey("b", "x"));

  const sections = serverSections(["a", "b", "c"], cross);
  r.check("what is in no folder is listed under its server", sections.map((s) => s.memberId).join(",") === "a,b,c", JSON.stringify(sections.map((s) => s.memberId)));
  r.check("a server keeps its own unfiled rows", sections[1].projects.map((p) => p.id).join(",") === "alone" && sections[0].services.map((s) => s.id).join(",") === "s9");
  r.check("a server with nothing at all says so", sections[2].empty === true && sections[0].empty === false);
  const allFiled = serverSections(["a"], groupOverview(replicated, [{ id: "p", folder_id: "f1", memberId: "a" }], []));
  r.check("a server with everything filed needs no section of its own", allFiled.length === 0, JSON.stringify(allFiled));

  // --- two folders with one name ---------------------------------------------------
  const twins = distinctFolderNames([
    { id: "abcd1234", name: "Clienti" },
    { id: "wxyz9876", name: "clienti " },
    { id: "ffff0000", name: "Interni" },
  ]);
  r.check("duplicates take the start of their id", twins[0].name === "Clienti · abcd" && twins[1].name === "clienti  · wxyz", JSON.stringify(twins));
  r.check("a name nobody shares stays as it is", twins[2].name === "Interni", JSON.stringify(twins[2]));
  const flipped = distinctFolderNames([{ id: "wxyz9876", name: "Clienti" }, { id: "abcd1234", name: "Clienti" }]);
  r.check("the suffix does not depend on the order", flipped[1].name === "Clienti · abcd", JSON.stringify(flipped));
  const source = [{ id: "abcd1234", name: "Clienti", permission: { level: "manage" } }, { id: "wxyz9876", name: "Clienti" }];
  const named = distinctFolderNames(source);
  r.check("the real names stay in the rows given", source[0].name === "Clienti" && named[0].permission.level === "manage", JSON.stringify(named[0]));

  // --- a folder held up by a server that is down ------------------------------------
  const known = [{ id: "f1", name: "Clienti" }, { id: "f2", name: "Interni" }, { id: "f3", name: "Vuota" }];
  const held = rememberedFolders(known, [{ id: "f2" }], [{ folder_id: "f1" }, { folder_id: "f2" }, { folder_id: "gone" }, { folder_id: null }]);
  r.check("a remembered row keeps its folder listed", held.map((f) => f.id).join() === "f1", JSON.stringify(held));
  r.check("nothing remembered, nothing added", rememberedFolders(known, [], []).length === 0);

  // --- why a card did not move ------------------------------------------------------
  const notFound = { status: 404, error: "Cartella non trovata" };
  const failure = (folder, result = notFound, solo = false) => moveFailureText(result, { solo, serverName: "nodo", folder });
  const granted = failure({ id: "f", name: "Clienti", permission: { level: "read" } });
  r.check("a folder with a grant may just be on its way: retrying is worth it", granted.includes("riprova"), granted);
  r.check("so may one from a server that does not say", failure({ id: "f", name: "Clienti" }).includes("riprova"));
  const hidden = failure({ id: "f", name: "Clienti", permission: { level: null } });
  r.check("a folder seen only for its content never promises a retry", !hidden.includes("riprova") && hidden.includes("nodo") && hidden.includes("Clienti"), hidden);
  r.check("a move to the root that fails says what the server said", failure(undefined, { status: 404, error: "Progetto non trovato" }) === "Progetto non trovato");
  r.check("any other failure says what the server said", failure({ id: "f", name: "Clienti" }, { status: 403, error: "No" }) === "No");
  r.check("with one server there is nothing to wait for", failure({ id: "f", name: "Clienti" }, notFound, true) === "Cartella non trovata");
  r.check("an empty answer still reads as a sentence", failure(undefined, { status: 500 }) === "Spostamento non riuscito");

  // --- a server that stopped answering ---------------------------------------------
  const seenProjects = lastSeenRows("projects", [
    { id: "p1", name: "Sito", slug: "sito", runtime_type: "node", port: 3000, folder_id: "f1", status: "running", deploy_count: 4, env: "x", services: [{ id: "s" }] },
  ]);
  r.check("only what the card needs is kept of a project", JSON.stringify(seenProjects) === JSON.stringify([{ id: "p1", name: "Sito", runtime_type: "node", port: 3000, folder_id: "f1" }]), JSON.stringify(seenProjects));
  const seenServices = lastSeenRows("services", [
    { id: "s1", name: "db", display_name: "Database", type: "redis", version: "7", port: 6379, project_id: null, folder_id: "f1", status: "running" },
    { id: "s2", name: "linked", display_name: null, type: "redis", version: "7", port: 6380, project_id: "p1", folder_id: null, status: "running" },
  ]);
  r.check("a linked service is not kept: it never has a card of its own", seenServices.map((s) => s.id).join(",") === "s1", JSON.stringify(seenServices));

  const live = [{ id: "p1", folder_id: "f1", memberId: "a" }];
  const ghosts = [
    { id: "p1", folder_id: "f2", memberId: "b", name: "Sito" },
    { id: "p1", folder_id: "f1", memberId: "a", name: "Doppione" },
  ];
  const merged = withLastSeen(live, ghosts, { status: "stopped", services: [] });
  r.check("a server's last known rows join the live ones, marked unreachable", merged.length === 2 && merged[1].unreachable === true && merged[1].status === "stopped" && merged[1].services.length === 0, JSON.stringify(merged));
  r.check("a live row is never doubled by its old copy", merged.filter((p) => p.memberId === "a").length === 1 && !merged[0].unreachable);
  const offlineView = groupOverview(replicated, merged, []);
  r.check("an unreachable project stays in its folder", offlineView.folders[1].projects.some((p) => p.unreachable && p.memberId === "b"), JSON.stringify(offlineView.folders[1].projects));

  return r.result();
}
