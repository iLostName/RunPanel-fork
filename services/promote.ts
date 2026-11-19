import { execFile } from "child_process";
import { promisify } from "util";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { githubFetch, githubToken, parseRepoSlug } from "@/lib/github";
import { isCommitSha } from "@/lib/git-ref";
import { parseContractJson } from "@/lib/deploy-contract";
import { connectionOrigin } from "@/lib/service-env";
import { diffVariables, environmentKindOf, promoteBlocker, type VariableDiff } from "@/lib/environments";
import { enqueueDeploy, type EnqueueResult } from "./deploy-queue";
import { getRepoPath, repoExists } from "./git-manager";
import { liveCommitOf, productionOf } from "./environments";
import { loadSnapshot, resolveFor } from "./project-env";
import { injectLinkedServiceEnv } from "./service-injection";

const exec = promisify(execFile);

/**
 * "Promuovi in produzione": deploy on production exactly the commit staging
 * runs, through production's own deploy — its contract, its variables, its
 * automatic return and its switch without downtime — and nothing else of
 * staging's.
 *
 * It is a deploy of one commit, the same one "Scegli la versione" makes:
 * production is held at that commit (`pinned_sha`) until somebody goes back
 * to its branch, so the next push to production's branch does not quietly
 * undo the promotion.
 */

export interface CommitFacts {
  sha: string;
  message: string | null;
  author: string | null;
  date: string | null;
}

/** Who wrote the commit and when: from staging's checkout, which has it, else from GitHub. */
async function commitFacts(staging: ProjectsTable, sha: string, message: string | null): Promise<CommitFacts> {
  const facts: CommitFacts = { sha, message, author: null, date: null };
  if (!isCommitSha(sha)) return facts;
  if (repoExists(staging.slug)) {
    try {
      const { stdout } = await exec("git", ["show", "-s", "--format=%an%x1f%aI%x1f%s", sha], { cwd: getRepoPath(staging.slug), timeout: 10_000 });
      const [author, date, subject] = stdout.trim().split("\x1f");
      if (author) return { sha, author, date: date || null, message: subject || message };
    } catch {
      /* not in the checkout any more: GitHub below */
    }
  }
  const slug = parseRepoSlug(staging.source_url);
  const token = await githubToken();
  if (!slug || !token) return facts;
  try {
    const res = await githubFetch(`/repos/${slug.full}/commits/${sha}`, token);
    if (!res.ok) return facts;
    const body = (await res.json()) as { commit?: { message?: string; author?: { name?: string; date?: string } } };
    return {
      sha,
      author: body.commit?.author?.name ?? null,
      date: body.commit?.author?.date ?? null,
      message: body.commit?.message?.split("\n")[0] ?? message,
    };
  } catch {
    return facts;
  }
}

/**
 * What the app of a project receives, by name: its variables resolved, then
 * its database links on top, exactly as a deploy hands them over. A value
 * that does not resolve is null.
 */
async function receivedVariables(project: ProjectsTable): Promise<Record<string, string | null>> {
  const db = await getDb();
  const last = await db
    .selectFrom("deployments")
    .select("resolved_contract")
    .where("project_id", "=", project.id)
    .where("status", "in", ["running", "superseded"])
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const contract = parseContractJson(last?.resolved_contract ?? project.builder_config);
  const resolution = resolveFor(await loadSnapshot(project.id), connectionOrigin(project.runtime_type, contract.docker.network));
  const out: Record<string, string | null> = {};
  for (const v of resolution.vars) out[v.key] = v.value;
  const injected = await injectLinkedServiceEnv(project, contract.docker.network, { ...resolution.env });
  for (const item of injected.applied) out[item.key] = item.value;
  return out;
}

