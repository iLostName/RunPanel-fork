import { createReporter } from "../harness.mjs";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Release folders against a real git and a real filesystem.
 *
 * Two halves. The first needs nothing special and runs everywhere, Windows
 * included: making a version folder from a checkout (its own git, the tracked
 * files copied, the manifest), reusing node_modules, telling what the app
 * wrote from what the build left, removing a version and refusing to remove
 * the wrong thing. The second needs symlinks â€” Linux, where the feature runs,
 * and the CI â€” and covers what matters most: data linked into the project
 * folder, handed over when a version stops, surviving the removal of every
 * version that linked to it.
 *
 * The module is loaded through a resolve hook for its one extensionless
 * import; it imports nothing of the panel's config or store by design.
 */
export const meta = { name: "releases-fs-unit", needsDocker: false, drivers: [], standalone: true };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canSymlink(dir) {
  try {
    writeFileSync(join(dir, "probe-target"), "x");
    symlinkSync("probe-target", join(dir, "probe-link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(join(dir, "probe-link"), { force: true });
    rmSync(join(dir, "probe-target"), { force: true });
  }
}

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=suite@runpanel.test", "-c", "user.name=suite", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function write(base, relative, content = "") {
  const target = join(base, ...relative.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

const isLink = (target) => {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

async function loadModule(repoRoot) {
  const fileUrl = (...parts) => pathToFileURL(join(...parts)).href;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      return nextResolve(extensionless && context.parentURL?.endsWith(".ts") ? `${specifier}.ts` : specifier, context);
    },
  });
  try {
    return await import(fileUrl(repoRoot, "services", "releases-fs.ts"));
  } finally {
    hook.deregister();
  }
}

/** A checkout with an origin, the way `gitClone` leaves one. */
function makeCheckout(dir, files, gitignore) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(files)) write(dir, name, content);
  write(dir, ".gitignore", gitignore);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "remote", "add", "origin", "https://example.test/acme/app.git");
  return git(dir, "rev-parse", "HEAD");
}

