/**
 * The shape of RunPanel's store, shared by both the SQLite and the Postgres
 * dialect. Kysely checks every query against these types, so a column that is
 * renamed here fails the build at each call site instead of at runtime.
 *
 * Conventions that keep the two dialects identical:
 *  - every primary key is a nanoid `text`, never an auto-increment;
 *  - every timestamp is an ISO-8601 UTC string in a `text` column, generated in
 *    application code (`nowIso()`), never by a database default — `datetime('now')`
 *    and `now()` disagree on both spelling and format;
 *  - booleans are stored as `0 | 1` integers, since SQLite has no boolean type
 *    and `pg` would otherwise hand back real booleans for the same column.
 */

export type ProjectStatus = "stopped" | "running" | "deploying" | "error";
export type DeploymentStatus = "pending" | "building" | "running" | "failed" | "superseded";
export type ServiceStatus = "stopped" | "running" | "error";
export type SourceType = "github" | "upload";
export type RuntimeType = "node" | "static" | "docker" | "compose" | "custom";
export type TriggerType = "manual" | "webhook" | "poll";

/**
 * How a project learns that its branch moved.
 *
 * `webhook` is GitHub telling the panel; `poll` is the panel asking GitHub. The
 * second exists because the first needs an inbound connection, which a panel
 * behind NAT or on a private network does not have.
 */
export type DeployTrigger = "webhook" | "poll";
export type ServiceType = "postgresql" | "mysql" | "redis" | "mongodb";
export type WebhookStatus = "accepted" | "rejected" | "ignored";

/**
 * `queued`  waiting for the next deploy. May carry `error_message` and a
 *           raised `attempts` from a previous critical failure — a failure
 *           does not consume the row.
 * `claimed` a deploy holds it. `started_at is not null` means the process was
 *           actually spawned, which is what crash recovery reads.
 * `done`    ran, exit 0. History.
 * `failed`  ran non-zero AND `continue_on_error`, so consumed anyway. History.
 */
export type OneTimeCommandStatus = "queued" | "claimed" | "done" | "failed";

// Declared where the column semantics live, so the two cannot disagree.
export type { AccessMode } from "../access-columns";
import type { AccessMode } from "../access-columns";
export type { EnvironmentKind } from "../environments";
import type { EnvironmentKind } from "../environments";
import type { TaskRunStatus, TaskRunsIn, TaskTrigger } from "../tasks-rules";
import type { ColumnType } from "kysely";

export type BackupDestinationType = "local" | "telegram" | "s3" | "webdav" | "sftp" | "rclone" | "peer";
export type BackupTrigger = "schedule" | "manual" | "pre-restore";
export type BackupRunStatus = "running" | "success" | "partial" | "failed";
export type BackupArtifactKind =
  | "service-db"
  | "panel-store"
  | "project-config"
  | "project-volume"
  | "project-repo";
export type BackupArtifactStatus = "ok" | "skipped" | "failed";
/** One copy of a run's archive on one destination — see migration 045. */
export type BackupCopyStatus = "pending" | "uploading" | "done" | "failed";
export type RestoreSource = "catalog" | "upload";
export type RestoreStatus = "running" | "success" | "failed";

export interface SettingsTable {
  key: string;
  value: string;
}

