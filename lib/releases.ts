import path from "path";

/**
 * Per-version folders for native projects: the rules, without the filesystem.
 *
 * A native app used to build in the folder it runs from, so by the time a new
 * version failed its health check the previous one's files were gone and there
 * was nothing to go back to. A project that opts in (`releaseMode`) now builds
 * each deploy into a folder of its own:
 *
 *   <dataDir>/repos/<slug>                 the project folder, as before: the
 *                                          git checkout, and every file the app
 *                                          keeps (SQLite, uploads, a hand-made
 *                                          .env.local). Backups, moves and the
 *                                          old in-place deploys keep using it.
 *   <dataDir>/releases/<slug>/<id>/        one version: its tracked files, its
 *                                          own dependencies and build output,
 *                                          and a link for every file the app
 *                                          keeps, pointing into the project
 *                                          folder.
 *   <dataDir>/releases/<slug>/<id>.json    what the panel knows about it.
 *   <dataDir>/releases/<slug>/current      → <id>, swapped by rename.
 *
 * The data never moves to make this work. That is the point of keeping it in
 * the project folder rather than in a new `shared/`: turning the setting off,
 * or a deploy failing half way, leaves the folder exactly as an in-place deploy
 * expects it, with nothing to migrate back.
 *
 * What counts as data is the one judgement in all of this, and it leans one
 * way on purpose. Dependencies, build output and caches are a version's own
 * (`VERSIONED_NAMES`); everything else git ignores is data and is shared. A
 * build that writes somewhere unusual therefore shares that file between
 * versions, which only makes the rollback less complete — the other mistake
 * would lose somebody's database.
 */

/** Runtimes that run on the host under PM2: the ones that need this at all. */
export const RELEASE_RUNTIMES: ReadonlySet<string> = new Set(["node", "static", "custom"]);

/**
 * Names a version owns, matched against every segment of a path.
 *
 * A superset of the backup's `REPO_EXCLUDES` (services/backup/project-export.ts),
 * and that is the rule rather than a coincidence: what a backup of the project
 * folder already treats as reproducible is never treated as data here, and
 * everything else a backup keeps is. The unit suite checks the inclusion.
 */
export const VERSIONED_NAMES: ReadonlySet<string> = new Set([
  // JavaScript: dependencies, framework output, build caches.
  "node_modules",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".astro",
  ".angular",
  ".parcel-cache",
  ".vite",
  ".expo",
  ".cache",
  ".yarn",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  "dist",
  "build",
  "out",
  "coverage",
  // Python.
  "venv",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  // Rust, Java, PHP, Go modules vendored by the build.
  "target",
  "vendor",
  ".gradle",
]);

/** Files a build regenerates at the root of a project, with nothing in them anyone typed. */
const VERSIONED_FILES: ReadonlySet<string> = new Set(["next-env.d.ts", ".eslintcache"]);

/**
 * Files that only exist to keep an empty folder in git. A folder holding
 * nothing else is a folder the app fills at runtime — `public/uploads/.gitkeep`,
 * Laravel's `storage/**\/.gitignore` — and is shared whole.
 */
export const PLACEHOLDER_FILES: ReadonlySet<string> = new Set([".gitkeep", ".keep", ".gitignore", ".empty", ".placeholder"]);