export async function run({ repoRoot }) {
  const r = createReporter("releases-fs-unit");
  const fsx = await loadModule(repoRoot);
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "rp-releases-")));
  const logs = [];
  const log = (line) => logs.push(line);

  try {
    await portable(r, fsx, join(tmp, "portable"), log, logs);
    if (canSymlink(tmp)) {
      await linked(r, fsx, join(tmp, "linked"), log);
    } else {
      r.note("symlinks not available here (Windows without the privilege): the linked half runs on Linux and in CI");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return r.result();
}

async function portable(r, fsx, base, log, logs) {
  const checkout = join(base, "repos", "app");
  const root = join(base, "releases", "app");
  const head = makeCheckout(
    checkout,
    {
      "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
      "package-lock.json": '{"lockfileVersion":3}',
      "src/index.js": "console.log('v1')\n",
      "start.sh": "#!/bin/sh\nexec node src/index.js\n",
      "venv/keep.txt": "committed on purpose\n",
    },
    "node_modules/\nsessions/\n"
  );
  if (process.platform !== "win32") {
    chmodSync(join(checkout, "start.sh"), 0o755);
    git(checkout, "update-index", "--chmod=+x", "start.sh");
  }

  // A left-over in-place build, as an existing project has before its first version.
  write(checkout, "node_modules/left/index.js", "old");

  const first = await fsx.createRelease({ id: "Rel_one-1", root, checkout, source: checkout, previous: null, seed: false, envFile: null, log });
  const dir1 = first.dir;
  r.check("a version folder is made beside the others", dir1 === join(root, "Rel_one-1") && existsSync(join(dir1, "src", "index.js")));
  r.check("with the tracked files as they are", readFileSync(join(dir1, "src", "index.js"), "utf8") === "console.log('v1')\n");
  r.check("and not the project folder's own build output", !existsSync(join(dir1, "node_modules")));
  if (process.platform !== "win32") {
    r.check("an executable stays executable", (statSync(join(dir1, "start.sh")).mode & 0o111) !== 0);
  }
  r.check("its own git, on the same commit", git(dir1, "rev-parse", "HEAD") === head);
  r.check("with a clean status", git(dir1, "status", "--porcelain") === "", git(dir1, "status", "--porcelain"));
  r.check("and the project's origin, not a path on this disk", git(dir1, "remote", "get-url", "origin") === "https://example.test/acme/app.git");
  r.check("its manifest says what it is and that it never ran", first.manifest.commit === head && first.manifest.startedAt === null);
  r.check("the manifest is on disk beside the folder", fsx.readManifest(root, "Rel_one-1")?.id === "Rel_one-1");

  // Dependencies from the version before, when the lockfile is the same.
  write(dir1, "node_modules/dep/index.js", "dep");
  const second = await fsx.createRelease({
    id: "Rel_two-2",
    root,
    checkout,
    source: checkout,
    previous: { id: first.id, dir: dir1, manifest: first.manifest },
    seed: true,
    envFile: null,
    log,
  });
  r.check("node_modules is reused when the lockfile is the same", second.seeded.includes("node_modules") && existsSync(join(second.dir, "node_modules", "dep", "index.js")));
  if (process.platform !== "win32") {
    r.check(
      "as a copy, never a hard link the previous version would share",
      statSync(join(second.dir, "node_modules", "dep", "index.js")).ino !== statSync(join(dir1, "node_modules", "dep", "index.js")).ino
    );
  }

  write(checkout, "package-lock.json", '{"lockfileVersion":3,"changed":true}');
  git(checkout, "commit", "-q", "-am", "lockfile");
  write(second.dir, "node_modules/dep/index.js", "dep");
  const third = await fsx.createRelease({
    id: "Rel_three",
    root,
    checkout,
    source: checkout,
    previous: { id: second.id, dir: second.dir, manifest: second.manifest },
    seed: true,
    envFile: null,
    log,
  });
  r.check("but not once the lockfile changed", !third.seeded.includes("node_modules") && !existsSync(join(third.dir, "node_modules")));
  r.check("and the log says why", logs.some((line) => line.includes("package-lock.json changed")));

  // What the app writes, told from what the build left.
  write(dir1, "sessions/early", "before start");
  await sleep(60);
  const startedAt = Date.now();
  await sleep(60);
  r.check("an untouched folder has not changed since", !fsx.changedSince(join(dir1, "sessions"), startedAt));
  write(dir1, "sessions/late", "after start");
  r.check("a file added afterwards is a change", fsx.changedSince(join(dir1, "sessions"), startedAt));
  r.check("an ignored folder the version holds is an unknown entry", JSON.stringify(await fsx.unknownEntries(dir1, null)) === '["sessions"]');
  r.check(
    "and live once the app wrote into it after starting",
    JSON.stringify(await fsx.liveEntries(dir1, { ...first.manifest, startedAt }, null)) === '["sessions"]'
  );
  r.check("but not from a version that started after it was last written", (await fsx.liveEntries(dir1, { ...first.manifest, startedAt: Date.now() + 60_000 }, null)).length === 0);

  // Removing, and refusing to.
  let refused = false;
  try {
    await fsx.removeRelease(root, "../repos");
  } catch {
    refused = true;
  }
  r.check("a name that is not a version's is refused", refused && existsSync(checkout));
  await fsx.removeRelease(root, "Rel_one-1");
  r.check("a version goes with its manifest", !existsSync(dir1) && fsx.readManifest(root, "Rel_one-1") === null);
  r.check("and the others stay", JSON.stringify(fsx.listReleases(root).map((x) => x.id).sort()) === '["Rel_three","Rel_two-2"]');

  let stale = false;
  mkdirSync(join(root, "Rel_four"));
  write(root, "Rel_four/junk", "x");
  const fourth = await fsx.createRelease({ id: "Rel_four", root, checkout, source: checkout, previous: null, seed: false, envFile: null, log });
  stale = !existsSync(join(fourth.dir, "junk"));
  r.check("a half-made folder with the same id is made again", stale);

  let badId = false;
  try {
    await fsx.createRelease({ id: "../x", root, checkout, source: checkout, previous: null, seed: false, envFile: null, log });
  } catch {
    badId = true;
  }
  r.check("an id that is not one is refused before anything is written", badId && !existsSync(join(base, "releases", "x")));

  // The project folder's own build output, once nothing runs from it.
  const freed = await fsx.freeCheckoutBuildDirs(checkout, log);
  r.check("the project folder's node_modules goes", freed.includes("node_modules") && !existsSync(join(checkout, "node_modules")));
  r.check("a folder git tracks stays", existsSync(join(checkout, "venv", "keep.txt")) && !freed.includes("venv"));
}

async function linked(r, fsx, base, log) {
  const checkout = join(base, "repos", "app");
  const root = join(base, "releases", "app");
  makeCheckout(
    checkout,
    {
      "package.json": JSON.stringify({ name: "app" }),
      "server.js": "// v1\n",
      "public/index.html": "<h1>v1</h1>\n",
      "public/uploads/.gitkeep": "",
      "prisma/schema.prisma": "// schema\n",
    },
    ["node_modules/", "data/", "*.db", "public/uploads/*", "!public/uploads/.gitkeep", ".env", ".env.local", "sessions/", "public/bundle.js", "db.json"].join("\n") + "\n"
  );

  // What an existing native project keeps in its folder.
  write(checkout, "data/app.sqlite", "rows");
  write(checkout, "prisma/dev.db", "prisma rows");
  write(checkout, "public/uploads/old.png", "png");
  write(checkout, ".env.local", "HANDMADE=1\n");
  write(checkout, ".env", "# Written by RunPanel\nSECRET=1\n");
  write(checkout, "db.json", '{"v":"stale"}');
  write(checkout, "node_modules/x/index.js", "x");

  const one = await fsx.createRelease({ id: "one", root, checkout, source: checkout, previous: null, seed: false, envFile: ".env", log });
  const at = (dir, p) => join(dir, ...p.split("/"));
  const pointsInto = (link, target) => isLink(link) && realpathSync(link) === realpathSync(target);

  r.check("a data folder is linked into the project folder", pointsInto(at(one.dir, "data"), at(checkout, "data")));
  r.check("so is a database file inside a tracked folder", pointsInto(at(one.dir, "prisma/dev.db"), at(checkout, "prisma/dev.db")));
  r.check("an uploads folder holding only a placeholder is linked whole", pointsInto(at(one.dir, "public/uploads"), at(checkout, "public/uploads")));
  r.check("so is a hand-made .env.local", pointsInto(at(one.dir, ".env.local"), at(checkout, ".env.local")));
  r.check("the panel's env file is not: each version writes its own", !existsSync(at(one.dir, ".env")));
  r.check("node_modules is not: each version installs its own", !existsSync(at(one.dir, "node_modules")));
  r.check("the links are relative, so a moved data directory keeps them", !readlinkSync(at(one.dir, "data")).startsWith("/"));
  r.check("git in the version sees a clean tree", git(one.dir, "status", "--porcelain") === "", git(one.dir, "status", "--porcelain"));
  writeFileSync(at(one.dir, "data/app.sqlite"), "rows+1");
  r.check("a write through the version lands in the project folder", readFileSync(at(checkout, "data/app.sqlite"), "utf8") === "rows+1");

  // The pointer.
  fsx.setCurrent(root, "one");
  r.check("current points at the version", fsx.readCurrent(root) === "one" && isLink(join(root, "current")));

  // The build leaves a file where git ignores it; then the app starts and writes.
  write(one.dir, "public/bundle.js", "built");
  await sleep(60);
  fsx.markStarted(root, "one");
  const started = fsx.readManifest(root, "one");
  r.check("the first start is dated", typeof started?.startedAt === "number");
  await sleep(60);
  write(one.dir, "sessions/s1", "session");
  // An atomic save replaces the linked file with a real one.
  writeFileSync(at(one.dir, "db.json.tmp"), '{"v":"live"}');
  renameSync(at(one.dir, "db.json.tmp"), at(one.dir, "db.json"));
  r.check("an atomic save turned the link into a file", !isLink(at(one.dir, "db.json")));

  const live = await fsx.liveEntries(one.dir, fsx.readManifest(root, "one"), ".env");
  r.check("what the app wrote is live, what the build left is not", JSON.stringify(live.sort()) === '["db.json","sessions"]', JSON.stringify(live));

  // The next version, made while the first one still runs.
  const two = await fsx.createRelease({
    id: "two",
    root,
    checkout,
    source: checkout,
    previous: { id: "one", dir: one.dir, manifest: fsx.readManifest(root, "one") },
    seed: false,
    envFile: ".env",
    log,
  });
  r.check("it reaches the running version's new data until the switch", pointsInto(at(two.dir, "sessions"), at(one.dir, "sessions")));
  r.check("and the live copy of a saved file, not the project folder's stale one", pointsInto(at(two.dir, "db.json"), at(one.dir, "db.json")));
  r.check("but not the running version's build output", !existsSync(at(two.dir, "public/bundle.js")));

  // The first version stops: the hand-over.
  const result = await fsx.promote({
    root,
    checkout,
    from: { id: "one", dir: one.dir, manifest: fsx.readManifest(root, "one") },
    to: { id: "two", dir: two.dir },
    envFile: ".env",
    log,
  });
  r.check("new data moves to the project folder", result.moved.includes("sessions") && readFileSync(at(checkout, "sessions/s1"), "utf8") === "session");
  r.check("the old version keeps seeing it, for a rollback", pointsInto(at(one.dir, "sessions"), at(checkout, "sessions")));
  r.check("the new version's link now goes to the project folder", pointsInto(at(two.dir, "sessions"), at(checkout, "sessions")));
  const replaced = result.replaced.find((entry) => entry.path === "db.json");
  r.check("the live copy of a saved file replaces the stale one", readFileSync(at(checkout, "db.json"), "utf8") === '{"v":"live"}');
  r.check("and the stale one is moved aside, not deleted", Boolean(replaced) && readFileSync(replaced.aside, "utf8") === '{"v":"stale"}');
  r.check("both versions link to the live copy", pointsInto(at(one.dir, "db.json"), at(checkout, "db.json")) && pointsInto(at(two.dir, "db.json"), at(checkout, "db.json")));
  r.check("the build output stays with its version", !isLink(at(one.dir, "public/bundle.js")) && !existsSync(at(checkout, "public/bundle.js")));
  r.check("nothing live is left in the old version", (await fsx.liveEntries(one.dir, fsx.readManifest(root, "one"), ".env")).length === 0);

  // Switching and removing.
  fsx.setCurrent(root, "two");
  r.check("the switch is one rename: current now names the new version", fsx.readCurrent(root) === "two");
  let refused = false;
  try {
    await fsx.removeRelease(root, "two");
  } catch {
    refused = true;
  }
  r.check("the current version cannot be removed", refused && existsSync(two.dir));
  await fsx.removeRelease(root, "one");
  r.check("removing a version leaves the data it linked to", !existsSync(one.dir) &&
    readFileSync(at(checkout, "data/app.sqlite"), "utf8") === "rows+1" &&
    readFileSync(at(checkout, "sessions/s1"), "utf8") === "session" &&
    readFileSync(at(checkout, "db.json"), "utf8") === '{"v":"live"}' &&
    existsSync(at(checkout, "public/uploads/old.png")));

  // Links the version lacks are added before a start.
  rmSync(at(two.dir, "data"));
  write(checkout, "added.db", "new");
  const made = await fsx.repairLinks({ dir: two.dir, checkout, envFile: ".env" });
  r.check("a missing link comes back, a new data file gets one", made.includes("data") && made.includes("added.db") && pointsInto(at(two.dir, "added.db"), at(checkout, "added.db")));

  // A path that is source in the project folder is never overwritten.
  write(checkout, "tracked.db", "in git");
  git(checkout, "add", "-f", "tracked.db");
  git(checkout, "commit", "-q", "-m", "track it");
  write(two.dir, "tracked.db", "written by the app");
  write(two.dir, "fresh.db", "new rows");
  const leaving = await fsx.promote({ root, checkout, from: { id: "two", dir: two.dir, manifest: null }, to: null, envFile: ".env", log });
  r.check("going back to in place hands the data over", leaving.moved.includes("fresh.db") && readFileSync(at(checkout, "fresh.db"), "utf8") === "new rows");
  r.check("but not over a file git tracks there", leaving.kept.includes("tracked.db") && readFileSync(at(checkout, "tracked.db"), "utf8") === "in git");
  fsx.clearCurrent(root);
  r.check("and nothing is current any more", fsx.readCurrent(root) === null && !existsSync(join(root, "current")));

  // Turned off: nothing to move back. Everything a version used is a real file
  // in the project folder, which is still the clean checkout an in-place deploy
  // pulls into.
  const kept = ["server.js", "package.json", "data/app.sqlite", "prisma/dev.db", "public/uploads/old.png", ".env.local", "sessions/s1", "db.json", "fresh.db", "added.db"];
  const missing = kept.filter((p) => !existsSync(at(checkout, p)) || isLink(at(checkout, p)));
  r.check("turned off, the project folder alone holds the code and every file the versions kept", missing.length === 0, missing.join(", "));
  r.check("and is still a clean checkout", git(checkout, "status", "--porcelain") === "", git(checkout, "status", "--porcelain"));
  r.check("the displaced copies are kept under the releases folder", readdirSync(join(root, ".displaced")).length === 1);
}
