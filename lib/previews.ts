/**
 * Previews of pull requests, without a database: the rules, decided once.
 *
 * A preview is an environment (lib/environments.ts) made for one open pull
 * request against production's branch: a sibling project held at the pull
 * request's head commit, with its own address, removed when the pull request
 * closes. Opt-in per project, and only for a repository whose events reach
 * the panel — a webhook or the poller.
 *
 * Two rules carry the safety:
 * - a pull request from a fork is never deployed by itself: it would run a
 *   stranger's code on this server, with the preview's variables. Somebody
 *   approves each head commit in the panel;
 * - previews share the server, so there is a ceiling: past it the preview
 *   idle the longest is stopped, and so is one nobody touched for days.
 *
 * Zero imports: the unit suite loads this file directly, and the pages run it.
 */

export interface PreviewSettings {
  /** "Anteprime delle pull request": off by default. */
  enabled: boolean;
  /** How many may run at once; past it the one idle the longest is stopped. */
  maxPreviews: number;
  /** A preview with no activity for this many days is stopped. */
  idleDays: number;
  /**
   * The panel's domain the previews are named under, `pr-<n>.<domain>`,
   * through its wildcard record — null for an instant sslip.io address.
   */
  domainId: string | null;
  /** Write a commit status with the address on the pull request, when the token may. */
  commitStatus: boolean;
}

export const PREVIEW_DEFAULTS: PreviewSettings = {
  enabled: false,
  maxPreviews: 3,
  idleDays: 7,
  domainId: null,
  commitStatus: false,
};

export const MAX_PREVIEWS_LIMIT = 10;
export const IDLE_DAYS_LIMIT = 90;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** The stored JSON read back with every default in place: what is not readable is the default. */
export function parsePreviewSettings(json: string | null | undefined): PreviewSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(json ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    /* the defaults */
  }
  return {
    enabled: raw.enabled === true,
    maxPreviews: clampInt(raw.maxPreviews, 1, MAX_PREVIEWS_LIMIT, PREVIEW_DEFAULTS.maxPreviews),
    idleDays: clampInt(raw.idleDays, 1, IDLE_DAYS_LIMIT, PREVIEW_DEFAULTS.idleDays),
    domainId: typeof raw.domainId === "string" && raw.domainId ? raw.domainId : null,
    commitStatus: raw.commitStatus === true,
  };
}

// --- a pull request, as GitHub describes it -----------------------------------------

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  headRef: string;
  /** `owner/name` of the repository the head commit lives in; null when that fork was deleted. */
  headRepo: string | null;
  baseRef: string;
  baseRepo: string | null;
  /** The head lives somewhere else than the base: a fork, whose code is a stranger's. */
  fork: boolean;
  state: "open" | "closed";
  merged: boolean;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * The pull request of a `pull_request` delivery, or one entry of the pulls
 * list the poller reads — the same object — or null when it is not one the
 * panel can act on. The head commit and both branch names end up as git
 * arguments and in a URL, so they are held to what a commit and a branch may
 * be (lib/git-ref.ts has the same sets); a delivery that does not match is
 * not acted on at all.
 */
export function parsePullRequest(raw: unknown): PullRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const pr = raw as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const number = pr.number;
  const headSha = typeof pr.head?.sha === "string" ? pr.head.sha.toLowerCase() : "";
  const headRef = text(pr.head?.ref, 255);
  const baseRef = text(pr.base?.ref, 255);
  if (!Number.isInteger(number) || number <= 0 || !SHA.test(headSha) || !REF.test(headRef) || !REF.test(baseRef)) return null;
  if (headRef.includes("..") || baseRef.includes("..")) return null;
  const headRepo = typeof pr.head?.repo?.full_name === "string" ? pr.head.repo.full_name : null;
  const baseRepo = typeof pr.base?.repo?.full_name === "string" ? pr.base.repo.full_name : null;
  return {
    number,
    title: text(pr.title, 200) || `#${number}`,
    author: text(pr.user?.login, 100) || "sconosciuto",
    url: text(pr.html_url, 500),
    headSha,
    headRef,
    headRepo,
    baseRef,
    baseRepo,
    // No head repository at all is a fork that was deleted: still not ours.
    fork: headRepo === null || baseRepo === null || headRepo.toLowerCase() !== baseRepo.toLowerCase(),
    state: pr.state === "closed" ? "closed" : "open",
    merged: pr.merged === true,
  };
}

// --- what to do with an event ----------------------------------------------------------

/** What the panel already knows of a pull request's preview. */
export interface KnownPreview {
  headSha: string;
  approvedSha: string | null;
  hasProject: boolean;
}

