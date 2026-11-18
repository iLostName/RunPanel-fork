import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  CURRENT_LINK,
  DEPENDENCY_FILES,
  canReuseDependencies,
  copyList,
  excludePattern,
  isReleaseId,
  linkPlan,
  parseManifest,
  planPromotion,
  sharedEntries,
  splitNul,
  summarize,
  type EntryFacts,
  type ReleaseManifest,
} from "../lib/releases";

/**
 * Release folders on disk: creating one, handing data over to it, switching to
 * it, removing old ones. The rules live in `lib/releases.ts`; this file only
 * does what they decide.
 *
 * Every path arrives from the caller, and nothing here imports the panel's
 * config or store, so the Linux CI can load it as it is and run it against a
 * real git and real symlinks (tests/suites/releases-fs-unit.mjs). Windows never
 * gets here: `releaseMode` keeps it in place there.
 *
 * Three invariants, because the folders around these calls hold people's data:
 *
 *  - nothing in the project folder is deleted. Data is moved into it, and a
 *    stale copy it already had is moved aside, never removed;
 *  - removing a version removes its folder and nothing it links to: `fs.rm`
 *    unlinks a symlink, it does not follow it;
 *  - a name from git is used only after `normalizeEntry`, and every folder on
 *    the way to it is checked to be a real folder, so a link committed to the
 *    repository cannot turn a write here into a write somewhere else.
 */

const exec = promisify(execFile);

/** `ls-files` over a large tree, or a monorepo, easily passes the 1 MB default. */
const GIT_BUFFER = 256 * 1024 * 1024;

async function git(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout, maxBuffer: GIT_BUFFER, encoding: "utf8" });
  return stdout;
}

/** What git ignores in a folder, the outermost ignored folder standing for its contents. */
export async function listIgnored(dir: string): Promise<string[]> {
  return splitNul(await git(dir, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]));
}

