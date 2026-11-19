import type { AccessValue, GateValue } from "@/components/AccessSection";
import type { DeployPhase } from "@/lib/deploy-phases";

/**
 * A command waiting to run once, at a chosen point of the next deploy.
 *
 * `blockedReason` is worked out by the server against the project's CURRENT
 * runtime, so it changes when the runtime does — which is the case it exists
 * to describe: a command pinned to the install boundary on a project that has
 * since become a Docker one.
 */
export interface OneTimeCommand {
  id: string;
  phase: DeployPhase;
  command: string;
  label: string | null;
  continueOnError: boolean;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  commitSha: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  blockedReason: string | null;
}

export interface Project {
  id: string;
  /**
   * What the signed-in account may do here (lib/authz.ts levels). Optional
   * because a few places build a `Project` from the list endpoint.
   */
  permission?: { level: "read" | "operate" | "manage" | null; terminal: boolean };
  name: string;
  slug: string;
  app_name: string | null;
  source_type: string;
  source_url: string | null;
  source_branch: string;
  runtime_type: string;
  status: string;
  port: number | null;
  auto_deploy: number;
  /** Null reads as "webhook". */
  deploy_trigger?: "webhook" | "poll" | null;
  deploy_count: number;
  last_deploy_at: string | null;
  /** The newest deploy, whatever its outcome. */
  last_deployment?: Deployment | null;
  /** When a deploy last worked; null until one has. */
  last_success_at?: string | null;
  webhook_secret: string;
  builder_config: string;
  /**
   * The commit this project is held at, or null when it follows its branch.
   *
   * While it is set, Deploy rebuilds this commit and auto-deploy is suspended.
   */
  pinned_sha: string | null;
  pinned_at: string | null;
  /** The restart schedule — see migration 020. Empty cron = off. */
  restart_cron: string;
  restart_next_at: string | null;
  restart_last_at: string | null;
  restart_last_result: string | null;
  /** JSON — how the volumes are backed up. See `lib/backup-settings.ts`; null = defaults. */
  backup_settings: string | null;
  /** `owner/name` when the source is a GitHub URL, null for a ZIP or another host. */
  repo: string | null;
  /** The bind list, as rows — the server splits the `-v` strings, not the browser. */
  mounts: { source: string; target: string; readOnly: boolean; enabled: boolean }[];
  /** Where the checkout really is, asked of the filesystem rather than the column. */
  repo_location: { declared: string; real: string | null };
  /**
   * Native version folders: whether this server can make them (not on
   * Windows), and the one the app runs from. Optional for the same reason as
   * `permission`.
   */
  releases?: { supported: boolean; current: string | null };
  repo_path: string | null;
  repoMove: {
    phase: string;
    from: string;
    to: string | null;
    error?: string;
    rolledBack?: boolean;
    leftBehind?: string;
  } | null;
  /**
   * The queue only — the history is fetched by the section that shows it.
   * Here rather than behind its own call because the header has to be able to
   * say, before you press Deploy, that this one will not be an ordinary run.
   */
  oneTimeCommands: OneTimeCommand[];
  /** The names nginx serves it on, minus any an apply left out. Optional for the same reason as `permission`. */
  hosts?: { hostname: string; url: string; locked: boolean }[];
  /**
   * Deployed without downtime: the loopback port its live container is
   * published on, which nginx proxies to. Null for every other project.
   */
  live_port?: number | null;
  /** What the settings need to say whether a deploy without downtime can work here. */
  zeroDowntime?: { proxyReady: boolean };
  /** Who may reach the published port, and whether the gate enforcing it is up. */
  access: AccessValue;
  gate: GateValue;
  /**
   * The production project this one is an environment of (migration 053), and
   * which kind. Optional: a server on an older release does not send them.
   */
  environment_of?: string | null;
  environment?: "staging" | "preview" | null;
}