export type PreviewDecision =
  /** Nothing to do; `reason` goes into the delivery history, in English like the rest of it. */
  | { kind: "ignore"; reason: string }
  /** The pull request closed, merged, or left production's branch: the preview goes. */
  | { kind: "remove" }
  /** A fork's commit nobody approved: recorded, shown with its button, never deployed. */
  | { kind: "wait" }
  /** Deploy this commit, creating the preview if there is none. */
  | { kind: "deploy"; sha: string }
  /** The title or the author changed: the record follows, nothing is deployed. */
  | { kind: "update" };

const DEPLOYING_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/**
 * One pull request event against one production project.
 *
 * `action` is GitHub's (`opened`, `synchronize`, `closed`, `edited`…); the
 * poller says `opened` for a pull request it sees for the first time or with
 * a new head, and `closed` for one that is gone from the open list.
 */
export function decidePreview(input: {
  settings: Pick<PreviewSettings, "enabled">;
  productionBranch: string;
  action: string;
  pr: PullRequest;
  known: KnownPreview | null;
}): PreviewDecision {
  const { settings, productionBranch, action, pr, known } = input;
  if (!settings.enabled) return known ? { kind: "remove" } : { kind: "ignore", reason: "previews are off" };
  if (action === "closed" || pr.state === "closed") return known ? { kind: "remove" } : { kind: "ignore", reason: "closed, no preview" };
  // A pull request retargeted away from production's branch is no longer one of its previews.
  if (pr.baseRef !== productionBranch) {
    return known ? { kind: "remove" } : { kind: "ignore", reason: `base ${pr.baseRef} is not ${productionBranch}` };
  }
  if (action === "edited") return known ? { kind: "update" } : { kind: "ignore", reason: "edited, no preview" };
  if (!DEPLOYING_ACTIONS.has(action)) return { kind: "ignore", reason: `action ${action} not handled` };
  if (pr.fork && known?.approvedSha !== pr.headSha) return { kind: "wait" };
  // A delivery repeated for the commit already deployed changes nothing.
  if (known && known.hasProject && known.headSha === pr.headSha && action !== "reopened" && action !== "ready_for_review") {
    return { kind: "ignore", reason: "commit already deployed" };
  }
  return { kind: "deploy", sha: pr.headSha };
}

// --- names and addresses ---------------------------------------------------------------

/** `shop-pr-12`: what the container, the image and the folder are named after. */
export function previewSlugSuffix(prNumber: number): string {
  return `pr-${prNumber}`;
}

/** `Negozio · PR #12`, within the 100 characters a name may have. */
export function previewName(productionName: string, prNumber: number): string {
  const suffix = ` · PR #${prNumber}`;
  return `${productionName.trim().slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}

/**
 * The first label of a preview's address. Under the operator's domain it is
 * `pr-<n>` — `pr-12.esempio.it`, covered by the domain's wildcard record. An
 * instant address shares its domain with every project on the server, so it
 * carries the project too: `pr-12-negozio.203-0-113-7.sslip.io`.
 */
export function previewLabel(prNumber: number, instantFor?: string): string {
  const base = `pr-${prNumber}`;
  if (!instantFor) return base;
  return `${base}-${instantFor}`.slice(0, 63).replace(/-+$/, "");
}

// --- the ceiling ---------------------------------------------------------------------------

export interface RunningPreview {
  id: string;
  /** The last push, or the last deploy asked for by hand. */
  lastActivityAt: string;
}

/**
 * Which previews to stop so that one more can run: the ones idle the longest,
 * as many as it takes to stay within `max`. The one about to start is not in
 * `running`.
 */
export function previewsToStop(running: readonly RunningPreview[], max: number): string[] {
  const excess = running.length + 1 - Math.max(1, max);
  if (excess <= 0) return [];
  return [...running]
    .sort((a, b) => Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt) || a.id.localeCompare(b.id))
    .slice(0, excess)
    .map((p) => p.id);
}

/** The running previews with no activity for `idleDays` days, stopped by the sweep. */
export function idlePreviews(running: readonly RunningPreview[], now: Date, idleDays: number): string[] {
  const cutoff = now.getTime() - idleDays * 24 * 60 * 60 * 1000;
  return running.filter((p) => {
    const at = Date.parse(p.lastActivityAt);
    return Number.isFinite(at) && at < cutoff;
  }).map((p) => p.id);
}

// --- the poller --------------------------------------------------------------------------------

/**
 * What changed between the previews the panel knows and the pull requests open
 * now: the ones new or with a new head commit, to be handled like `opened`,
 * and the numbers no longer open, to be handled like `closed`.
 */
export function pollChanges(
  known: readonly { prNumber: number; headSha: string }[],
  open: readonly PullRequest[]
): { changed: PullRequest[]; closed: number[] } {
  const byNumber = new Map(known.map((k) => [k.prNumber, k.headSha]));
  const openNumbers = new Set(open.map((pr) => pr.number));
  return {
    changed: open.filter((pr) => byNumber.get(pr.number) !== pr.headSha),
    closed: known.filter((k) => !openNumbers.has(k.prNumber)).map((k) => k.prNumber),
  };
}