/** What a version is made of: tracked files, plus untracked ones git does not ignore. */
async function listSourceFiles(dir: string): Promise<string[]> {
  return splitNul(await git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
}

async function listTracked(dir: string): Promise<string[]> {
  return splitNul(await git(dir, ["ls-files", "-z"]));
}

const segmentsOf = (entry: string) => entry.split("/");
const at = (base: string, entry: string) => path.join(base, ...segmentsOf(entry));

export function lexists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealDir(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The project folder as a link should name it: the real path of `repos/`, then
 * the project's own name.
 *
 * Not `realpath` of the whole thing. A project whose checkout was moved to
 * another disk (services/project-repo.ts) is a symlink at `repos/<slug>`, and a
 * link going through that name follows the checkout wherever it is moved next.
 */
function checkoutAnchor(checkout: string): string {
  return path.join(fs.realpathSync(path.dirname(checkout)), path.basename(checkout));
}

/** A relative symlink at `link` to `target`, so a data directory moved as a whole keeps working. */
function makeLink(link: string, target: string): void {
  const from = fs.realpathSync(path.dirname(link));
  fs.symlinkSync(path.relative(from, target), link);
}

/** The same, replacing a link already there in one rename: whoever reads the path sees one or the other. */
function pointLink(link: string, target: string): void {
  const temporary = `${link}.runpanel-${crypto.randomBytes(4).toString("hex")}`;
  makeLink(temporary, target);
  try {
    fs.renameSync(temporary, link);
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

/**
 * Create the folders on the way to `base/entry`, refusing any that already
 * exists as something other than a real folder. Returns false on a refusal.
 */
function ensureParent(base: string, entry: string): boolean {
  let current = base;
  for (const segment of segmentsOf(entry).slice(0, -1)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      fs.mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * Whether anything at or under `target` changed after `since`.
 *
 * ctime as well as mtime: a file renamed into place — the atomic save — keeps
 * the mtime of the moment it was written but gets a new ctime, and a folder's
 * ctime moves when something is added to it. Links are not followed. A folder
 * too large to walk, or one that cannot be read, counts as changed: the answer
 * decides whether a file may be left behind, and "keep it" is the safe one.
 */
export function changedSince(target: string, since: number): boolean {
  const stack = [target];
  let budget = 200_000;
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.ctimeMs > since || stat.mtimeMs > since) return true;
    if (!stat.isDirectory()) continue;
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      return true;
    }
    budget -= names.length;
    if (budget < 0) return true;
    for (const name of names) stack.push(path.join(current, name));
  }
  return false;
}

// --- the manifest and the pointer -------------------------------------------------

const manifestPath = (root: string, id: string) => path.join(root, `${id}.json`);

export function readManifest(root: string, id: string): ReleaseManifest | null {
  try {
    return parseManifest(fs.readFileSync(manifestPath(root, id), "utf8"));
  } catch {
    return null;
  }
}

/** Written whole and renamed into place: a crash leaves the old file or the new one. */
export function writeManifest(root: string, manifest: ReleaseManifest): void {
  const target = manifestPath(root, manifest.id);
  const temporary = `${target}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

/** The version `current` points at, when it is there. */
export function readCurrent(root: string): string | null {
  try {
    const id = path.basename(fs.readlinkSync(path.join(root, CURRENT_LINK)));
    return isReleaseId(id) && isRealDir(path.join(root, id)) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Point `current` at a version: a new link renamed over the old one, which
 * POSIX makes atomic. A reader never finds the pointer missing.
 */
export function setCurrent(root: string, id: string): void {
  if (!isReleaseId(id) || !isRealDir(path.join(root, id))) throw new Error(`Versione inesistente: ${id}`);
  const temporary = path.join(root, `.${CURRENT_LINK}-${crypto.randomBytes(4).toString("hex")}`);
  fs.symlinkSync(id, temporary);
  try {
    fs.renameSync(temporary, path.join(root, CURRENT_LINK));
  } catch (err) {
    fs.rmSync(temporary, { force: true });
    throw err;
  }
}

/** Back to the project folder: nothing is current. Only ever a link, so never recursive. */
export function clearCurrent(root: string): void {
  const link = path.join(root, CURRENT_LINK);
  if (isSymlink(link)) fs.rmSync(link, { force: true });
}

/** When a version first ran. Kept from the first time: see `planPromotion`. */
export function markStarted(root: string, id: string, at = Date.now()): void {
  const manifest = readManifest(root, id);
  if (!manifest || manifest.startedAt !== null) return;
  writeManifest(root, { ...manifest, startedAt: at });
}

/** Every version on disk, with when it first ran. */
export function listReleases(root: string): { id: string; startedAt: number | null }[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => isReleaseId(name) && isRealDir(path.join(root, name)))
    .map((id) => ({ id, startedAt: readManifest(root, id)?.startedAt ?? null }));
}

function appendExclude(dir: string, entries: string[]): void {
  if (entries.length === 0) return;
  const info = path.join(dir, ".git", "info");
  if (!isRealDir(path.join(dir, ".git"))) return;
  fs.mkdirSync(info, { recursive: true });
  fs.appendFileSync(path.join(info, "exclude"), `${entries.map(excludePattern).join("\n")}\n`);
}

// --- what a version holds -------------------------------------------------------------

/**
 * Files and folders git ignores in a version that are really there — not a link
 * of ours, not a version's own output. What `planPromotion` looks at.
 */
export async function unknownEntries(dir: string, envFile: string | null): Promise<string[]> {
  return sharedEntries(await listIgnored(dir), { envFile }).filter((entry) => {
    const target = at(dir, entry);
    return lexists(target) && !isSymlink(target);
  });
}

/** The unknown entries the app wrote after the version started: its data. */
export async function liveEntries(dir: string, manifest: ReleaseManifest | null, envFile: string | null): Promise<string[]> {
  const since = manifest?.startedAt ?? null;
  return (await unknownEntries(dir, envFile)).filter((entry) => since === null || changedSince(at(dir, entry), since));
}

/** Which of `entries` are, or contain, files git tracks in `dir`. */
async function trackedAmong(dir: string, entries: string[]): Promise<Set<string>> {
  const tracked = new Set<string>();
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    // Literal: a file named `:(glob)*` is a file, not pathspec magic.
    const files = splitNul(await git(dir, ["--literal-pathspecs", "ls-files", "-z", "--", ...chunk]));
    for (const entry of chunk) {
      if (files.some((file) => file === entry || file.startsWith(`${entry}/`))) tracked.add(entry);
    }
  }
  return tracked;
}

// --- copying -------------------------------------------------------------------------

/**
 * Copy a version's files one by one, sixteen at a time.
 *
 * `COPYFILE_FICLONE` makes each copy a reflink where the filesystem has them
 * (btrfs, XFS) and a plain copy elsewhere; libuv carries the mode over, so a
 * `start.sh` stays executable. A link committed to the repository is copied as
 * the same link. A name the source no longer has — a tracked file deleted from
 * the working tree — is skipped, as a build there would not have seen it either.
 */
async function copyFiles(from: string, to: string, files: string[], signal?: AbortSignal): Promise<number> {
  const queue = [...files];
  const made = new Set<string>([to]);
  const ensureDir = (dir: string) => {
    if (made.has(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    made.add(dir);
  };
  let copied = 0;

  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      if (signal?.aborted) throw new Error("Copia interrotta");
      const source = at(from, file);
      const destination = at(to, file);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(source);
      } catch {
        continue;
      }
      ensureDir(path.dirname(destination));
      if (stat.isSymbolicLink()) {
        await fs.promises.symlink(await fs.promises.readlink(source), destination);
      } else if (stat.isDirectory()) {
        // A submodule git left empty, exactly as the project folder has it.
        ensureDir(destination);
      } else if (stat.isFile()) {
        await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_FICLONE);
      } else {
        continue;
      }
      copied++;
    }
  };

  await Promise.all(Array.from({ length: 16 }, worker));
  return copied;
}

/**
 * Copy a whole tree that does not exist yet at `to`. GNU `cp` first: native,
 * off the event loop, and `--reflink=auto` makes it nearly free on a filesystem
 * that can share blocks. `fs.cp` where that `cp` is missing (busybox, macOS).
 */
async function copyTree(from: string, to: string, signal?: AbortSignal): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      await exec("cp", ["-a", "--reflink=auto", "--", from, to], { timeout: 900_000, signal });
      return true;
    } catch {
      await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {});
    }
  }
  try {
    await fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    return true;
  } catch {
    await fs.promises.rm(to, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

function digestOf(file: string): string | null {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function dependencyDigests(dir: string): Record<string, string | null> {
  return Object.fromEntries(DEPENDENCY_FILES.map((file) => [file, digestOf(path.join(dir, file))]));
}

function usesWorkspaces(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))?.workspaces);
  } catch {
    return false;
  }
}

/**
 * A head start from the version before: its `node_modules` when the lockfile is
 * the same, and Next's build cache. Both are copies, never links — see
 * `canReuseDependencies` — and the install still runs over them.
 */
async function seedFrom(previous: string, dir: string, log: (line: string) => void, signal?: AbortSignal): Promise<string[]> {
  const seeded: string[] = [];

  if (isRealDir(path.join(previous, "node_modules")) && !lexists(path.join(dir, "node_modules"))) {
    const verdict = canReuseDependencies(dependencyDigests(previous), dependencyDigests(dir), { workspaces: usesWorkspaces(dir) });
    if (!verdict.reuse) {
      log(`node_modules not reused from the previous release (${verdict.reason}): fresh install.`);
    } else if (await copyTree(path.join(previous, "node_modules"), path.join(dir, "node_modules"), signal)) {
      seeded.push("node_modules");
    } else {
      log("node_modules could not be copied from the previous release: fresh install.");
    }
  }

  const cache = path.join(previous, ".next", "cache");
  if (isRealDir(cache) && !lexists(path.join(dir, ".next"))) {
    fs.mkdirSync(path.join(dir, ".next"));
    if (await copyTree(cache, path.join(dir, ".next", "cache"), signal)) seeded.push(".next/cache");
  }

  return seeded;
}

// --- creating a version -----------------------------------------------------------------

export interface CreateReleaseOptions {
  id: string;
  /** `<releasesDir>/<slug>`. */
  root: string;
  /** `<reposDir>/<slug>`: the project folder, where the data is. */
  checkout: string;
  /** Where the files come from: the project folder, or the running version for a rebuild. */
  source: string;
  /** The version running now, if it is one. */
  previous: { id: string; dir: string; manifest: ReleaseManifest | null } | null;
  /** Reuse the previous version's dependencies. Off for a rebuild, which is a clean one. */
  seed: boolean;
  envFile: string | null;
  log: (line: string) => void;
  signal?: AbortSignal;
}

export interface CreatedRelease {
  id: string;
  dir: string;
  manifest: ReleaseManifest;
  seeded: string[];
}

/**
 * A new version folder, ready to build in.
 *
 *  1. Its own git: a clone of the source, objects hard-linked where git can,
 *     with the index set from HEAD and `origin` pointing where the project
 *     folder's does. A build that asks git which commit it is gets the answer,
 *     and the version stays readable whatever happens to the project folder.
 *  2. The source's files, copied from its working tree rather than checked out
 *     again: a rebuild keeps an edit made from the file manager, and LFS files
 *     arrive as their content.
 *  3. A link for everything the project folder keeps (`linkPlan`), and one into
 *     the running version for whatever it wrote that has not been handed over
 *     yet, so a migration in the release command finds the live database.
 *  4. Dependencies from the previous version, when they can be reused.
 *
 * Fails before anything else is touched, and leaves nothing behind when it does.
 */
export async function createRelease(opts: CreateReleaseOptions): Promise<CreatedRelease> {
  const { id, root, log } = opts;
  if (!isReleaseId(id)) throw new Error(`Nome di versione non valido: ${id}`);

  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, id);
  if (lexists(dir)) {
    // Only a deploy with this very id could have made it, and it never got to
    // run: a panel restart in the middle. Unless it is the one in use.
    if (readCurrent(root) === id) throw new Error(`La cartella ${dir} è quella in uso`);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }

  try {
    await git(root, ["clone", "--quiet", "--no-checkout", "--", opts.source, dir], 300_000);
    await git(dir, ["reset", "--quiet"]);
    const origin = (await git(opts.checkout, ["remote", "get-url", "origin"]).catch(() => "")).trim();
    if (origin) await git(dir, ["remote", "set-url", "origin", origin]);
    else await git(dir, ["remote", "remove", "origin"]).catch(() => "");

    const [files, sourceTracked, checkoutIgnored] = await Promise.all([
      listSourceFiles(opts.source),
      listTracked(opts.source),
      listIgnored(opts.checkout),
    ]);

    const anchor = checkoutAnchor(opts.checkout);
    const plan = linkPlan({
      checkoutIgnored,
      sourceTracked,
      envFile: opts.envFile,
      inCheckout: (folder) => isRealDir(at(anchor, folder)),
    });

    const copied = await copyFiles(opts.source, dir, copyList(files, plan.folders), opts.signal);
    log(`Copied ${copied} file(s) from ${opts.source === opts.checkout ? "the project folder" : "the running release"}.`);

    const links: string[] = [];
    for (const entry of plan.links) {
      const target = at(anchor, entry);
      if (!lexists(target)) continue;
      const link = at(dir, entry);
      if (lexists(link)) {
        log(`Shared entry not linked, the release has its own: ${entry}`);
        continue;
      }
      if (!ensureParent(dir, entry)) {
        log(`Shared entry not linked, a folder on its way is a link: ${entry}`);
        continue;
      }
      makeLink(link, target);
      links.push(entry);
    }

    // The placeholders of a folder shared whole are still in the index, and git
    // cannot look at them through the link: without this they read as deleted.
    const hidden = sourceTracked.filter((file) => plan.folders.some((folder) => file.startsWith(`${folder}/`)));
    for (let i = 0; i < hidden.length; i += 200) {
      await git(dir, ["update-index", "--skip-worktree", "--", ...hidden.slice(i, i + 200)]);
    }

    /*
      What the running version wrote and still holds: a path the project folder
      did not have, or one of its links an atomic save replaced with a real file,
      where the project folder's copy is now the stale one. Either way the live
      copy is in the running version, so that is where this one's link goes —
      replacing the link to the stale copy just made — until the switch hands it
      over and points the link at the project folder.
    */
    const pending: string[] = [];
    if (opts.previous) {
      const previousDir = fs.realpathSync(opts.previous.dir);
      for (const entry of await liveEntries(previousDir, opts.previous.manifest, opts.envFile)) {
        const link = at(dir, entry);
        const ours = links.indexOf(entry);
        if (ours >= 0) {
          pointLink(link, at(previousDir, entry));
          links.splice(ours, 1);
        } else if (lexists(link) || !ensureParent(dir, entry)) {
          continue;
        } else {
          makeLink(link, at(previousDir, entry));
        }
        pending.push(entry);
      }
    }

    appendExclude(dir, [...links, ...pending]);

    if (links.length > 0) log(`Shared with the project folder: ${summarize(links)}`);
    if (pending.length > 0) log(`Still in the running release, handed over at the switch: ${summarize(pending)}`);

    const seeded = opts.seed && opts.previous ? await seedFrom(opts.previous.dir, dir, log, opts.signal) : [];
    if (seeded.length > 0) log(`Reused from the previous release: ${seeded.join(", ")}`);

    // Asserted rather than assumed: an app started on a link that leads nowhere
    // would find an empty database and start filling it.
    for (const entry of links) {
      if (fs.realpathSync(at(dir, entry)) !== fs.realpathSync(at(anchor, entry))) {
        throw new Error(`Il collegamento ${entry} non porta alla cartella del progetto`);
      }
    }

    const commit = (await git(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
    const manifest: ReleaseManifest = { version: 1, id, createdAt: Date.now(), startedAt: null, commit, links, pending };
    writeManifest(root, manifest);
    return { id, dir, manifest, seeded };
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    fs.rmSync(manifestPath(root, id), { force: true });
    throw err;
  }
}

// --- handing data over -------------------------------------------------------------------

export interface PromotionResult {
  moved: string[];
  replaced: { path: string; aside: string }[];
  kept: string[];
}

function linkState(target: string): "absent" | "link" | "real" {
  if (!lexists(target)) return "absent";
  return isSymlink(target) ? "link" : "real";
}

/**
 * Hand what the outgoing version wrote to the project folder, once it has
 * stopped for good: see `planPromotion` for what moves and why.
 *
 * A move is a rename, so it is instant and leaves nothing half-copied. Where it
 * cannot be one — the project folder moved to another disk — the file stays in
 * its version, which is then kept on disk rather than removed. The outgoing
 * version gets a link where the file was, so a rollback to it still finds it;
 * the incoming one gets a link too, unless its own build made something there.
 */
export async function promote(opts: {
  root: string;
  checkout: string;
  from: { id: string; dir: string; manifest: ReleaseManifest | null };
  to: { id: string; dir: string } | null;
  envFile: string | null;
  log: (line: string) => void;
}): Promise<PromotionResult> {
  const { from, to, log } = opts;
  const result: PromotionResult = { moved: [], replaced: [], kept: [] };
  const candidates = await unknownEntries(from.dir, opts.envFile);
  if (candidates.length === 0) return result;

  const anchor = checkoutAnchor(opts.checkout);
  const tracked = await trackedAmong(opts.checkout, candidates);
  const since = from.manifest?.startedAt ?? null;
  const facts: EntryFacts[] = candidates.map((entry) => ({
    path: entry,
    changedAfterStart: since === null || changedSince(at(from.dir, entry), since),
    inCheckout: lexists(at(anchor, entry)),
    trackedInCheckout: tracked.has(entry),
    incoming: to ? linkState(at(to.dir, entry)) : "none",
  }));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const linkedOld: string[] = [];
  const linkedNew: string[] = [];

  for (const step of planPromotion(facts)) {
    if (step.action === "skip") continue;
    if (step.action === "keep") {
      log(`ATTENZIONE: ${step.path} resta nella versione ${from.id}: nella cartella del progetto è un file del repository.`);
      result.kept.push(step.path);
      continue;
    }

    const source = at(from.dir, step.path);
    const destination = at(anchor, step.path);
    let aside: string | null = null;
    try {
      if (!ensureParent(anchor, step.path)) throw new Error("una cartella sul percorso è un collegamento");
      if (step.action === "replace") {
        aside = at(path.join(opts.root, ".displaced", stamp), step.path);
        fs.mkdirSync(path.dirname(aside), { recursive: true });
        fs.renameSync(destination, aside);
      }
      // Asked again right before: rename(2) silently replaces a file that has
      // appeared at the destination since the facts were gathered.
      if (lexists(destination)) throw new Error("nella cartella del progetto è comparso un file con lo stesso nome");
      fs.renameSync(source, destination);
    } catch (err) {
      // The stale copy goes back where it was if the live one could not take its place.
      if (aside && !lexists(destination) && lexists(aside)) fs.renameSync(aside, destination);
      log(`ATTENZIONE: ${step.path} resta nella versione ${from.id}: ${err instanceof Error ? err.message : String(err)}`);
      result.kept.push(step.path);
      continue;
    }

    if (aside) {
      log(`ATTENZIONE: la copia di ${step.path} che la cartella del progetto aveva prima è stata spostata in ${aside}.`);
      result.replaced.push({ path: step.path, aside });
    } else {
      result.moved.push(step.path);
    }

    makeLink(source, destination);
    linkedOld.push(step.path);

    if (to && step.linkIncoming) {
      const incoming = at(to.dir, step.path);
      if (ensureParent(to.dir, step.path)) {
        pointLink(incoming, destination);
        linkedNew.push(step.path);
      }
    }
  }

  appendExclude(from.dir, linkedOld);
  if (to) appendExclude(to.dir, linkedNew);
  return result;
}

/**
 * Give a version a link for everything the project folder keeps that it has
 * nothing for. Run before each start: it is what finishes a hand-over a panel
 * restart interrupted, and what lets a version see data added to the project
 * folder since it was made. Only ever adds, or re-points a link that leads
 * nowhere.
 */
export async function repairLinks(opts: { dir: string; checkout: string; envFile: string | null }): Promise<string[]> {
  const anchor = checkoutAnchor(opts.checkout);
  const [checkoutIgnored, sourceTracked] = await Promise.all([listIgnored(opts.checkout), listTracked(opts.dir)]);
  const plan = linkPlan({ checkoutIgnored, sourceTracked, envFile: opts.envFile, inCheckout: (folder) => isRealDir(at(anchor, folder)) });

  const made: string[] = [];
  for (const entry of plan.links) {
    const target = at(anchor, entry);
    const link = at(opts.dir, entry);
    if (!lexists(target)) continue;
    if (lexists(link)) {
      if (isSymlink(link) && !fs.existsSync(link)) {
        pointLink(link, target);
        made.push(entry);
      }
      continue;
    }
    if (!ensureParent(opts.dir, entry)) continue;
    makeLink(link, target);
    made.push(entry);
  }
  appendExclude(opts.dir, made);
  return made;
}

// --- removing -----------------------------------------------------------------------------

/**
 * Remove one version. Never the current one, never anything that is not a
 * folder directly inside `root`, and never through a link: `fs.rm` unlinks the
 * links into the project folder, it does not descend into them.
 */
export async function removeRelease(root: string, id: string): Promise<void> {
  if (!isReleaseId(id)) throw new Error(`Nome di versione non valido: ${id}`);
  if (readCurrent(root) === id) throw new Error("È la versione in uso");
  const dir = path.join(root, id);
  if (lexists(dir)) {
    if (!isRealDir(dir) || path.dirname(fs.realpathSync(dir)) !== fs.realpathSync(root)) {
      throw new Error(`${dir} non è una cartella di versione`);
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  fs.rmSync(manifestPath(root, id), { force: true });
}

/**
 * The project folder's own dependencies and build output, once a version folder
 * has taken over: nothing runs from them any more, and `node_modules` is the
 * biggest thing on most disks. A deploy in place puts them back if the setting
 * is ever turned off. Only folders git does not track, only at the top.
 */
export async function freeCheckoutBuildDirs(checkout: string, log: (line: string) => void): Promise<string[]> {
  const freed: string[] = [];
  for (const name of ["node_modules", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", "venv", ".venv"]) {
    const target = path.join(checkout, name);
    if (!isRealDir(target)) continue;
    // A git that cannot answer leaves the folder alone: a committed `vendor`
    // or `node_modules` is the repository's, not a leftover.
    const tracked = await git(checkout, ["--literal-pathspecs", "ls-files", "-z", "--", name]).then(splitNul, () => null);
    if (tracked === null || tracked.length > 0) continue;
    await fs.promises.rm(target, { recursive: true, force: true });
    freed.push(name);
  }
  if (freed.length > 0) log(`Removed from the project folder, now unused: ${freed.join(", ")}`);
  return freed;
}