export interface ProjectsTable {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: SourceType;
  source_url: string | null;
  source_branch: string;
  runtime_type: RuntimeType;
  /** JSON — see `deployContractSchema` in lib/deploy-contract.ts */
  builder_config: string;
  port: number | null;
  status: ProjectStatus;
  /**
   * A cron expression exactly as typed. Empty = no scheduled restart. See
   * migration 020. Nullable in the type only, so an insert may leave it out:
   * the column defaults to '' and every reader treats NULL the same way.
   */
  restart_cron: string | null;
  /** The next due instant in UTC. Also the scheduler's claim token. */
  restart_next_at: string | null;
  restart_last_at: string | null;
  /** What the last scheduled occurrence did, in the operator's words. */
  restart_last_result: string | null;
  /** Set by the status sweep on a stop nobody asked for; cleared by every start, stop and deploy. */
  crashed_at: string | null;
  /** 0 | 1 */
  auto_deploy: number;
  webhook_secret: string;
  /**
   * The id of this project's webhook on github.com, when the panel registered
   * one. A cache over "list the hooks and find mine" — see migration 009 — so a
   * stale value is expected and every read falls back to the search.
   */
  github_hook_id: string | null;
  /** NULL reads as `'webhook'` — see migration 010 on why it is not backfilled. */
  deploy_trigger: DeployTrigger | null;
  /** Last commit the poller saw on `source_branch`. */
  poll_sha: string | null;
  poll_checked_at: string | null;
  /**
   * The commit this project is held at. NULL means it follows `source_branch`.
   *
   * While it is set every deploy rebuilds this SHA and auto-deploy is suspended
   * — see migration 011. It belongs to a branch, so changing `source_branch`
   * releases it.
   */
  pinned_sha: string | null;
  pinned_at: string | null;
  /**
   * JSON — see `MountJournal`. The bind list itself lives in the deploy
   * contract (`docker.mounts`); this is only the record of one being applied.
   */
  mount_apply: string | null;
  /**
   * Where a native project's checkout was moved to, or NULL for the default.
   * For showing and undoing only — the move leaves a symlink behind, so
   * everything that resolves a path keeps resolving it. See migration 015.
   */
  repo_path: string | null;
  /** JSON — see `RepoMoveJournal`. NULL when no move has ever been asked for. */
  repo_move: string | null;
  /**
   * 0 | 1 — whether this should be running after a reboot.
   *
   * It is the *declared* state, not a mirror of the current one: pressing Stop
   * does not clear it. A row that asks to autostart and is nonetheless stopped
   * is something the panel reports, not something it quietly rewrites.
   *
   * Nullable because SQLite cannot add a NOT NULL column to a populated table;
   * migration 005 backfills every existing row and readers coalesce.
   */
  autostart: number | null;
  /** Lower starts first. Services are ordered before projects regardless. */
  autostart_order: number | null;
  /** Pause after this one comes up, before starting the next. */
  autostart_delay_s: number | null;
  /** 0 | 1 — block the queue until a readiness probe passes. */
  autostart_wait_healthy: number | null;
  /** `'open'` | `'restricted'` — see `ServicesTable.access_mode`. */
  access_mode: AccessMode | null;
  access_allow: string | null;
  access_port: number | null;
  /**
   * The loopback port the live container is published on, for a project
   * deployed without downtime; NULL for every other one, published on `port`.
   * Runtime state the deploys write, not a setting. See migration 052.
   */
  live_port: number | null;
  /** Where the Overview files this project. NULL is the root. See migration 019. */
  folder_id: string | null;
  /**
   * JSON — see `ProjectBackupSettings` in lib/backup-settings.ts. NULL means
   * every default, and is what every project created before migration 021 has.
   */
  backup_settings: string | null;
  /**
   * The production project this one is an environment of, or NULL for an
   * ordinary project. No foreign key: see migration 053.
   */
  environment_of: string | null;
  /** `'staging'` | `'preview'` with `environment_of`, NULL otherwise. */
  environment: EnvironmentKind | null;
  /** JSON — see `PreviewSettings` in lib/previews.ts; NULL means every default (off). Migration 054. */
  preview_settings: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `'waiting'` a fork's commit nobody approved; `'active'`; `'stopped'`;
 * `'closing'` its pull request closed while the preview could not be removed
 * (a deploy held it): the hourly sweep removes it then. See migration 054.
 */
export type PreviewState = "waiting" | "active" | "stopped" | "closing";
export type PreviewStopReason = "limit" | "idle" | "manual";

/** A pull request the panel knows of, and its preview project once there is one. */
export interface ProjectPreviewsTable {
  id: string;
  production_id: string;
  /** NULL while a fork's commit waits to be approved. No foreign key: see migration 054. */
  project_id: string | null;
  pr_number: number;
  title: string;
  author: string;
  url: string;
  head_ref: string;
  head_sha: string;
  head_repo: string | null;
  /** 0 | 1 */
  fork: number;
  approved_sha: string | null;
  state: PreviewState;
  stopped_reason: PreviewStopReason | null;
  last_activity_at: string;
  address_problem: string | null;
  status_problem: string | null;
  created_at: string;
  updated_at: string;
}

/** The variables every preview of a project receives over what it inherits. */
export interface PreviewEnvVarsTable {
  id: string;
  project_id: string;
  key: string;
  /** AES-256-GCM ciphertext */
  value: string;
  created_at: string;
}

/**
 * A grouping on the Overview, and nothing more: it owns no rows, two nullable
 * columns point at it, and deleting one sends its contents back to the root.
 * Flat — there is no parent.
 */
export interface FoldersTable {
  id: string;
  /** Unique ignoring case; compared through `lower(name)` in the routes. */
  name: string;
  created_at: string;
  updated_at: string;
}

export interface DeploymentsTable {
  id: string;
  project_id: string;
  trigger_type: TriggerType;
  commit_sha: string | null;
  commit_message: string | null;
  status: DeploymentStatus;
  /** Build output lives in `data/logs/deployments/<id>.log`, not here. */
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  start_cmd: string | null;
  artifact_dir: string | null;
  /**
   * JSON — the contract this deploy actually ran with, preset and the repo's
   * `runpanel.json` already merged in. NULL for a row written before the
   * column existed; see migration 017 for why the restart needs it.
   */
  resolved_contract: string | null;
}

/**
 * A command an operator wants run exactly once, at a chosen point of the next
 * deploy.
 *
 * A table of its own and NOT a field of the deploy contract, for a reason that
 * is structural rather than tidy: `builder_config` is merged with whatever
 * `runpanel.json` the repository shipped (`resolveContract`), so a contract
 * field would be arbitrary shell on the host that a pushed file could set.
 * `PANEL_ONLY_FIELDS` cannot even express a top-level key — it is a list of
 * parent/child pairs. Out here there is no deny-list to keep in step: nothing
 * merges into this table, and the only writer is an authenticated route.
 */
export interface OneTimeCommandsTable {
  id: string;
  project_id: string;
  /** One of `deployPhases` — see lib/deploy-phases.ts, which owns the list. */
  phase: string;
  /** Newline-separated, joined with `&&` exactly like `commands.release`. */
  command: string;
  /** The operator's name for it. NULL falls back to the first line of `command`. */
  label: string | null;
  /**
   * 0 | 1 — a non-zero exit is recorded and the deploy carries on, and the row
   * is consumed either way. Off, a failure fails the deploy and puts the row
   * back in the queue for the next one.
   */
  continue_on_error: number;
  status: OneTimeCommandStatus;
  /** Order within a phase. Ties broken by `created_at`. */
  position: number;
  /**
   * How many times the command was actually spawned.
   *
   * Written *before* the process starts, so a row that comes back queued after
   * a crash can be told apart from one that never ran.
   */
  attempts: number;
  /**
   * The deploy that last took this row. `set null` rather than the cascade used
   * elsewhere: the 90-day deployment sweep must not erase the record that a
   * command ran.
   */
  deployment_id: string | null;
  /** Denormalised so the history stays readable once the deployment is gone. */
  commit_sha: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface EnvVarsTable {
  id: string;
  project_id: string;
  key: string;
  /** AES-256-GCM ciphertext */
  value: string;
  created_at: string;
}

/** A named set of encrypted variables several projects can receive — migration 051. */
export interface EnvGroupsTable {
  id: string;
  /** How a reference finds it: `${{ shared.<name>.KEY }}`. Unique on this server. */
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnvGroupVarsTable {
  id: string;
  group_id: string;
  key: string;
  /** AES-256-GCM ciphertext */
  value: string;
  created_at: string;
}

/** A group a project receives; a higher `position` wins over a lower one. */
export interface ProjectEnvGroupsTable {
  project_id: string;
  group_id: string;
  position: number;
  created_at: string;
}

export interface ServicesTable {
  id: string;
  /**
   * The technical name, fixed for life: volumes, ownership labels and data
   * cleanup are derived from it. What the panel shows is `display_name`.
   */
  name: string;
  /** What the panel shows; NULL means `name`. See lib/service-name.ts and migration 022. */
  display_name: string | null;
  /** JSON list of names the container still answers to on its network after a rename. */
  network_aliases: string | null;
  type: ServiceType;
  version: string;
  status: ServiceStatus;
  /** The same five columns as `ProjectsTable` — see migration 020. */
  restart_cron: string | null;
  restart_next_at: string | null;
  restart_last_at: string | null;
  restart_last_result: string | null;
  crashed_at: string | null;
  port: number;
  /** AES-256-GCM ciphertext of a JSON credentials object */
  credentials: string;
  /**
   * The Docker container, unique across the panel. A column rather than a value
   * re-derived per call site, because the derivation had a fallback that
   * dropped the project slug and so answered with a DIFFERENT service's
   * container.
   */
  container_name: string;
  /** JSON — holds the attached networks and template-specific fields */
  config: string;
  project_id: string | null;
  /**
   * 0 | 1 — whether this link contributes a connection URL to the project's
   * environment. Explicit, because the previous rule was implicit: inject
   * unless the project happened to define the same key with a truthy value,
   * which no screen could show and no operator could switch off.
   */
  inject_env: number | null;
  /**
   * The variable this link provides. NULL means "derive it from the service
   * type", which is right for the single-database project and wrong the moment
   * there are two of the same type — they would both answer to `DATABASE_URL`.
   */
  env_key: string | null;
  /** 0 | 1 — see `ProjectsTable.autostart`; defaults to on for a database. */
  autostart: number | null;
  autostart_order: number | null;
  autostart_delay_s: number | null;
  autostart_wait_healthy: number | null;
  /**
   * `'open'` — published on every interface, which is what every port did
   * before this column existed — or `'restricted'`, published on loopback with
   * the panel's access gate in front of it.
   */
  access_mode: AccessMode | null;
  /** JSON array of rules the gate admits, e.g. `["192.168.1.0/24"]`. */
  access_allow: string | null;
  /** Where the real listener moved to while restricted. NULL when open. */
  access_port: number | null;
  /**
   * JSON array of `ServiceMount` — the bind mounts this service runs with, on
   * top of the volume its template declares. NULL and `[]` mean the same thing.
   *
   * A **declaration**, not an observation: Docker is the authority on what a
   * container is really mounted with, and anything that has to be sure asks it
   * (`containerMounts()`), treating this column as what the panel intended.
   */
  mounts: string | null;
  /** JSON — see `MountJournal`. NULL when no list has ever been applied. */
  mount_apply: string | null;
  /**
   * Where the Overview files this service when it belongs to no project. A
   * linked service shows under its project, so linking clears this rather than
   * leaving a value nothing reads. See migration 019.
   */
  folder_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The logical databases inside one service.
 *
 * A service is a database server: one Postgres can hold `app`, `staging` and
 * `analytics` at once. The row is what the panel lists and builds a URL for;
 * the engine remains the authority on what exists.
 */
export interface ServiceDatabasesTable {
  id: string;
  service_id: string;
  name: string;
  created_at: string;
}

/**
 * Where a finished archive is sent. Only `local` is implemented; the type is
 * wider because the column has to survive the day a second one exists.
 *
 * `config` is ciphertext from the start even though a local destination has no
 * secret in it — a token stored later must not need a migration to become
 * encrypted, and a column that is sometimes encrypted is a column nobody can
 * reason about.
 */
export interface BackupDestinationsTable {
  id: string;
  name: string;
  type: BackupDestinationType;
  /** AES-256-GCM ciphertext of a JSON config object */
  config: string;
  /** 0 | 1 */
  is_default: number;
  created_at: string;
  updated_at: string;
}

export interface BackupPoliciesTable {
  id: string;
  name: string;
  /** 0 | 1 */
  enabled: number;
  /** A cron expression exactly as typed, aliases included. Empty = manual only. */
  cron: string;
  /** IANA zone. Null falls back to the panel preference, then to UTC — never to the host. */
  timezone: string | null;
  destination_id: string;
  /**
   * JSON — an array of target *selectors*, not ids: `all-services` has to keep
   * meaning "whatever exists when the run starts", which a join table cannot
   * say. The cost is that a deleted project leaves a selector pointing at
   * nothing, so the runner records it as a skipped artifact instead of failing.
   */
  targets: string;
  retention_count: number | null;
  retention_days: number | null;
  retention_bytes: number | null;
  /** 0 | 1 — put `data/.secret` in the archive, making it self-sufficient and dangerous. */
  include_secret_key: number;
  last_run_at: string | null;
  /** The next due instant in UTC. Also the scheduler's claim token. */
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupRunsTable {
  id: string;
  /**
   * `set null`, deliberately against the cascade convention used elsewhere: the
   * archive is a file on disk, and cascading the row away would strand it with
   * nothing left to describe or delete it.
   */
  policy_id: string | null;
  /** Kept so history stays readable once the policy is gone. */
  policy_name: string | null;
  trigger: BackupTrigger;
  status: BackupRunStatus;
  destination_id: string | null;
  /** Relative to `config.backupsDir`, so moving the data directory is not a migration. */
  archive_path: string | null;
  archive_bytes: number | null;
  /** sha256 of the archive itself */
  checksum: string | null;
  /** JSON summary, mirrored into the archive and into a sidecar next to it */
  manifest: string | null;
  error_message: string | null;
  /** 0 | 1 — never collected by retention. Safety dumps taken before a restore are. */
  pinned: number;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string;
  /** The `backup_keys` row that encrypted the archive; null for one in clear (migration 044). */
  encryption_key_id: string | null;
}

/**
 * Where a policy writes, in order: position 0 is the primary, which
 * `backup_policies.destination_id` mirrors (migration 045).
 */
export interface BackupPolicyDestinationsTable {
  id: string;
  policy_id: string;
  destination_id: string;
  position: number;
  /** 0 | 1 — 0 follows the policy's rule; 1 the three columns, all null keeping every copy. */
  own_retention: number;
  retention_count: number | null;
  retention_days: number | null;
  retention_bytes: number | null;
  created_at: string;
}

/**
 * One copy of a run's archive on one destination (migration 045). The run's
 * `destination_id`, `archive_path` and `archive_bytes` mirror the first copy,
 * in order, that holds the archive.
 */
export interface BackupRunCopiesTable {
  id: string;
  run_id: string;
  /** `set null`: a deleted destination leaves the record of where the copy was. */
  destination_id: string | null;
  /** Snapshots, for when the destination is gone. */
  destination_name: string;
  destination_type: string;
  /** The policy's order when the run started; 0 is the primary. */
  position: number;
  status: BackupCopyStatus;
  /** The destination's handle for the file, once it is there. */
  ref: string | null;
  bytes: number | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

/** Every password archives have been encrypted with — see migration 044. */
export interface BackupKeysTable {
  /** Written in clear into each archive's header. */
  id: string;
  /** The password, AES-256-GCM with the panel key (purpose `backup-password`). */
  secret: string;
  created_at: string;
  /** Null for the password new archives use. Rows are never deleted. */
  retired_at: string | null;
}

export interface BackupArtifactsTable {
  id: string;
  run_id: string;
  kind: BackupArtifactKind;
  /** No foreign key on purpose: an artifact has to outlive what it was taken from. */
  ref_id: string | null;
  ref_name: string;
  /** Path of the member inside the archive. */
  entry_path: string;
  bytes: number;
  /** sha256 of the *uncompressed* member */
  checksum: string | null;
  status: BackupArtifactStatus;
  error_message: string | null;
  /** JSON — engine and tool versions, helper image used. Restore checks these. */
  meta: string | null;
  created_at: string;
}

/** The last "Verifica integrità" of a run's archive — see migration 036. */
export interface BackupVerificationsTable {
  run_id: string;
  /** `ok` | `failed` */
  status: string;
  /** The sentence a person reads. */
  message: string;
  /** JSON — the report: which member failed and why. */
  detail: string | null;
  checked_at: string;
}

/**
 * A restore is not a backup run with a direction flag: half the columns would
 * never apply, and the retention sweeper would have to learn to skip them.
 */
export interface RestoreRunsTable {
  id: string;
  run_id: string | null;
  source: RestoreSource;
  archive_path: string | null;
  /** JSON — the artifact-to-target mapping the operator confirmed. */
  targets: string;
  /** The pre-restore backup taken of exactly what was about to be overwritten. */
  safety_run_id: string | null;
  status: RestoreStatus;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string;
}

export interface WebhookDeliveriesTable {
  id: string;
  project_id: string;
  payload_summary: string | null;
  status: WebhookStatus;
  deployment_id: string | null;
  received_at: string;
}

export interface SessionsTable {
  id: string;
  /** SHA-256 of the cookie value. The token itself is never stored. */
  token_hash: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** Whose session it is — see migration 023. Null only for a row that predates it. */
  user_id: string | null;
}

export type ApiTokenAccess = "read" | "full";

/** A token an AI assistant or a script signs in with — see migration 028. */
export interface ApiTokensTable {
  id: string;
  user_id: string;
  name: string;
  /** SHA-256 of the token. The token itself is shown once and never stored. */
  token_hash: string;
  /** The token's last four characters, to tell two apart in a list. */
  hint: string;
  /** `read` refuses every write; `full` is everything the user may do. */
  access: ApiTokenAccess;
  created_at: string;
  last_used_at: string | null;
  /** Null: until revoked. */
  expires_at: string | null;
}

/** Where notifications go — see migration 032 and services/notify/channels.ts. */
export interface NotificationChannelsTable {
  id: string;
  name: string;
  /** `email` | `telegram` | `discord` | `slack` | `ntfy` | `webhook` — lib/notify-channels.ts. */
  kind: string;
  /** 0 | 1 */
  enabled: number;
  /** JSON map of event key → on/off; a key missing from it takes its default. */
  events: string;
  /** `all` | `problems` */
  filter: string;
  /** JSON of the plain settings: chat id, topic, recipients, a hint of the URL. */
  config: string;
  /** Encrypted JSON of the secrets. Never sent to the browser. */
  secrets: string | null;
  last_ok_at: string | null;
  /** The last failure, in words and with every secret taken out. */
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The notification centre — see migration 032 and services/notify/center.ts. */
export interface NotificationsTable {
  id: string;
  event: string;
  /** `ok` | `warn` | `danger` | `info` */
  level: string;
  title: string;
  /** The catalogue's HTML dialect: `<b>`, `<code>`, `<a href>` and three entities. */
  body: string;
  /** Where in the panel it leads. */
  href: string | null;
  /** `project` | `service`, or null for the machine and the panel. */
  scope: string | null;
  scope_id: string | null;
  /** Who sees a notification with no scope: the holders of this panel permission. */
  permission: string | null;
  /** How many more times it happened while it was being held back. */
  repeats: number;
  created_at: string;
  /** The last of those times. */
  last_at: string;
}

export interface NotificationReadsTable {
  notification_id: string;
  user_id: string;
  read_at: string;
}

/** Per user: everything created up to `read_before` counts as read. */
export interface NotificationReadMarksTable {
  user_id: string;
  read_before: string;
}

/** A browser or an installed app that receives its account's notifications — see migration 049. */
export interface PushDevicesTable {
  id: string;
  user_id: string;
  name: string;
  /** SHA-256 of the endpoint, hex. Unique. */
  endpoint_hash: string;
  /** Encrypted JSON `{ endpoint, p256dh, auth }` (purpose `push`). */
  subscription: string;
  /** The panel's VAPID public key the browser subscribed with. */
  vapid_key: string;
  push_host: string;
  origin: string | null;
  user_agent: string | null;
  /** JSON map of event key → on/off, as a channel's. */
  events: string;
  /** `all` | `problems` */
  filter: string;
  /** 0 | 1 */
  enabled: number;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Two-step sign-in of one account, on this panel only — see migration 035. */
export interface UserTwoFactorTable {
  user_id: string;
  /** The base32 TOTP seed, encrypted with the panel key (purpose `totp`). */
  secret_enc: string;
  /** Null while the setup waits for its first code: not enabled yet. */
  enabled_at: string | null;
  /** The last time step a code was accepted for; no code of it or before is accepted again. */
  last_used_step: number | null;
  created_at: string;
}

export interface UserRecoveryCodesTable {
  id: string;
  user_id: string;
  /** `s1$<salt>$<scrypt>` (lib/totp.ts). The code itself is shown once and never stored. */
  code_hash: string;
  used_at: string | null;
  created_at: string;
}

/** A browser that may skip the code until `expires_at`: "ricorda questo dispositivo". */
export interface TrustedDevicesTable {
  id: string;
  user_id: string;
  /** SHA-256 of the cookie value. */
  token_hash: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

/** A sign-in whose first step was right — the password, or GitHub — waiting for the code. */
export interface LoginChallengesTable {
  id: string;
  user_id: string;
  /** SHA-256 of the token the sign-in page holds for the second step. */
  token_hash: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  /** `github` when the first step was GitHub; null for the password (migration 050). */
  via: string | null;
}

/** The GitHub account a user may sign in with, on this panel only — see migration 050. */
export interface UserGithubTable {
  user_id: string;
  /** GitHub's numeric user id, as decimal text: the only thing a sign-in is matched on. */
  github_id: string;
  /** The login as last seen. For showing only: GitHub lets people rename. */
  github_login: string;
  linked_at: string;
  last_used_at: string | null;
}

/** A sign-in with GitHub between leaving for GitHub and coming back (migration 050). */
export interface GithubLoginStatesTable {
  id: string;
  /** SHA-256 of the `state` sent to GitHub. */
  state_hash: string;
  /** SHA-256 of the value in the browser's httpOnly cookie. */
  binding_hash: string;
  /** `login` | `link` | `invite` */
  intent: string;
  /** The signed-in user a link is for. */
  user_id: string | null;
  /** The PKCE verifier and an invitation's token, sealed with the panel key. */
  sealed: string;
  redirect_uri: string;
  next_path: string | null;
  created_at: string;
  expires_at: string;
}

/** An account — see migration 023 and lib/authz.ts. */
export interface UsersTable {
  id: string;
  /** Lower-cased. Null only for an owner migrated from the single password, until they set one. */
  email: string | null;
  /** Null until an invited user picks a password. */
  password_hash: string | null;
  /** 0 | 1 — exactly one row has 1, enforced by a partial unique index. */
  is_owner: number;
  /** 0 | 1 */
  disabled: number;
  created_by: string | null;
  created_at: string;
  last_login_at: string | null;
  /**
   * When the account, its permissions or its grants last changed — the merge
   * key between cluster members (migration 024). Null on rows that predate it:
   * read as `created_at`.
   */
  updated_at: string | null;
}

export interface UserPermissionsTable {
  user_id: string;
  /** A `GlobalPermission` from lib/authz.ts. */
  permission: string;
}

export interface UserGrantsTable {
  id: string;
  user_id: string;
  /** `'all'` | `'folder'` | `'project'` | `'service'` */
  scope: string;
  /** '' for `all` — not NULL, so the unique index can see duplicates. */
  scope_id: string;
  /** `'read'` | `'operate'` | `'manage'` */
  level: string;
  /** 0 | 1 */
  terminal: number;
  created_at: string;
}

export interface UserInvitesTable {
  id: string;
  user_id: string;
  /** SHA-256 of the link token. The token itself is never stored. */
  token_hash: string;
  /** `'invite'` | `'reset'` */
  kind: string;
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AuditLogTable {
  id: string;
  at: string;
  /** Null when the panel acted by itself (scheduler, webhook, poll). */
  user_id: string | null;
  category: string;
  action: string;
  scope: string | null;
  scope_id: string | null;
  /** Names and keys only, never secret values. */
  detail: string | null;
  ip: string | null;
}

export interface RateLimitsTable {
  key: string;
  count: number;
  reset_at: string;
}

/** Another RunPanel install this one is linked with — see migration 024 and services/cluster. */
export interface ClusterMembersTable {
  id: string;
  name: string;
  /** Origin only, no trailing slash: `http://host:3000`. */
  url: string;
  /** `'panel'` serves the UI and manages others; `'node'` is only managed. */
  role: string;
  /** `'unknown'` | `'ok'` | `'unreachable'` — a local observation, never replicated. */
  status: string;
  /** The member's panel version label as last reported. Local, never replicated. */
  version: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  created_at: string;
  /** Merge key between members: the newer row wins. */
  updated_at: string;
}

/** A one-time token that lets a fresh install join this cluster. */
export interface ClusterLinkTokensTable {
  id: string;
  /** SHA-256 of the token. The token itself is never stored. */
  token_hash: string;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/** A user, member or folder deleted here, kept so a stale copy elsewhere cannot resurrect it. */
export interface ClusterTombstonesTable {
  /** `'user'` | `'member'` | `'folder'` */
  kind: string;
  id: string;
  deleted_at: string;
}

/** What this panel last saw of a server, per account: see migration 028. */
export interface ClusterLastSeenTable {
  user_id: string;
  member_id: string;
  /** `'projects'` | `'services'` */
  kind: string;
  /** JSON array of `lastSeenRows`. */
  rows: string;
  updated_at: string;
}

/**
 * A domain this server's nginx serves subdomains of, through a wildcard DNS
 * record. Per server and never replicated: the record points at one machine.
 */
export interface DomainsTable {
  id: string;
  /** Canonical and unique — see `normalizeDomain` in lib/proxy-names.ts. */
  name: string;
  /**
   * 0 | 1 — its zone is on the Cloudflare account the panel holds a token for:
   * certificates through DNS, and the visitor's address from `CF-Connecting-IP`.
   */
  cloudflare: number;
  created_at: string;
  updated_at: string;
}

/**
 * Where the name's certificate stands. Whether nginx serves the name at all is
 * `apply_error`, a separate question with a separate answer.
 *
 * `pending`  no certificate, and none asked for since — or the one it had is gone.
 * `issuing`  certbot is running for it.
 * `active`   a certificate is on disk and nginx serves the name over HTTPS.
 * `error`    the last request failed; `last_error` says why. Still served over
 *            HTTP if the block itself went in.
 */
export type ProjectHostStatus = "pending" | "issuing" | "active" | "error";

export interface ProjectHostsTable {
  id: string;
  project_id: string;
  domain_id: string;
  /** One label, or empty for the domain itself. */
  subdomain: string;
  /** `subdomain.domain` (or the domain alone), stored so uniqueness is one index and nginx needs no join. */
  hostname: string;
  /**
   * 0 | 1 — open to everyone through the name while the project's port stays
   * restricted. 0 makes the name follow the port's allow list.
   */
  public_access: number;
  /** Served at `/.well-known/runpanel-check`, so the panel can tell the name reaches it. */
  check_token: string;
  status: ProjectHostStatus;
  /** Why the last certificate request failed. */
  last_error: string | null;
  /**
   * Why the last nginx apply left this name out — a name another block already
   * serves, a project without a port. Null once an apply served it.
   */
  apply_error: string | null;
  /** The certificate's expiry as last read from disk. */
  cert_expires_at: string | null;
  /** Who nginx lets in through the name, with `auth_hash`. Both null: no password. */
  auth_user: string | null;
  /** SHA-512 crypt of the password — never the password itself. */
  auth_hash: string | null;
  /**
   * The id of another of the project's names this one only redirects to: the
   * `www.` twin of the domain itself, or the reverse. Null: it serves the app.
   * Removing that name removes this one with it.
   */
  redirect_to: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The panel's own name over HTTPS (migration 040). At most one row; the
 * columns shared with `project_hosts` mean the same there and here.
 */
export interface PanelHostsTable {
  id: string;
  /** Canonical, like a project's name — and never one of theirs. */
  hostname: string;
  /** Served at `/.well-known/runpanel-check`, on 80 and on 443. */
  check_token: string;
  status: ProjectHostStatus;
  last_error: string | null;
  apply_error: string | null;
  cert_expires_at: string | null;
  /**
   * What the panel's public address setting held before the owner adopted this
   * name, put back when it is turned off. Null: never adopted. '': it was empty.
   */
  previous_public_url: string | null;
  /** When the owner adopted it as the public address: how long HSTS has been ramping up. */
  adopted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One reading of a host, project or service over time, or the average of
 * several — see migration 033 and `lib/metrics-math.ts`. Uptime checks live
 * here too, under the scope `'uptime'` (migration 034).
 */
export interface MetricSamplesTable {
  /** `'host'` | `'project'` | `'service'` | `'uptime'` */
  scope: string;
  /** The project or service id; `'host'` for the machine itself. */
  subject_id: string;
  /** Bucket width in ms; 0 for a raw sample. */
  tier: number;
  /**
   * Epoch milliseconds, the one non-ISO time in the store. `bigint`, which
   * `pg` returns as a string: read it through `Number()`.
   */
  ts: ColumnType<number | string, number, number>;
  /** How many raw samples this row stands for. */
  n: number;
  /** Percent of the whole host, 0–100. */
  cpu: number | null;
  mem: number | null;
  mem_pct: number | null;
  disk: number | null;
  disk_pct: number | null;
  /** Bytes per second. */
  net_rx: number | null;
  net_tx: number | null;
  /** Uptime only: share of checks that got an answer, 0–1. */
  up: number | null;
  /** Uptime only: milliseconds to the first byte. */
  latency: number | null;
}

/**
 * A command a project runs on a schedule — see migration 041 and
 * `services/tasks/`. Booleans are `0 | 1`, like everywhere else.
 */
export interface ProjectTasksTable {
  id: string;
  project_id: string;
  name: string;
  /** Newline-separated, joined with `&&` like every other command field. */
  command: string;
  /** As typed. '' = only when somebody presses "Esegui ora". */
  cron: string;
  /** NULL follows the panel's zone. */
  timezone: string | null;
  /** 0 | 1 */
  enabled: number;
  timeout_sec: number;
  /** Compose only: the service of the stack it runs in. */
  service: string | null;
  /** Where the command was saved to run; see `runsInFor` in lib/tasks-rules.ts. */
  runs_in: TaskRunsIn;
  /** 0 | 1 — saved by someone with the host permission; see `reviewCode`. */
  host_approved: number;
  /** The next due instant in UTC, and the scheduler's claim token. */
  next_run_at: string | null;
  /** The zone `next_run_at` was computed in. */
  schedule_zone: string | null;
  /** The newest run. No foreign key: runs are pruned. */
  last_run_id: string | null;
  consecutive_failures: number;
  failure_notified_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One occurrence of a task, skipped ones included. */
export interface ProjectTaskRunsTable {
  id: string;
  task_id: string;
  project_id: string;
  trigger: TaskTrigger;
  triggered_by: string | null;
  status: TaskRunStatus;
  /** What ran: a copy, so the history survives an edit of the task. */
  command: string;
  scheduled_for: string | null;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  /** Capped: head and tail, see `OutputCapture`. */
  output: string | null;
  /** Characters printed and not kept. */
  output_dropped: number;
  error: string | null;
  /** Identical skips folded into this row. */
  repeats: number;
}

/** An app that stopped answering its uptime check — see migration 034. */
export interface UptimeIncidentsTable {
  id: string;
  project_id: string;
  started_at: string;
  /** Null while it is still going on. */
  ended_at: string | null;
  /** `timeout` | `refused` | `reset` | `status:<code>` | … — see `lib/uptime-math.ts`. */
  cause: string | null;
  /** `recovered`, or `paused` when the project stopped being checked. */
  resolution: string | null;
}

export interface Database {
  settings: SettingsTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  notification_channels: NotificationChannelsTable;
  notifications: NotificationsTable;
  notification_reads: NotificationReadsTable;
  notification_read_marks: NotificationReadMarksTable;
  push_devices: PushDevicesTable;
  users: UsersTable;
  user_permissions: UserPermissionsTable;
  user_grants: UserGrantsTable;
  user_invites: UserInvitesTable;
  user_two_factor: UserTwoFactorTable;
  user_recovery_codes: UserRecoveryCodesTable;
  trusted_devices: TrustedDevicesTable;
  login_challenges: LoginChallengesTable;
  user_github: UserGithubTable;
  github_login_states: GithubLoginStatesTable;
  audit_log: AuditLogTable;
  rate_limits: RateLimitsTable;
  cluster_members: ClusterMembersTable;
  cluster_link_tokens: ClusterLinkTokensTable;
  cluster_tombstones: ClusterTombstonesTable;
  cluster_last_seen: ClusterLastSeenTable;
  projects: ProjectsTable;
  folders: FoldersTable;
  deployments: DeploymentsTable;
  env_vars: EnvVarsTable;
  env_groups: EnvGroupsTable;
  env_group_vars: EnvGroupVarsTable;
  project_env_groups: ProjectEnvGroupsTable;
  project_previews: ProjectPreviewsTable;
  preview_env_vars: PreviewEnvVarsTable;
  one_time_commands: OneTimeCommandsTable;
  services: ServicesTable;
  service_databases: ServiceDatabasesTable;
  webhook_deliveries: WebhookDeliveriesTable;
  backup_destinations: BackupDestinationsTable;
  backup_policies: BackupPoliciesTable;
  backup_runs: BackupRunsTable;
  backup_artifacts: BackupArtifactsTable;
  restore_runs: RestoreRunsTable;
  backup_verifications: BackupVerificationsTable;
  backup_keys: BackupKeysTable;
  backup_policy_destinations: BackupPolicyDestinationsTable;
  backup_run_copies: BackupRunCopiesTable;
  domains: DomainsTable;
  project_hosts: ProjectHostsTable;
  panel_hosts: PanelHostsTable;
  metric_samples: MetricSamplesTable;
  uptime_incidents: UptimeIncidentsTable;
  project_tasks: ProjectTasksTable;
  project_task_runs: ProjectTaskRunsTable;
}
