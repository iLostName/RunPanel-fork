import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { DeployContract } from "@/lib/deploy-contract";
import { envFileEntry, planPrune, releaseIdOfPath, summarize, type ReleaseManifest } from "@/lib/releases";
import { getRepoPath } from "./git-manager";
import {
  clearCurrent,
  liveEntries,
  listReleases,
  markStarted,
  promote,
  readCurrent,
  readManifest,
  removeRelease,
  setCurrent,
  type PromotionResult,
} from "./releases-fs";

/**
 * A project's version folders, as the rest of the panel asks about them.
 *
 * `releases-fs.ts` takes every path as an argument so it can be tested on its
 * own; this is the side that knows where a project's folders are and what its
 * deployments say.
 */

export function releasesRoot(slug: string): string {
  return path.join(config.releasesDir, slug);
}

export interface ReleaseRef {
  id: string;
  dir: string;
}

/** The version the project runs, or last ran: what `current` points at. */
export function currentRelease(slug: string): ReleaseRef | null {
  const root = releasesRoot(slug);
  const id = readCurrent(root);
  return id ? { id, dir: path.join(root, id) } : null;
}

/**
 * The folder the app's files are in as the app sees them: its current version,
 * or the project folder for a project that builds in place.
 *
 * What a scheduled task runs in, a pre-deploy command, the file manager.
 */
export function projectWorkDir(slug: string): string {
  return currentRelease(slug)?.dir ?? getRepoPath(slug);
}

/**
 * Where the file manager — and a restore — is rooted, and the other folder a
 * path inside it may lead to: a version's data links go to the project folder,
 * which is the project's own and was always open to the file manager.
 */
export function projectFileRoots(slug: string): { root: string; also: string[] } {
  const current = currentRelease(slug);
  return current ? { root: current.dir, also: [getRepoPath(slug)] } : { root: getRepoPath(slug), also: [] };
}

/** The version a deployment's recorded artifact directory belongs to. */
export function releaseOfArtifact(slug: string, artifactDir: string): ReleaseRef | null {
  const root = releasesRoot(slug);
  const id = releaseIdOfPath(artifactDir, root);
  return id ? { id, dir: path.join(root, id) } : null;
}

export function manifestOf(slug: string, id: string): ReleaseManifest | null {
  return readManifest(releasesRoot(slug), id);
}

/**
 * Make a version the current one, right before it starts. The first start is
 * also what dates the files the app writes from then on.
 */
export function activateRelease(slug: string, id: string): void {
  const root = releasesRoot(slug);
  setCurrent(root, id);
  markStarted(root, id);
}

/**
 * Nothing is current: the app is about to start from the project folder, a
 * deploy that built in place, and what follows its files must look there.
 */
export function clearCurrentRelease(slug: string): void {
  clearCurrent(releasesRoot(slug));
}

/**
 * The newest deployment that worked, as a version a failed deploy could go
 * back to. Null when there is none, or when it built in place.
 */
export async function previousGoodRelease(projectId: string, slug: string): Promise<{ isRelease: boolean; exists: boolean } | null> {
  const db = await getDb();
  const last = await db
    .selectFrom("deployments")
    .select("artifact_dir")
    .where("project_id", "=", projectId)
    .where("status", "in", ["running", "superseded"])
    .where("start_cmd", "is not", null)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!last?.artifact_dir) return null;
  const release = releaseOfArtifact(slug, last.artifact_dir);
  return { isRelease: release !== null, exists: release !== null && fs.existsSync(release.dir) };
}

function logPromotion(result: PromotionResult, log: (line: string) => void): void {
  const moved = [...result.moved, ...result.replaced.map((entry) => entry.path)];
  if (moved.length > 0) log(`Handed over to the project folder: ${summarize(moved)}`);
}