/** One member of a project's family — `GET /api/projects/{id}/environments`. */
export interface EnvironmentBrief {
  id: string;
  name: string;
  slug: string;
  status: string;
  environment: "staging" | "preview" | null;
  branch: string;
  pinnedSha: string | null;
  url: string | null;
  /** The commit of its live deployment, when one worked. */
  liveCommit: string | null;
  createdAt: string;
  /** For a preview: its pull request (migration 054). */
  pr?: { number: number; title: string; author: string; url: string; fork: boolean } | null;
}

export interface Family {
  production: EnvironmentBrief;
  staging: EnvironmentBrief | null;
  previews: EnvironmentBrief[];
}

export type AddressOffer =
  | { kind: "domain"; domainId: string; subdomain: string; hostname: string }
  | { kind: "instant"; label: string; hostname: string };

/** What creating a staging copy would do, for its dialog. */
export interface StagingOffer {
  blocker: string | null;
  branch: string;
  branches: string[] | null;
  address: AddressOffer | null;
  addressNote: string | null;
  databases: { id: string; name: string; envKey: string }[];
}

export interface EnvironmentsResponse {
  kind: "production" | "staging" | "preview";
  family: Family | null;
  offer: StagingOffer | null;
}

/** One pull request and its preview — `GET /api/projects/{id}/previews`. */
export interface PreviewRow {
  id: string;
  prNumber: number;
  title: string;
  author: string;
  url: string;
  headRef: string;
  headSha: string;
  fork: boolean;
  approvedSha: string | null;
  needsApproval: boolean;
  state: "waiting" | "active" | "stopped";
  stoppedReason: "limit" | "idle" | "manual" | null;
  lastActivityAt: string;
  addressProblem: string | null;
  statusProblem: string | null;
  project: { id: string; name: string; status: string; url: string | null; pinnedSha: string | null } | null;
}

export interface PreviewsResponse {
  settings: { enabled: boolean; maxPreviews: number; idleDays: number; domainId: string | null; commitStatus: boolean };
  previews: PreviewRow[];
  usage: { running: number; memoryBytes: number | null; cpuPercent: number | null };
  transport: { ok: boolean; problem: string | null };
  domains: { id: string; name: string }[];
}

/** What "Promuovi in produzione" would deploy — `GET /api/projects/{id}/promote`. */
export interface PromotionPreview {
  staging: { id: string; name: string; branch: string };
  production: {
    id: string;
    name: string;
    branch: string;
    status: string;
    pinnedSha: string | null;
    autoDeploy: boolean;
    rollback: boolean;
    zeroDowntime: boolean;
  } | null;
  commit: { sha: string; message: string | null; author: string | null; date: string | null } | null;
  blocker: string | null;
  variables: { key: string; change: "added" | "changed" | "removed" }[];
}

/** One entry of the branch's timeline, as the version picker renders it. */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

/**
 * Why the list is empty is as much of an answer as the list.
 *
 * `available: false` arrives with a 200 on purpose — `useResource` throws away
 * the body of anything else — so `message` is the sentence to render, already
 * written by the route.
 */
export interface CommitsResponse {
  available: boolean;
  reason?: "no-repo" | "no-token" | "not-found" | "rate-limited";
  message?: string;
  retryAt?: string | null;
  branch: string | null;
  commits: CommitSummary[];
  page: number;
  hasMore: boolean;
}

export interface ProcessInfo {
  running: boolean;
  pid?: number;
  uptime?: number;
  memory?: number;
  cpu?: number;
}

export interface Deployment {
  id: string;
  trigger_type: string;
  commit_sha: string | null;
  commit_message: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
}

export interface EnvVar {
  key: string;
  value: string;
}

export type TabId = "overview" | "deployments" | "logs" | "env" | "files" | "terminal" | "settings";

/** The settings side menu, in order. */
export type SettingsSectionId =
  | "general"
  | "source"
  | "build"
  | "addresses"
  | "network"
  | "resources"
  | "automations"
  | "previews"
  | "backup"
  | "advanced"
  | "permissions"
  | "danger";

