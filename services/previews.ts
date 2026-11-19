import { getDb, nowIso } from "@/lib/db";
import type { ProjectPreviewsTable, ProjectsTable, PreviewStopReason } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { githubRequest, githubToken, parseRepoSlug } from "@/lib/github";
import { labelFrom } from "@/lib/proxy-names";
import { environmentKindOf, environmentSlug } from "@/lib/environments";
import {
  decidePreview,
  idlePreviews,
  parsePreviewSettings,
  parsePullRequest,
  pollChanges,
  previewLabel,
  previewName,
  previewSlugSuffix,
  previewsToStop,
  type PreviewSettings,
  type PullRequest,
} from "@/lib/previews";
import { cancelDeploy, enqueueDeploy } from "./deploy-queue";
import { giveAddress } from "./environments";
import { processManager } from "./process-manager";
import { insertProjectCopy } from "./project-copy";
import { deleteProject } from "./project-delete";
import { tryLock } from "./project-lock";

/**
 * Previews of pull requests, as stored and as run: what an event does to
 * them, the ceiling, the idle sweep, the approval of a fork's commit, and
 * the commit status on GitHub.
 *
 * The decisions are in `lib/previews.ts`; this file carries them out. A
 * preview is a project like any other (services/project-copy.ts), deleted
 * like any other (services/project-delete.ts), so nothing done to one reaches
 * production.
 */

export function previewSettingsOf(production: Pick<ProjectsTable, "preview_settings">): PreviewSettings {
  return parsePreviewSettings(production.preview_settings);
}

async function recordOf(productionId: string, prNumber: number): Promise<ProjectPreviewsTable | undefined> {
  const db = await getDb();
  return db.selectFrom("project_previews").selectAll().where("production_id", "=", productionId).where("pr_number", "=", prNumber).executeTakeFirst();
}

async function projectOf(record: ProjectPreviewsTable): Promise<ProjectsTable | undefined> {
  if (!record.project_id) return undefined;
  const db = await getDb();
  return db.selectFrom("projects").selectAll().where("id", "=", record.project_id).executeTakeFirst();
}

/** The pull request's facts onto its record, which is made the first time. */
async function upsertRecord(production: ProjectsTable, pr: PullRequest): Promise<ProjectPreviewsTable> {
  const db = await getDb();
  const now = nowIso();
  const facts = {
    title: pr.title,
    author: pr.author,
    url: pr.url,
    head_ref: pr.headRef,
    head_sha: pr.headSha,
    head_repo: pr.headRepo,
    fork: pr.fork ? 1 : 0,
    updated_at: now,
  };
  const existing = await recordOf(production.id, pr.number);
  if (existing) {
    await db.updateTable("project_previews").set(facts).where("id", "=", existing.id).execute();
  } else {
    try {
      await db
        .insertInto("project_previews")
        .values({ id: generateId(), production_id: production.id, pr_number: pr.number, state: "waiting", last_activity_at: now, created_at: now, ...facts })
        .execute();
    } catch {
      // The webhook and the poller saw it at once: the other one made it.
      await db.updateTable("project_previews").set(facts).where("production_id", "=", production.id).where("pr_number", "=", pr.number).execute();
    }
  }
  return (await recordOf(production.id, pr.number))!;
}

// --- stopping --------------------------------------------------------------------------

