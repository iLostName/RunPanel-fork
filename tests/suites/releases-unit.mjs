import { createReporter } from "../harness.mjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Release folders for native projects, without a filesystem: the rules that
 * decide when a deploy gets a folder of its own (only once the operator opted
 * in, never by default), what in it is data shared
 * with the project folder and what is the version's own, what is handed over
 * when a version stops, which versions stay on disk, and when a failed deploy
 * goes back. Then the wiring, read off the sources, of everything that has to
 * follow the version that runs.
 *
 * Standalone: lib/releases.ts imports nothing but `path`. The same rules run
 * against a real git and real symlinks in releases-fs-unit, on Linux.
 */
export const meta = { name: "releases-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("releases-unit");
  const rel = await import(pathToFileURL(join(repoRoot, "lib", "releases.ts")).href);
  const { relocatedReleaseDir, relocatedArtifactDir } = await import(pathToFileURL(join(repoRoot, "lib", "artifact-dir.ts")).href);
  const source = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");

  // --- when ---------------------------------------------------------------------
  {
    const base = { runtimeType: "node", platform: "linux", sourceType: "github", gitCheckout: true, rollbackEnabled: true, nativeEnabled: true };
    const mode = (patch) => rel.releaseMode({ ...base, ...patch });
    r.check("a node project from git on Linux that opted in gets a folder per version", mode({}).on === true);
    r.check("so do static and custom ones", mode({ runtimeType: "static" }).on && mode({ runtimeType: "custom" }).on);
    r.check("macOS too: nothing in it is Linux-only", mode({ platform: "darwin" }).on === true);
    r.check("Docker and Compose never do", mode({ runtimeType: "docker" }).reason === "runtime" && mode({ runtimeType: "compose" }).reason === "runtime");
    r.check("Windows builds in place", mode({ platform: "win32" }).reason === "platform");
    r.check("an uploaded ZIP builds in place", mode({ sourceType: "upload" }).reason === "source");
    r.check("a project folder that is not a git checkout builds in place", mode({ gitCheckout: false }).reason === "no-git");
    r.check("the automatic return off means in place, as before", mode({ rollbackEnabled: false }).reason === "setting");
    r.check("without the native opt-in, in place too", mode({ nativeEnabled: false }).reason === "setting");
    r.check("the page asks the platform alone", rel.releasesSupported("linux") && !rel.releasesSupported("win32"));
  }

  // --- opt-in --------------------------------------------------------------------------
  {
    const { parseContract, parseContractJson } = await import(pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href);
    const linux = { runtimeType: "node", platform: "linux", sourceType: "github", gitCheckout: true };
    const modeFor = (contract) =>
      rel.releaseMode({ ...linux, rollbackEnabled: contract.rollback.enabled, nativeEnabled: contract.rollback.native });

    const fresh = parseContractJson("{}");
    r.check("a project nobody configured keeps the Docker return on", fresh.rollback.enabled === true);
    r.check("and builds in place: version folders are off until asked for", fresh.rollback.native === false && modeFor(fresh).on === false);
    r.check("an existing project's stored contract builds in place after the update", modeFor(parseContractJson('{"version":1,"commands":{"start":"node server.js"}}')).on === false);
    r.check("Docker's own switch alone does not move a native project", modeFor(parseContract({ rollback: { enabled: true } })).on === false);
    r.check("both switches on: version folders", modeFor(parseContract({ rollback: { enabled: true, native: true } })).on === true);
    r.check("turned off again: in place", modeFor(parseContract({ rollback: { enabled: true, native: false } })).on === false);
    r.check(
      "Docker still goes back without the native flag",
      rel.rollbackPlan({ healthFailed: true, cancelled: false, rollbackEnabled: fresh.rollback.enabled, runtimeType: "docker", usedRelease: false, previous: null }).attempt === true
    );
  }

  // --- what is a version's own ----------------------------------------------------
  {
    const own = ["node_modules", "packages/web/node_modules", ".next", ".next/cache", "dist", "venv", ".venv/lib", "target", "tsconfig.tsbuildinfo", "next-env.d.ts", "public/build/app.js"];
    const shared = ["data", "uploads", "prisma/dev.db", ".env.local", "storage", "db.sqlite3", "public/uploads/a.png", "logs/app.log"];
    r.check("dependencies, build output and caches are the version's", own.every(rel.isVersionedPath), own.filter((p) => !rel.isVersionedPath(p)).join(", "));
    r.check("data, uploads, databases and hand-made config are shared", shared.every((p) => !rel.isVersionedPath(p)), shared.filter(rel.isVersionedPath).join(", "));

    // What a backup of the project folder treats as reproducible is never data here.
    const exporter = source("services", "backup", "project-export.ts");
    const block = exporter.slice(exporter.indexOf("const REPO_EXCLUDES"), exporter.indexOf("]);", exporter.indexOf("const REPO_EXCLUDES")));
    const excludes = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    r.check("the backup's exclusions were found", excludes.length >= 8, String(excludes.length));
    r.check(
      "every name a backup skips is a version's own",
      excludes.every((name) => rel.VERSIONED_NAMES.has(name)),
      excludes.filter((name) => !rel.VERSIONED_NAMES.has(name)).join(", ")
    );
  }

  // --- names from git -----------------------------------------------------------------
  {
    r.check("git's -z output splits without an empty tail", JSON.stringify(rel.splitNul("a\0b/\0")) === '["a","b/"]');
    r.check("a folder loses its trailing slash", rel.normalizeEntry("data/") === "data");
    r.check("a leading ./ goes", rel.normalizeEntry("./data") === "data");
    r.check("backslashes become slashes", rel.normalizeEntry("public\\uploads\\a.png") === "public/uploads/a.png");
    r.check("nothing that climbs out", rel.normalizeEntry("../x") === null && rel.normalizeEntry("a/../../x") === null);
    r.check("nothing absolute", rel.normalizeEntry("/etc/passwd") === null && rel.normalizeEntry("C:/x") === null);
    r.check("nothing in .git", rel.normalizeEntry(".git/config") === null && rel.normalizeEntry(".git") === null);
    r.check("nothing empty", rel.normalizeEntry("") === null && rel.normalizeEntry("a//b") === null);
  }

  // --- the env file -------------------------------------------------------------------
  {
    r.check("off, there is none", rel.envFileEntry({ enabled: false, path: ".env" }) === null);
    r.check("the leading slash means the project's root", rel.envFileEntry({ enabled: true, path: "/app/.env" }) === "app/.env");
    r.check("a path that climbs out is nobody's", rel.envFileEntry({ enabled: true, path: "../x/.env" }) === null);
    r.check("the file and the folders on its way are touched", rel.touchesEnvFile("app", "app/.env") && rel.touchesEnvFile("app/.env", "app/.env"));
    r.check("a sibling is not", !rel.touchesEnvFile("application", "app/.env") && !rel.touchesEnvFile("app/.env.local", "app/.env"));
  }

  // --- what is shared -------------------------------------------------------------------
  {
    const ignored = ["data/", "node_modules/", ".env", ".env.local", "prisma/dev.db", "public/uploads/a.png", ".next/", "../evil", "data/inner/", "dist/"];
    const shared = rel.sharedEntries(ignored, { envFile: ".env" });
    r.check(
      "ignored data is shared; the env file, the version's own and anything odd are not",
      JSON.stringify(shared) === JSON.stringify([".env.local", "data", "prisma/dev.db", "public/uploads/a.png"]),
      JSON.stringify(shared)
    );
  }

  // --- folders an app fills at runtime ----------------------------------------------------
  {
    const tracked = [
      "package.json",
      "src/index.js",
      "public/index.html",
      "public/uploads/.gitkeep",
      "storage/app/.gitignore",
      "storage/app/public/.gitignore",
      "storage/framework/cache/.gitignore",
      "storage/logs/.gitignore",
      "dist/.gitkeep",
      "config/.gitkeep",
      "config/app.json",
      ".gitignore",
    ];
    const folders = rel.placeholderFolders(tracked, { envFile: null });
    r.check(
      "a folder holding only placeholders is shared whole, outermost first",
      JSON.stringify(folders) === JSON.stringify(["public/uploads", "storage"]),
      JSON.stringify(folders)
    );
    r.check("not a folder git tracks a real file in", !folders.includes("config") && !folders.includes("public"));
    r.check("not a build folder, even an empty one", !folders.includes("dist"));
    r.check("not the folder the env file goes in", !rel.placeholderFolders(["app/.gitkeep"], { envFile: "app/.env" }).includes("app"));

    const plan = rel.linkPlan({
      checkoutIgnored: ["public/uploads/a.png", "data/", "storage/logs/x.log"],
      sourceTracked: tracked,
      envFile: null,
      inCheckout: (folder) => folder !== "storage",
    });
    r.check("a placeholder folder missing from the project folder is not linked", !plan.folders.includes("storage"), JSON.stringify(plan));
    r.check(
      "what a linked folder covers is not linked again",
      JSON.stringify(plan.links) === JSON.stringify(["data", "public/uploads", "storage/logs/x.log"]),
      JSON.stringify(plan.links)
    );
    const copy = rel.copyList(["public/uploads/.gitkeep", "src/index.js", "./package.json", "src/index.js"], plan.folders);
    r.check("a linked folder's placeholders are not copied", JSON.stringify(copy) === '["src/index.js","package.json"]', JSON.stringify(copy));
  }

  // --- .git/info/exclude ----------------------------------------------------------------------
  {
    r.check("anchored", rel.excludePattern("data") === "/data");
    r.check("glob characters are literal", rel.excludePattern("a*b?[c]") === "/a\\*b\\?\\[c\\]");
    r.check("a leading ! or # is a name, not syntax", rel.excludePattern("!x") === "/\\!x" && rel.excludePattern("#x") === "/\\#x");
    r.check("trailing spaces are kept", rel.excludePattern("x  ") === "/x\\ \\ ");
  }

  // --- dependencies ---------------------------------------------------------------------------
  {
    const files = { "package.json": "p1", "package-lock.json": "l1" };
    const reuse = (prev, next, workspaces = false) => rel.canReuseDependencies(prev, next, { workspaces });
    r.check("the same lockfile: copy node_modules", reuse(files, files).reuse === true);
    r.check("a changed lockfile: install from scratch", reuse(files, { ...files, "package-lock.json": "l2" }).reuse === false);
    r.check("a changed package.json: from scratch", reuse(files, { ...files, "package.json": "p2" }).reuse === false);
    r.check("a lockfile appearing counts as a change", reuse(files, { ...files, "yarn.lock": "y" }).reuse === false);
    r.check("no lockfile: nothing to be sure of", reuse({ "package.json": "p" }, { "package.json": "p" }).reuse === false);
    r.check("never for a workspace", reuse(files, files, true).reuse === false);
    r.check("not a node project", reuse({}, {}).reuse === false);
  }

  // --- the manifest -----------------------------------------------------------------------------
  {
    const parsed = rel.parseManifest(JSON.stringify({ version: 1, id: "abc", createdAt: 5, startedAt: null, commit: "c", links: ["data", 3], pending: [] }));
    r.check("a manifest reads back", parsed?.id === "abc" && parsed.startedAt === null && JSON.stringify(parsed.links) === '["data"]');
    r.check("garbage is no manifest", rel.parseManifest("{") === null && rel.parseManifest(JSON.stringify({ version: 2, id: "x" })) === null);
  }

  // --- handing data over ---------------------------------------------------------------------------
  {
    const fact = (patch) => ({ path: "x", changedAfterStart: true, inCheckout: false, trackedInCheckout: false, incoming: "absent", ...patch });
    const step = (patch) => rel.planPromotion([fact(patch)])[0];
    r.check("unchanged since the version started: the build made it, it stays", step({ changedAfterStart: false }).action === "skip");
    r.check("written by the app where the project folder has nothing: moved", step({}).action === "move" && step({}).linkIncoming === true);
    r.check(
      "the project folder has a copy: the app was writing here, so that copy is the stale one",
      step({ inCheckout: true }).action === "replace"
    );
    r.check("a path that is source in the new commit stays where it is", step({ inCheckout: true, trackedInCheckout: true }).action === "keep");
    r.check("the incoming version's own build output is left alone", step({ incoming: "real" }).linkIncoming === false);
    r.check("its temporary link into the old version is re-pointed", step({ incoming: "link" }).linkIncoming === true);
    r.check("going back to in place, nobody to link", step({ incoming: "none" }).linkIncoming === false);
  }

  // --- keeping two -----------------------------------------------------------------------------------
  {
    const disk = (...ids) => ids.map((id) => ({ id, startedAt: id.startsWith("never") ? null : 1 }));
    let plan = rel.planPrune({ onDisk: disk("c", "b", "a"), current: "c", good: ["c", "b", "a"] });
    r.check("the current version and the one before stay", JSON.stringify(plan.keep) === '["c","b"]' && plan.remove.map((x) => x.id).join() === "a");
    plan = rel.planPrune({ onDisk: disk("never1", "b", "a"), current: "b", good: ["b", "a"] });
    r.check("a version that never ran goes, flagged as such", plan.remove.some((x) => x.id === "never1" && x.ran === false));
    plan = rel.planPrune({ onDisk: disk("failed", "b", "a"), current: "failed", good: ["b", "a"] });
    r.check("a failed version still up stays, with the last good one", JSON.stringify(plan.keep) === '["failed","b"]');
    plan = rel.planPrune({ onDisk: disk("failed", "b", "a"), current: "b", good: ["b", "a"] });
    r.check("after going back, the failed one goes", plan.remove.map((x) => x.id).join() === "failed" && plan.remove[0].ran === true);
    plan = rel.planPrune({ onDisk: disk("x", "y"), current: null, good: [] });
    r.check("with nothing current and nothing good, nothing is kept", plan.keep.length === 0 && plan.remove.length === 2);
    plan = rel.planPrune({ onDisk: disk("b"), current: "b", good: ["gone", "b"] });
    r.check("a good deployment without a folder keeps nothing", JSON.stringify(plan.keep) === '["b"]');
  }

  // --- going back --------------------------------------------------------------------------------------
  {
    const base = { healthFailed: true, cancelled: false, rollbackEnabled: true, runtimeType: "node", usedRelease: true, previous: { isRelease: true, exists: true } };
    const plan = (patch) => rel.rollbackPlan({ ...base, ...patch });
    r.check("a native version that never answered goes back to the previous folder", plan({}).attempt === true);
    r.check("Docker goes back with or without folders", plan({ runtimeType: "docker", usedRelease: false, previous: null }).attempt === true);
    r.check("not after a build that failed", plan({ healthFailed: false }).reason === "not-health");
    r.check("not after a stop", plan({ cancelled: true }).reason === "not-health");
    r.check("not when switched off", plan({ rollbackEnabled: false }).reason === "off");
    r.check("not for a deploy in place", plan({ usedRelease: false }).reason === "no-release");
    r.check("not to the project folder git has already moved on", plan({ previous: { isRelease: false, exists: true } }).reason === "first");
    r.check("not with no deploy before", plan({ previous: null }).reason === "first");
    r.check("not to a folder that is gone", plan({ previous: { isRelease: true, exists: false } }).reason === "missing");
    r.check("Compose has no way back yet", plan({ runtimeType: "compose", usedRelease: false }).reason === "no-release");
  }

  // --- where ----------------------------------------------------------------------------------------------
  {
    const root = resolve("/data/releases/app");
    r.check("a release folder is found by its id", rel.releaseIdOfPath(join(root, "AbC_123-xyz"), root) === "AbC_123-xyz");
    r.check("also from the static build's dist inside it", rel.releaseIdOfPath(join(root, "AbC_123-xyz", "dist"), root) === "AbC_123-xyz");
    r.check("the project folder is not one", rel.releaseIdOfPath(resolve("/data/repos/app"), root) === null);
    r.check("nor the root itself, nor the pointer", rel.releaseIdOfPath(root, root) === null && rel.releaseIdOfPath(join(root, "current"), root) === null);
    r.check("nor another project's", rel.releaseIdOfPath(resolve("/data/releases/other/x1"), root) === null);
    r.check("an id that starts with a dash is still an id", rel.isReleaseId("-abc") && !rel.isReleaseId(".current-1") && !rel.isReleaseId("current"));

    const moved = relocatedReleaseDir("/old/data/releases/app/AbC123/dist", "app", join("/new", "releases"));
    r.check("a release follows the data directory", moved === join("/new", "releases", "app", "AbC123", "dist"), String(moved));
    r.check("one already there stays", relocatedReleaseDir(join("/new", "releases", "app", "X"), "app", join("/new", "releases")) === null);
    r.check("the checkout rule leaves a release alone", relocatedArtifactDir("/old/data/releases/app/X", "app", "/new/repos") === null);
    r.check("a long list is cut", rel.summarize(["a", "b", "c"], 2) === "a, b (+1)" && rel.summarize(["a"], 2) === "a");
  }

  // --- what follows the version that runs ------------------------------------------------------------------
  {
    const pipeline = source("services", "deploy-pipeline.ts");
    r.check(
      "the pipeline decides on the resolved contract, opt-in included",
      pipeline.includes("rollbackEnabled: contract.rollback.enabled") && pipeline.includes("nativeEnabled: contract.rollback.native")
    );
    r.check(
      "turned off, the next deploy builds in place and hands the last version's data to the project folder",
      /const leaving = !release && IN_PLACE_BUILD_RUNTIMES\.has\(project\.runtime_type\) && currentRelease\(project\.slug\) !== null/.test(pipeline) &&
        pipeline.includes("leftReleases = await leaveReleases(project.slug, contract, appendLog)") &&
        pipeline.includes("pruneReleases(project, contract, appendLog, { keepNone: !release })")
    );
    r.check(
      "and the version folders it leaves are only removed after that deploy worked",
      pipeline.indexOf("{ keepNone: !release }") > pipeline.indexOf("await runPhase(\"post-deploy\"") &&
        pipeline.indexOf("{ keepNone: !release }") < pipeline.indexOf("=== ${label} successful ===")
    );
    const panel = source("app", "(panel)", "projects", "[projectId]", "_components", "settings", "HealthcheckPanel.tsx");
    r.check(
      "the settings switch for a native project writes the opt-in, and is marked new",
      panel.includes("isSelected={contract.rollback.enabled && contract.rollback.native}") && panel.includes("native: true") && panel.includes(">Nuovo<")
    );
    r.check(
      "the version folder is made before the env file and the build",
      pipeline.indexOf("await createRelease(") > 0 &&
        pipeline.indexOf("await createRelease(") < pipeline.indexOf("writeEnvFileInto(deployDir") &&
        pipeline.indexOf("writeEnvFileInto(deployDir") < pipeline.indexOf("buildProject(deployDir")
    );
    r.check("the release command runs in it", /runReleaseCommand\([\s\S]{0,600}projectDir: deployDir/.test(pipeline));
    r.check(
      "data is handed over after the old version stops and before the new one starts",
      pipeline.indexOf('"\\n--- Stopping previous instance ---"', pipeline.indexOf("const leaving")) < pipeline.indexOf("await handOver(") &&
        pipeline.indexOf("await handOver(") < pipeline.indexOf("activateRelease(project.slug, release.id)") &&
        pipeline.indexOf("activateRelease(project.slug, release.id)") < pipeline.indexOf("await processManager.start(")
    );
    r.check("the rollback goes through the plan", pipeline.includes("rollbackPlan({") && !pipeline.includes('project.runtime_type === "docker" && contract.rollback.enabled'));
    r.check("old folders go only after a version proved good, or after the failure is settled", (pipeline.match(/await pruneReleases\(/g) ?? []).length === 2);

    const restart = source("services", "project-restart.ts");
    r.check("a restart starts the version its deploy recorded and makes it current", restart.includes("releaseOfArtifact(") && restart.includes("activateRelease("));
    r.check("…writing the env file there", restart.includes("writeEnvFileInto(release?.dir ?? getRepoPath(project.slug)"));
    r.check("…and following a moved data directory", restart.includes("relocatedReleaseDir("));

    r.check("scheduled tasks run in the version that runs", source("services", "tasks", "target.ts").includes("const cwd = projectWorkDir(project.slug)"));
    for (const route of [["files", "route.ts"], ["files", "content", "route.ts"]]) {
      const text = source("app", "api", "projects", "[projectId]", ...route);
      r.check(`the file manager (${route.join("/")}) opens the version that runs`, text.includes("projectFileRoots(project.slug)") && !text.includes("getRepoPath("));
    }
    r.check("a restore writes where the app reads", source("services", "backup", "restore.ts").includes("projectFileRoots(project.slug)"));
    r.check("a backup carries what only the running version holds", source("services", "backup", "project-export.ts").includes("unknownEntries(current.dir"));
    // The delete lives in services/project-delete.ts, shared by the route and the environments.
    r.check(
      "deleting a project deletes its versions",
      source("services", "project-delete.ts").includes("await removeProjectReleases(slug)") &&
        source("app", "api", "projects", "[projectId]", "route.ts").includes("await deleteProject(project,")
    );
    r.check("so does removing its app", source("app", "api", "projects", "[projectId]", "app", "route.ts").includes("await removeProjectReleases(slug)"));
    r.check("the store keeps the rows a restart needs", /status", "in", \["running", "superseded"\]\)[\s\S]{0,120}\.limit\(2\)/.test(source("services", "docker", "gc.ts")));
  }

  return r.result();
}