/** Whether a path inside a project belongs to one version rather than to all of them. */
export function isVersionedPath(relative: string): boolean {
  const segments = relative.split("/").filter(Boolean);
  if (segments.some((segment) => VERSIONED_NAMES.has(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  return VERSIONED_FILES.has(base) || base.endsWith(".tsbuildinfo");
}

// --- when ----------------------------------------------------------------------

export type ReleaseOffReason = "runtime" | "platform" | "source" | "no-git" | "setting";

export type ReleaseMode = { on: true } | { on: false; reason: ReleaseOffReason };

/**
 * Whether a deploy builds into a folder of its own.
 *
 *  - only native runtimes: Docker builds an image, Compose a stack;
 *  - not on Windows, where a symlink needs a privilege the panel does not have
 *    and a link cannot be replaced by a rename, so there is no atomic switch;
 *  - only from a git repository: an uploaded ZIP is the project folder itself,
 *    with no record of which files came from the archive and which the app
 *    wrote, so there is no telling code from data;
 *  - and only once the operator turned it on for this project: the automatic
 *    return (`rollback.enabled`, which Docker shares) and the native opt-in
 *    (`rollback.native`, off by default) both. An update of the panel never
 *    moves a live project into version folders by itself. Off, the deploy
 *    builds in place exactly as it did before, which is also the way back for
 *    a project that does not build well in a separate folder.
 */
export function releaseMode(input: {
  runtimeType: string;
  platform: string;
  sourceType: string;
  gitCheckout: boolean;
  rollbackEnabled: boolean;
  nativeEnabled: boolean;
}): ReleaseMode {
  if (!RELEASE_RUNTIMES.has(input.runtimeType)) return { on: false, reason: "runtime" };
  if (!releasesSupported(input.platform)) return { on: false, reason: "platform" };
  if (input.sourceType !== "github") return { on: false, reason: "source" };
  if (!input.gitCheckout) return { on: false, reason: "no-git" };
  if (!input.rollbackEnabled || !input.nativeEnabled) return { on: false, reason: "setting" };
  return { on: true };
}

/** The platform half of `releaseMode`, for a page that has no deploy to ask about. */
export function releasesSupported(platform: string): boolean {
  return platform !== "win32";
}

// --- where ---------------------------------------------------------------------

export const CURRENT_LINK = "current";

/**
 * A release folder is named after its deployment. `generateId` is a 12-letter
 * nanoid, which can start with `-`: such a name is only ever handed to another
 * program inside an absolute path, never on its own, or it would read as an
 * option.
 */
const RELEASE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isReleaseId(name: string): boolean {
  return RELEASE_ID.test(name) && name !== CURRENT_LINK;
}

/**
 * The release a stored artifact directory belongs to, or null.
 *
 * `root` is the project's folder of releases. The static builder serves a
 * folder inside the release (`<id>/dist`), so the first segment is the one
 * that names it.
 */
export function releaseIdOfPath(artifactDir: string, root: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(artifactDir));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const first = relative.split(/[\\/]+/)[0] ?? "";
  return isReleaseId(first) ? first : null;
}

// --- what ----------------------------------------------------------------------

/** `git … -z` output as a list, without the empty name after the last NUL. */
export function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * A path from git's output as the rest of this file spells it: forward
 * slashes, no trailing one, nothing that climbs out or into `.git`. Null for
 * anything else, which is skipped rather than trusted.
 */
export function normalizeEntry(raw: string): string | null {
  const cleaned = raw.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\.\//, "");
  if (!cleaned || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return null;
  const segments = cleaned.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  if (segments[0] === ".git") return null;
  return cleaned;
}

/**
 * Where the env file goes, relative to the version's folder, or null when the
 * project has none. Written by the panel into every version on every start, so
 * it is never shared: a link there would make the write land in the project
 * folder, and `writeEnvFileInto` refuses to follow one on purpose.
 */
export function envFileEntry(envFile: { enabled: boolean; path: string }): string | null {
  if (!envFile.enabled) return null;
  return normalizeEntry(envFile.path.replace(/^[/\\]+/, ""));
}

/** The env file itself, or a folder on its way. */
export function touchesEnvFile(entry: string, envFile: string | null): boolean {
  return envFile !== null && (entry === envFile || envFile.startsWith(`${entry}/`));
}

function isUnder(entry: string, folder: string): boolean {
  return entry === folder || entry.startsWith(`${folder}/`);
}

/**
 * What git ignores that is data, from `ls-files -o -i --directory` output.
 *
 * Sorted, without duplicates, and without anything already covered by a folder
 * in the same list.
 */
export function sharedEntries(ignored: string[], opts: { envFile: string | null }): string[] {
  const entries = [
    ...new Set(
      ignored
        .map(normalizeEntry)
        .filter((entry): entry is string => entry !== null)
        .filter((entry) => !isVersionedPath(entry) && !touchesEnvFile(entry, opts.envFile))
    ),
  ].sort();
  return entries.filter((entry) => !entries.some((other) => other !== entry && isUnder(entry, other)));
}

/**
 * Tracked folders that only hold placeholders, outermost first: the folders an
 * app fills at runtime. Shared whole, so what lands in them goes straight to the
 * project folder instead of waiting for the next deploy to be carried over.
 */
export function placeholderFolders(tracked: string[], opts: { envFile: string | null }): string[] {
  const real = new Set<string>();
  const placeholder = new Set<string>();

  for (const raw of tracked) {
    const file = normalizeEntry(raw);
    if (!file) continue;
    const segments = file.split("/");
    const isPlaceholder = PLACEHOLDER_FILES.has(segments[segments.length - 1] ?? "");
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join("/");
      (isPlaceholder ? placeholder : real).add(folder);
    }
  }

  const candidates = [...placeholder]
    .filter((folder) => !real.has(folder))
    .filter((folder) => !isVersionedPath(folder) && !touchesEnvFile(folder, opts.envFile))
    .sort();
  return candidates.filter((folder) => !candidates.some((other) => other !== folder && isUnder(folder, other)));
}

export interface LinkPlan {
  /** Placeholder folders linked whole. Their tracked files are not copied. */
  folders: string[];
  /** Every link to make, the folders included. */
  links: string[];
}

/**
 * The links a new version gets into the project folder.
 *
 * `inCheckout` says whether a placeholder folder is really there as a folder:
 * a rebuild copies the running version, whose commit the project folder may
 * no longer be on.
 */
export function linkPlan(input: {
  checkoutIgnored: string[];
  sourceTracked: string[];
  envFile: string | null;
  inCheckout: (folder: string) => boolean;
}): LinkPlan {
  const folders = placeholderFolders(input.sourceTracked, { envFile: input.envFile }).filter(input.inCheckout);
  const entries = sharedEntries(input.checkoutIgnored, { envFile: input.envFile }).filter(
    (entry) => !folders.some((folder) => isUnder(entry, folder))
  );
  return { folders, links: [...folders, ...entries].sort() };
}

/** The files a new version is made of: what the source has, minus the folders it links instead. */
export function copyList(files: string[], linkedFolders: string[]): string[] {
  const out: string[] = [];
  for (const raw of files) {
    const file = normalizeEntry(raw);
    if (!file) continue;
    if (linkedFolders.some((folder) => isUnder(file, folder))) continue;
    out.push(file);
  }
  return [...new Set(out)];
}

/**
 * A line for `.git/info/exclude` naming exactly one path.
 *
 * The links are untracked, so without it `git status` in a version reports
 * them, and a build script that insists on a clean tree refuses to run.
 * Anchored, and with every character gitignore would read as a pattern escaped.
 */
export function excludePattern(relative: string): string {
  const escaped = relative.replace(/[\\*?[\]!#]/g, (char) => `\\${char}`).replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
  return `/${escaped}`;
}

// --- dependencies -------------------------------------------------------------

/** Files whose content decides what an install puts in `node_modules`. */
export const DEPENDENCY_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc.yml",
] as const;

/**
 * Whether the previous version's `node_modules` can be copied as a head start.
 *
 * Copied, never hard-linked: an install step that rewrites a file in place —
 * `prisma generate` into `node_modules/.prisma`, `patch-package` — would
 * otherwise change the previous version too, and that version is the one the
 * rollback starts. Only when the lockfile is byte for byte the same, so the
 * copy is what a fresh install would produce, and the install still runs after
 * it. Never for a workspace, whose `node_modules` can link into the version it
 * was installed in.
 *
 * `previous` and `next` map each file to its content (or a digest of it), null
 * when the version does not have it.
 */
export function canReuseDependencies(
  previous: Record<string, string | null>,
  next: Record<string, string | null>,
  opts: { workspaces: boolean }
): { reuse: boolean; reason: string } {
  if (!next["package.json"]) return { reuse: false, reason: "no package.json" };
  if (opts.workspaces) return { reuse: false, reason: "workspaces" };
  const lockfiles = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
  if (!lockfiles.some((file) => next[file])) return { reuse: false, reason: "no lockfile" };
  for (const file of DEPENDENCY_FILES) {
    if ((previous[file] ?? null) !== (next[file] ?? null)) return { reuse: false, reason: `${file} changed` };
  }
  return { reuse: true, reason: "same lockfile" };
}

// --- carrying data over ---------------------------------------------------------

/**
 * What one version knows about itself, beside its folder.
 *
 * `startedAt` is when it first ran, which is what tells a file the app wrote
 * from one the build left: see `planPromotion`. Null until then; a version that
 * never ran wrote nothing anyone needs.
 */
export interface ReleaseManifest {
  version: 1;
  id: string;
  createdAt: number;
  startedAt: number | null;
  commit: string | null;
  /** Links into the project folder made when the version was created. */
  links: string[];
  /** Links into the version that was running then, for what it had not handed over yet. */
  pending: string[];
}

export function parseManifest(raw: string | null | undefined): ReleaseManifest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ReleaseManifest>;
    if (value?.version !== 1 || typeof value.id !== "string") return null;
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
    return {
      version: 1,
      id: value.id,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      startedAt: typeof value.startedAt === "number" ? value.startedAt : null,
      commit: typeof value.commit === "string" ? value.commit : null,
      links: strings(value.links),
      pending: strings(value.pending),
    };
  } catch {
    return null;
  }
}

export interface EntryFacts {
  path: string;
  /** Changed after the version first started: the app wrote it, the build did not. */
  changedAfterStart: boolean;
  /** The project folder already has something there. */
  inCheckout: boolean;
  /** …and it is a file git tracks, i.e. source, not data. */
  trackedInCheckout: boolean;
  /** What the version taking over has there; `none` when no version is (leaving releases). */
  incoming: "none" | "absent" | "link" | "real";
}

export type PromotionStep =
  | { path: string; action: "skip" }
  | { path: string; action: "keep"; reason: "tracked" }
  | { path: string; action: "move" | "replace"; linkIncoming: boolean };

/**
 * What to do with each file the outgoing version holds that the project folder
 * does not, at the moment it stops for good.
 *
 * These are files git ignores that the app created in a path the project folder
 * did not have yet, and links of ours that something replaced with a real file
 * — an atomic save, write-then-rename, does exactly that to a linked JSON file.
 *
 *  - Not changed since the version started: the build made it. It stays with
 *    its version, which is what lets a rollback restore it.
 *  - Changed after: the app wrote it, so it is data and goes to the project
 *    folder, where every later version finds it. If the folder already has a
 *    copy, that copy is the stale one — the app was writing here — and it is
 *    moved aside, never deleted (`replace`).
 *  - Unless git tracks that path in the project folder: then it is source in
 *    the new commit, and the file stays where it is, said out loud.
 *
 * The incoming version gets a link where it has nothing, or only the temporary
 * link into the outgoing version; something real there is its own build's.
 */
export function planPromotion(facts: EntryFacts[]): PromotionStep[] {
  return facts.map((fact): PromotionStep => {
    if (!fact.changedAfterStart) return { path: fact.path, action: "skip" };
    if (fact.trackedInCheckout) return { path: fact.path, action: "keep", reason: "tracked" };
    const linkIncoming = fact.incoming === "absent" || fact.incoming === "link";
    return { path: fact.path, action: fact.inCheckout ? "replace" : "move", linkIncoming };
  });
}

// --- keeping two ------------------------------------------------------------------

export interface PrunePlan {
  keep: string[];
  /** `ran` is whether the version ever started: one that did may hold data to check first. */
  remove: { id: string; ran: boolean }[];
}

/**
 * Which versions stay on disk: the current one and the newest good one besides
 * it — the version a rollback or a restart goes back to. Two, at rest.
 *
 * `good` lists the ids of the deployments that worked, newest first; a version
 * whose deployment row is gone is not in it, and goes.
 */
export function planPrune(input: {
  onDisk: { id: string; startedAt: number | null }[];
  current: string | null;
  good: string[];
}): PrunePlan {
  const present = new Set(input.onDisk.map((release) => release.id));
  const keep: string[] = [];
  if (input.current && present.has(input.current)) keep.push(input.current);
  for (const id of input.good) {
    if (keep.length >= 2) break;
    if (present.has(id) && !keep.includes(id)) keep.push(id);
  }
  return {
    keep,
    remove: input.onDisk
      .filter((release) => !keep.includes(release.id))
      .map((release) => ({ id: release.id, ran: release.startedAt !== null })),
  };
}

// --- going back ---------------------------------------------------------------------

export type RollbackPlan = { attempt: true } | { attempt: false; reason: "not-health" | "off" | "no-release" | "first" | "missing" };

/**
 * Whether a failed deploy puts the previous version back online.
 *
 * Only a version that never answered its health check: a build or a release
 * command that failed never stopped the old one. Docker can always go back, its
 * images are on disk. A native project can when this deploy built into a
 * folder of its own and the version before it had one too: the first deploy
 * after the upgrade goes back to a project folder that `git pull` has already
 * moved to the new commit, which would put the new code online and call it the
 * old one.
 */
export function rollbackPlan(input: {
  healthFailed: boolean;
  cancelled: boolean;
  rollbackEnabled: boolean;
  runtimeType: string;
  usedRelease: boolean;
  previous: { isRelease: boolean; exists: boolean } | null;
}): RollbackPlan {
  if (!input.healthFailed || input.cancelled) return { attempt: false, reason: "not-health" };
  if (!input.rollbackEnabled) return { attempt: false, reason: "off" };
  if (input.runtimeType === "docker") return { attempt: true };
  if (!RELEASE_RUNTIMES.has(input.runtimeType) || !input.usedRelease) return { attempt: false, reason: "no-release" };
  if (!input.previous?.isRelease) return { attempt: false, reason: "first" };
  if (!input.previous.exists) return { attempt: false, reason: "missing" };
  return { attempt: true };
}

/** A few names for a log line, and how many more there are. */
export function summarize(paths: string[], max = 6): string {
  if (paths.length <= max) return paths.join(", ");
  return `${paths.slice(0, max).join(", ")} (+${paths.length - max})`;
}