export interface PromotionPreview {
  staging: { id: string; name: string; branch: string };
  production: {
    id: string;
    name: string;
    branch: string;
    status: string;
    /** The commit production is held at now, if any. */
    pinnedSha: string | null;
    autoDeploy: boolean;
    rollback: boolean;
    zeroDowntime: boolean;
  } | null;
  commit: CommitFacts | null;
  /** Why it cannot be promoted now, or null. */
  blocker: string | null;
  /** Names only, seen from production: see `diffVariables`. */
  variables: VariableDiff[];
}

export async function promotionPreview(staging: ProjectsTable): Promise<PromotionPreview> {
  const production = staging.environment_of ? await productionOf(staging) : null;
  const sha = await liveCommitOf(staging.id);
  const blocker = promoteBlocker({
    stagingKind: environmentKindOf(staging),
    productionExists: production !== null,
    productionSourceType: production?.source_type ?? null,
    stagingCommit: sha,
  });

  let commit: CommitFacts | null = null;
  if (sha) {
    const db = await getDb();
    const row = await db
      .selectFrom("deployments")
      .select("commit_message")
      .where("project_id", "=", staging.id)
      .where("commit_sha", "=", sha)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();
    commit = await commitFacts(staging, sha, row?.commit_message ?? null);
  }

  const contract = production ? parseContractJson(production.builder_config) : null;
  const variables =
    production && !blocker ? diffVariables(await receivedVariables(staging), await receivedVariables(production)) : [];

  return {
    staging: { id: staging.id, name: staging.name, branch: staging.source_branch },
    production:
      production && contract
        ? {
            id: production.id,
            name: production.name,
            branch: production.source_branch,
            status: production.status,
            pinnedSha: production.pinned_sha,
            autoDeploy: production.auto_deploy === 1,
            rollback: contract.rollback.enabled,
            zeroDowntime: production.runtime_type === "docker" && contract.zeroDowntime.enabled,
          }
        : null,
    commit,
    blocker,
    variables,
  };
}

export type PromoteOutcome =
  | { ok: true; production: ProjectsTable; commitSha: string; deploy: EnqueueResult }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Deploy `commitSha` on production, if it is still what staging runs.
 *
 * The confirmation showed one commit; a deploy of staging finishing between
 * the dialog and the click would make "what staging runs" another one, and
 * production must get the commit that was confirmed or nothing.
 */
export async function promote(staging: ProjectsTable, commitSha: string): Promise<PromoteOutcome> {
  const production = staging.environment_of ? await productionOf(staging) : null;
  const live = await liveCommitOf(staging.id);
  const blocker = promoteBlocker({
    stagingKind: environmentKindOf(staging),
    productionExists: production !== null,
    productionSourceType: production?.source_type ?? null,
    stagingCommit: live,
  });
  if (blocker || !production || !live) return { ok: false, status: 409, error: blocker ?? "Non promuovibile ora.", code: "not_promotable" };
  if (live !== commitSha) {
    return {
      ok: false,
      status: 409,
      code: "staging_moved",
      error: `Lo staging ora esegue ${live.slice(0, 7)}, non ${commitSha.slice(0, 7)}: riapri la conferma per vedere cosa cambia.`,
    };
  }

  /*
    The pin first, the deploy after: the queue reads the row when it claims
    it, so the deploy — this one, or the one it queues behind a deploy in
    progress — builds the pinned commit. The same order the deploy route keeps
    for "Scegli la versione".
  */
  const db = await getDb();
  await db
    .updateTable("projects")
    .set({ pinned_sha: commitSha, pinned_at: nowIso(), updated_at: nowIso() })
    .where("id", "=", production.id)
    .execute();

  const deploy = await enqueueDeploy(production.id, { mode: "deploy", trigger: "manual", commitSha, commitMessage: null });
  if (deploy.status === "not-found") return { ok: false, status: 404, error: "Il progetto di produzione non esiste più." };
  if (deploy.status === "unavailable") return { ok: false, status: 503, error: "Il pannello si sta riavviando: riprova tra poco." };
  return { ok: true, production, commitSha, deploy };
}