/** Stop a preview's app, as "Ferma" does, and say why on its record. */
export async function stopPreview(record: ProjectPreviewsTable, reason: PreviewStopReason): Promise<boolean> {
  const db = await getDb();
  const project = await projectOf(record);
  if (project) {
    const deploy = cancelDeploy(project.id);
    if (deploy) await Promise.race([deploy, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    const release = tryLock(project.id, "stop");
    if (!release) return false;
    try {
      await processManager.stop(project.slug, project.runtime_type).catch(() => undefined);
      await db.updateTable("projects").set({ status: "stopped", crashed_at: null, updated_at: nowIso() }).where("id", "=", project.id).execute();
    } finally {
      release();
    }
  }
  await db.updateTable("project_previews").set({ state: "stopped", stopped_reason: reason, updated_at: nowIso() }).where("id", "=", record.id).execute();
  return true;
}

/** The preview and its record, gone: its project like any project, its databases with it. */
export async function removePreview(record: ProjectPreviewsTable): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = await getDb();
  const project = await projectOf(record);
  if (project) {
    const outcome = await deleteProject(project, { deleteServices: true });
    if (!outcome.ok) return { ok: false, error: outcome.error };
  }
  await db.deleteFrom("project_previews").where("id", "=", record.id).execute();
  return { ok: true };
}

// --- deploying ---------------------------------------------------------------------------

async function createPreviewProject(production: ProjectsTable, record: ProjectPreviewsTable, settings: PreviewSettings, sha: string) {
  const db = await getDb();
  const taken = new Set((await db.selectFrom("projects").select("slug").execute()).map((row) => row.slug));
  const project = await insertProjectCopy({
    source: production,
    name: previewName(production.name, record.pr_number),
    slug: environmentSlug(production.slug, previewSlugSuffix(record.pr_number), taken),
    // Cloned from production's branch, which the base repository always has
    // — a fork's branch it does not — and then held at the pull request's
    // head, which GitHub serves by its sha (services/git-manager.ts).
    sourceBranch: production.source_branch,
    environment: { of: production.id, kind: "preview" },
    access: true,
    pinnedSha: sha,
  });
  const address = settings.domainId
    ? await giveAddress(project, { kind: "domain", domainId: settings.domainId, subdomain: previewLabel(record.pr_number) })
    : await giveAddress(project, { kind: "instant", label: previewLabel(record.pr_number, labelFrom(production.slug)) });
  await db
    .updateTable("project_previews")
    .set({ project_id: project.id, address_problem: address.ok ? null : address.error, updated_at: nowIso() })
    .where("id", "=", record.id)
    .execute();
  return project;
}

/** The other previews of production that run now, oldest activity first, for the ceiling. */
async function runningPreviews(productionId: string, except: string) {
  const db = await getDb();
  return db
    .selectFrom("project_previews")
    .innerJoin("projects", "projects.id", "project_previews.project_id")
    .selectAll("project_previews")
    .where("project_previews.production_id", "=", productionId)
    .where("project_previews.state", "=", "active")
    .where("project_previews.id", "!=", except)
    .where("projects.status", "in", ["running", "deploying"])
    .execute();
}

export type DeployPreviewOutcome =
  | { ok: true; deploymentId: string | null; queued: boolean; stopped: number[]; created: boolean }
  | { ok: false; status: number; error: string };

/**
 * Deploy `sha` as the preview of `record`'s pull request: its project made
 * the first time, the previews over the ceiling stopped first, the project
 * held at the commit and deployed.
 */
export async function deployPreview(
  production: ProjectsTable,
  record: ProjectPreviewsTable,
  sha: string,
  trigger: "webhook" | "poll" | "manual"
): Promise<DeployPreviewOutcome> {
  const db = await getDb();
  const settings = previewSettingsOf(production);
  // The gate holds whatever asks: an unapproved commit of a fork never runs.
  if (record.fork === 1 && record.approved_sha !== sha) {
    return { ok: false, status: 409, error: "Il commit di questa pull request viene da un fork e non è stato approvato." };
  }

  let project = await projectOf(record);
  const created = !project;
  if (!project) project = await createPreviewProject(production, record, settings, sha);

  const stopped: number[] = [];
  const running = await runningPreviews(production.id, record.id);
  for (const id of previewsToStop(running.map((p) => ({ id: p.id, lastActivityAt: p.last_activity_at })), settings.maxPreviews)) {
    const other = running.find((p) => p.id === id);
    if (other && (await stopPreview(other, "limit"))) stopped.push(other.pr_number);
  }

  const now = nowIso();
  await db.updateTable("projects").set({ pinned_sha: sha, pinned_at: now, updated_at: now }).where("id", "=", project.id).execute();
  await db
    .updateTable("project_previews")
    .set({ state: "active", stopped_reason: null, last_activity_at: now, updated_at: now })
    .where("id", "=", record.id)
    .execute();

  const result = await enqueueDeploy(project.id, { mode: "deploy", trigger, commitSha: sha, commitMessage: null });
  if (result.status === "not-found") return { ok: false, status: 404, error: "L'anteprima non esiste più." };
  if (result.status === "unavailable") return { ok: false, status: 503, error: "Il pannello si sta riavviando: riprova tra poco." };
  if (settings.commitStatus) void writeCommitStatus(production, record.id, sha, "pending");
  return { ok: true, deploymentId: result.deploymentId ?? null, queued: result.status === "queued", stopped, created };
}

// --- an event -------------------------------------------------------------------------------

export interface PreviewEventOutcome {
  status: "accepted" | "ignored";
  /** English, like the rest of the delivery history GitHub shows. */
  message: string;
  summary: Record<string, unknown>;
  deploymentId: string | null;
}

/**
 * One pull request event — a webhook delivery, or what the poller found —
 * against one production project.
 */
export async function handlePullRequest(
  production: ProjectsTable,
  action: string,
  pr: PullRequest,
  trigger: "webhook" | "poll"
): Promise<PreviewEventOutcome> {
  const summary: Record<string, unknown> = { pr: pr.number, action, head: pr.headSha.slice(0, 7), fork: pr.fork };
  const ignored = (reason: string): PreviewEventOutcome => ({ status: "ignored", message: `Ignored: ${reason}`, summary: { ...summary, reason }, deploymentId: null });
  if (environmentKindOf(production) !== null) return ignored("not a production project");

  const settings = previewSettingsOf(production);
  const existing = await recordOf(production.id, pr.number);
  const decision = decidePreview({
    settings,
    productionBranch: production.source_branch,
    action,
    pr,
    known: existing ? { headSha: existing.head_sha, approvedSha: existing.approved_sha, hasProject: Boolean(existing.project_id) } : null,
  });

  switch (decision.kind) {
    case "ignore":
      return ignored(decision.reason);
    case "remove": {
      const removed = existing ? await removePreview(existing) : { ok: true as const };
      return removed.ok
        ? { status: "accepted", message: "Preview removed", summary: { ...summary, removed: true }, deploymentId: null }
        : { status: "ignored", message: `Preview not removed: ${removed.error}`, summary: { ...summary, reason: "busy" }, deploymentId: null };
    }
    case "update":
      await upsertRecord(production, pr);
      return { status: "accepted", message: "Preview updated", summary, deploymentId: null };
    case "wait": {
      const record = await upsertRecord(production, pr);
      return { status: "accepted", message: "Pull request from a fork: waiting for approval in RunPanel", summary: { ...summary, waiting: true, preview: record.id }, deploymentId: null };
    }
    case "deploy": {
      const record = await upsertRecord(production, pr);
      const outcome = await deployPreview(production, record, decision.sha, trigger);
      if (!outcome.ok) return { status: "ignored", message: `Preview not deployed: ${outcome.error}`, summary: { ...summary, reason: outcome.error }, deploymentId: null };
      return {
        status: "accepted",
        message: outcome.created ? "Preview created" : "Preview redeployed",
        summary: { ...summary, created: outcome.created, queued: outcome.queued, stopped: outcome.stopped },
        deploymentId: outcome.deploymentId,
      };
    }
  }
}

/** Approve a fork's head commit, and deploy it. Only the commit shown can be approved. */
export async function approvePreview(production: ProjectsTable, record: ProjectPreviewsTable, sha: string): Promise<DeployPreviewOutcome> {
  if (record.head_sha !== sha) {
    return { ok: false, status: 409, error: `La pull request è andata avanti: ora è su ${record.head_sha.slice(0, 7)}. Rileggi e approva quel commit.` };
  }
  const db = await getDb();
  await db.updateTable("project_previews").set({ approved_sha: sha, updated_at: nowIso() }).where("id", "=", record.id).execute();
  return deployPreview(production, { ...record, approved_sha: sha }, sha, "manual");
}

// --- the list ------------------------------------------------------------------------------------

export interface PreviewView {
  id: string;
  prNumber: number;
  title: string;
  author: string;
  url: string;
  headRef: string;
  headSha: string;
  fork: boolean;
  approvedSha: string | null;
  /** A fork's head commit nobody approved yet: the row offers to approve it. */
  needsApproval: boolean;
  state: string;
  stoppedReason: PreviewStopReason | null;
  lastActivityAt: string;
  addressProblem: string | null;
  statusProblem: string | null;
  project: { id: string; name: string; status: string; url: string | null; pinnedSha: string | null } | null;
}

export interface PreviewsView {
  settings: PreviewSettings;
  previews: PreviewView[];
  /** What the previews that run take from the server now, from the Monitor's last samples. */
  usage: { running: number; memoryBytes: number | null; cpuPercent: number | null };
  /** Whether pull request events can reach the panel, and why not. */
  transport: { ok: boolean; problem: string | null };
}

const SAMPLE_FRESH_MS = 5 * 60 * 1000;

export async function previewsView(production: ProjectsTable): Promise<PreviewsView> {
  const db = await getDb();
  const settings = previewSettingsOf(production);
  const records = await db.selectFrom("project_previews").selectAll().where("production_id", "=", production.id).orderBy("pr_number", "desc").execute();
  const ids = records.map((r) => r.project_id).filter((id): id is string => id !== null);
  const [projects, hosts, samples] = ids.length
    ? await Promise.all([
        db.selectFrom("projects").select(["id", "name", "status", "pinned_sha"]).where("id", "in", ids).execute(),
        db
          .selectFrom("project_hosts")
          .select(["project_id", "hostname", "status"])
          .where("project_id", "in", ids)
          .where("redirect_to", "is", null)
          .where("apply_error", "is", null)
          .execute(),
        db
          .selectFrom("metric_samples")
          .select(["subject_id", "ts", "cpu", "mem"])
          .where("scope", "=", "project")
          .where("tier", "=", 0)
          .where("subject_id", "in", ids)
          .where("ts", ">=", Date.now() - SAMPLE_FRESH_MS)
          .orderBy("ts", "desc")
          .execute(),
      ])
    : [[], [], []];

  const running = projects.filter((p) => p.status === "running" || p.status === "deploying");
  const latest = new Map<string, { cpu: number | null; mem: number | null }>();
  for (const sample of samples) if (!latest.has(sample.subject_id)) latest.set(sample.subject_id, { cpu: sample.cpu, mem: sample.mem });
  const measured = running.map((p) => latest.get(p.id)).filter((s): s is { cpu: number | null; mem: number | null } => s !== undefined);

  const token = await githubToken();
  const problem =
    production.source_type !== "github" || !parseRepoSlug(production.source_url)
      ? "Le anteprime servono un repository GitHub come sorgente."
      : !token
        ? "Collega GitHub al pannello: le anteprime leggono le pull request con il suo token."
        : production.deploy_trigger !== "poll" && !production.github_hook_id
          ? "Il webhook non è registrato su GitHub: le pull request non arriverebbero. Attiva le anteprime per registrarlo, o passa al controllo nuovi commit."
          : null;

  return {
    settings,
    previews: records.map((r) => {
      const project = projects.find((p) => p.id === r.project_id);
      const host = hosts.find((h) => h.project_id === r.project_id);
      return {
        id: r.id,
        prNumber: r.pr_number,
        title: r.title,
        author: r.author,
        url: r.url,
        headRef: r.head_ref,
        headSha: r.head_sha,
        fork: r.fork === 1,
        approvedSha: r.approved_sha,
        needsApproval: r.fork === 1 && r.approved_sha !== r.head_sha,
        state: r.state,
        stoppedReason: r.stopped_reason,
        lastActivityAt: r.last_activity_at,
        addressProblem: r.address_problem,
        statusProblem: r.status_problem,
        project: project
          ? {
              id: project.id,
              name: project.name,
              status: project.status,
              url: host ? `${host.status === "active" ? "https" : "http"}://${host.hostname}` : null,
              pinnedSha: project.pinned_sha,
            }
          : null,
      };
    }),
    usage: {
      running: running.length,
      memoryBytes: measured.length ? measured.reduce((n, s) => n + (s.mem ?? 0), 0) : null,
      cpuPercent: measured.length ? measured.reduce((n, s) => n + (s.cpu ?? 0), 0) : null,
    },
    transport: { ok: problem === null, problem },
  };
}

/** A preview record of production's, by id. */
export async function previewOf(productionId: string, previewId: string): Promise<ProjectPreviewsTable | undefined> {
  const db = await getDb();
  return db.selectFrom("project_previews").selectAll().where("production_id", "=", productionId).where("id", "=", previewId).executeTakeFirst();
}

/** Every preview of production removed, when previews are turned off. */
export async function removeAllPreviews(productionId: string): Promise<{ removed: number; failed: string[] }> {
  const db = await getDb();
  const records = await db.selectFrom("project_previews").selectAll().where("production_id", "=", productionId).execute();
  const failed: string[] = [];
  let removed = 0;
  for (const record of records) {
    const outcome = await removePreview(record);
    if (outcome.ok) removed++;
    else failed.push(`PR #${record.pr_number}: ${outcome.error}`);
  }
  return { removed, failed };
}

// --- the poller ----------------------------------------------------------------------------------

const pullEtags = new Map<string, string>();

/**
 * Previews for a project on polling: the open pull requests against its
 * branch, compared with the previews known. A new one or a new head is
 * handled like `opened`; one no longer open like `closed`. An unchanged list
 * answers 304, which GitHub does not count against the hourly limit.
 */
export async function pollPreviews(production: ProjectsTable, token: string): Promise<void> {
  const slug = parseRepoSlug(production.source_url);
  if (!slug) return;
  const key = `pulls:${production.id}`;
  const known = pullEtags.get(key);
  let res: Response;
  try {
    res = await githubRequest(
      `/repos/${slug.full}/pulls?state=open&base=${encodeURIComponent(production.source_branch)}&per_page=50`,
      token,
      { headers: known ? { "If-None-Match": known } : undefined }
    );
  } catch {
    return;
  }
  if (res.status === 304 || !res.ok) return;
  const etag = res.headers.get("etag");
  if (etag) pullEtags.set(key, etag);

  const open = ((await res.json()) as unknown[]).map(parsePullRequest).filter((pr): pr is PullRequest => pr !== null);
  const db = await getDb();
  const records = await db.selectFrom("project_previews").selectAll().where("production_id", "=", production.id).execute();
  const changes = pollChanges(records.map((r) => ({ prNumber: r.pr_number, headSha: r.head_sha })), open);
  for (const pr of changes.changed) {
    const record = records.find((r) => r.pr_number === pr.number);
    await handlePullRequest(production, record ? "synchronize" : "opened", pr, "poll");
  }
  for (const number of changes.closed) {
    const record = records.find((r) => r.pr_number === number);
    if (record) await removePreview(record);
  }
}

// --- the idle sweep ----------------------------------------------------------------------------

/** Stop every preview idle past its project's days. Exported so a tick can be driven by hand. */
export async function sweepIdlePreviews(now = new Date()): Promise<number> {
  const db = await getDb();
  const productions = await db.selectFrom("projects").selectAll().where("preview_settings", "is not", null).execute();
  let stopped = 0;
  for (const production of productions) {
    const settings = previewSettingsOf(production);
    const running = await runningPreviews(production.id, "");
    for (const id of idlePreviews(running.map((p) => ({ id: p.id, lastActivityAt: p.last_activity_at })), now, settings.idleDays)) {
      const record = running.find((p) => p.id === id);
      if (record && (await stopPreview(record, "idle"))) stopped++;
    }
  }
  return stopped;
}

const HOUR_MS = 60 * 60 * 1000;
const globalRef = globalThis as typeof globalThis & { __runpanelPreviewSweep?: NodeJS.Timeout };

/** Hourly, behind the schedulers flag like the other timers (instrumentation.ts). */
export function startPreviewSweeper(): void {
  if (globalRef.__runpanelPreviewSweep) return;
  globalRef.__runpanelPreviewSweep = setInterval(() => {
    void sweepIdlePreviews().catch((err) => console.error("[previews] Sweep failed:", err));
  }, HOUR_MS);
  globalRef.__runpanelPreviewSweep.unref?.();
}

// --- the commit status ----------------------------------------------------------------------------

/**
 * A commit status on the pull request's head, with the preview's address.
 *
 * Only when the settings ask for it, and only as far as the stored token may:
 * GitHub answers 403 or 404 to a token without "Commit statuses: write" (or
 * the classic `repo:status`). That is written on the record, for the settings
 * to say, and the preview carries on — a status is a courtesy, never a reason
 * for a deploy to fail.
 */
export async function writeCommitStatus(
  production: ProjectsTable,
  recordId: string,
  sha: string,
  state: "pending" | "success" | "failure"
): Promise<void> {
  try {
    const db = await getDb();
    const record = await db.selectFrom("project_previews").selectAll().where("id", "=", recordId).executeTakeFirst();
    const slug = parseRepoSlug(production.source_url);
    const token = await githubToken();
    if (!record || !slug || !token) return;
    const host = record.project_id
      ? await db
          .selectFrom("project_hosts")
          .select(["hostname", "status"])
          .where("project_id", "=", record.project_id)
          .where("redirect_to", "is", null)
          .executeTakeFirst()
      : undefined;
    const description =
      state === "pending" ? "Anteprima in preparazione" : state === "success" ? "Anteprima online" : "Il deploy dell'anteprima non è riuscito";
    const res = await githubRequest(`/repos/${slug.full}/statuses/${sha}`, token, {
      method: "POST",
      body: {
        state,
        context: "runpanel/preview",
        description,
        ...(host ? { target_url: `${host.status === "active" ? "https" : "http"}://${host.hostname}` } : {}),
      },
    });
    const problem = res.ok
      ? null
      : res.status === 403 || res.status === 404
        ? "Il token GitHub non può scrivere lo stato dei commit: serve «Commit statuses: Read and write» (o lo scope repo:status)."
        : `GitHub ha risposto ${res.status} allo stato del commit.`;
    await db.updateTable("project_previews").set({ status_problem: problem }).where("id", "=", recordId).execute();
  } catch {
    /* a status is a courtesy: the preview is not worse off without it */
  }
}

/** After a preview's deploy settles: the status says how it went. Never throws. */
export async function previewDeployFinished(project: ProjectsTable, ok: boolean, sha: string | null): Promise<void> {
  if (environmentKindOf(project) !== "preview" || !project.environment_of || !sha) return;
  try {
    const db = await getDb();
    const [production, record] = await Promise.all([
      db.selectFrom("projects").selectAll().where("id", "=", project.environment_of).executeTakeFirst(),
      db.selectFrom("project_previews").selectAll().where("project_id", "=", project.id).executeTakeFirst(),
    ]);
    if (!production || !record || !previewSettingsOf(production).commitStatus) return;
    await writeCommitStatus(production, record.id, sha, ok ? "success" : "failure");
  } catch {
    /* see writeCommitStatus */
  }
}