/**
 * The outgoing version's data, handed to the project folder and linked into the
 * incoming one. Called once the outgoing version has stopped, and only on a
 * deploy: a rollback or a restart goes back to a version without taking
 * anything from the one it leaves, whose files stay where they are.
 */
export async function handOver(
  slug: string,
  incoming: ReleaseRef,
  contract: DeployContract,
  log: (line: string) => void
): Promise<void> {
  const root = releasesRoot(slug);
  const outgoing = readCurrent(root);
  if (!outgoing || outgoing === incoming.id) return;
  const result = await promote({
    root,
    checkout: getRepoPath(slug),
    from: { id: outgoing, dir: path.join(root, outgoing), manifest: readManifest(root, outgoing) },
    to: incoming,
    envFile: envFileEntry(contract.envFile),
    log,
  });
  logPromotion(result, log);
}

/**
 * Back to building in place, with a version still current: its data goes to
 * the project folder, where the app is about to start, and nothing is current
 * any more.
 */
export async function leaveReleases(slug: string, contract: DeployContract, log: (line: string) => void): Promise<boolean> {
  const root = releasesRoot(slug);
  const current = readCurrent(root);
  if (!current) return false;
  try {
    const result = await promote({
      root,
      checkout: getRepoPath(slug),
      from: { id: current, dir: path.join(root, current), manifest: readManifest(root, current) },
      to: null,
      envFile: envFileEntry(contract.envFile),
      log,
    });
    logPromotion(result, log);
  } finally {
    // Whatever the hand-over managed: the app is about to run from the project
    // folder, and the pointer must not send the file manager anywhere else. A
    // version still holding data is kept by `pruneReleases`.
    clearCurrent(root);
  }
  log("Version folders no longer in use: the app runs from the project folder again.");
  return true;
}

/**
 * Remove the versions no longer needed: all but the current one and the newest
 * good one besides it (`planPrune`), or all of them once the project builds in
 * place again.
 *
 * A version that ran and still holds files the app wrote, which the hand-over
 * could not carry, stays on disk and is named in the log: deleting it is the
 * one thing here that could lose data, so it is left to a person.
 */
export async function pruneReleases(
  project: { id: string; slug: string },
  contract: DeployContract,
  log: (line: string) => void,
  opts: { keepNone?: boolean } = {}
): Promise<void> {
  const root = releasesRoot(project.slug);
  if (!fs.existsSync(root)) return;

  const db = await getDb();
  const good = opts.keepNone
    ? []
    : (
        await db
          .selectFrom("deployments")
          .select("id")
          .where("project_id", "=", project.id)
          .where("status", "in", ["running", "superseded"])
          .where("start_cmd", "is not", null)
          .orderBy("started_at", "desc")
          .limit(10)
          .execute()
      ).map((row) => row.id);

  const plan = planPrune({ onDisk: listReleases(root), current: opts.keepNone ? null : readCurrent(root), good });
  const envFile = envFileEntry(contract.envFile);
  const removed: string[] = [];

  for (const { id, ran } of plan.remove) {
    try {
      if (ran) {
        const live = await liveEntries(path.join(root, id), readManifest(root, id), envFile);
        if (live.length > 0) {
          log(
            `ATTENZIONE: la versione ${id} resta in ${path.join(root, id)}: contiene file scritti dall'app ` +
              `che non sono passati alla cartella del progetto (${summarize(live)}). Controllali e cancella la cartella a mano.`
          );
          continue;
        }
      }
      await removeRelease(root, id);
      removed.push(id);
    } catch (err) {
      log(`Release ${id} not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (removed.length > 0) log(`Removed old release folder(s): ${removed.join(", ")}`);
}

/** Every version of a project that is going away, with the project. */
export async function removeProjectReleases(slug: string): Promise<void> {
  // A real folder under `releases/`, so `rm` never follows anything out of it:
  // the links inside are unlinked, the project folder they point to is not
  // touched here.
  await fs.promises.rm(releasesRoot(slug), { recursive: true, force: true });
}
