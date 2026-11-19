/** The shapes the backup endpoints return, as the pages consume them. */

export type ProjectInclude = "config" | "volumes" | "repo";

export type BackupTarget =
  | { kind: "service"; id: string; databases?: string[] }
  | { kind: "all-services" }
  | { kind: "project"; id: string; include: ProjectInclude[] }
  | { kind: "all-projects"; include: ProjectInclude[] }
  | { kind: "panel" };

export interface PolicyView {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  schedule: string;
  timezone: string | null;
  destinationId: string;
  destinationName: string | null;
  destinationType: string | null;
  targets: BackupTarget[];
  retentionCount: number | null;
  retentionDays: number | null;
  retentionBytes: number | null;
  includeSecretKey: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  /** Every destination, in order; the first is `destinationId`. Absent from a server on an older version. */
  destinations?: PolicyDestinationView[];
}

export interface PolicyDestinationView {
  destinationId: string;
  destinationName: string | null;
  destinationType: string | null;
  /** Null: the policy's own rule. Every field null: keep every copy. */
  retention: { count: number | null; days: number | null; bytes: number | null } | null;
}

/** One copy of a run's archive, on one destination. */
export interface CopyView {
  id: string;
  /** Null once the destination is deleted. */
  destinationId: string | null;
  destinationName: string;
  destinationType: string;
  /** On this server's disk: read first. */
  local: boolean;
  position: number;
  status: "pending" | "uploading" | "done" | "failed";
  ref: string | null;
  bytes: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunView {
  id: string;
  policyId: string | null;
  policyName: string | null;
  trigger: string;
  status: string;
  archiveBytes: number | null;
  checksum: string | null;
  pinned: boolean;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  hasArchive: boolean;
  errorMessage: string | null;
  destinationName?: string | null;
  destinationType?: string | null;
  /** The last "Verifica integrità", if one was ever run. */
  verification?: { status: "ok" | "failed"; checkedAt: string } | null;
  /** Null for an archive in clear; absent from a server on an older version. */
  encryption?: RunEncryption | null;
  /** Every copy of the archive, in the policy's order. Absent from a server on an older version. */
  copies?: CopyView[];
}

/** How an archive is encrypted: with which password (by when it was set), and whether this panel still has it. */
export interface RunEncryption {
  keyCreatedAt: string | null;
  usable: boolean;
}

/** What `GET /api/backups/encryption` answers. */
export interface EncryptionStatus {
  enabled: boolean;
  since: string | null;
  previous: number;
  unreadable: boolean;
}

export interface ArtifactView {
  id: string;
  kind: string;
  refId: string | null;
  refName: string;
  entryPath: string;
  bytes: number;
  checksum: string | null;
  status: string;
  errorMessage: string | null;
  meta: Record<string, unknown> | null;
}

export interface RunDetail extends RunView {
  artifacts: ArtifactView[];
  log: string;
}

export interface S3TargetView {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string | null;
  pathStyle: boolean;
}

export interface SftpTargetView {
  host: string;
  port: number;
  folder: string;
  /** `SHA256:…` of the host key pinned on first use; null until then. */
  hostKeyFingerprint: string | null;
}

export interface WebdavTargetView {
  host: string;
  url: string;
  folder: string;
}

export interface RcloneTargetView {
  provider: string;
  /** "Google Drive", or "rclone («nas», sftp)". */
  service: string;
  folder: string;
}

/** A linked RunPanel server of the cluster: its member id and its name today, or the one it had. */
export interface PeerTargetView {
  memberId: string;
  memberName: string | null;
  /** False once it is no longer a member; null from a server that could not tell. */
  linked: boolean | null;
}

/** One server whose copies this server keeps (`GET /api/backups/hosted`). */
export interface HostedSourceView {
  sourceId: string;
  name: string;
  url: string | null;
  linked: boolean;
  archives: number;
  bytes: number;
  lastReceivedAt: string | null;
  incoming: { count: number; bytes: number };
  /** Null: no limit of its own. 0: new copies refused. */
  quotaBytes: number | null;
}

export interface HostedDiskView {
  freeBytes: number;
  totalBytes: number;
  /** What the disk always keeps free for this server's own work. */
  reserveBytes: number;
}

export interface HostedOverviewView {
  sources: HostedSourceView[];
  disk: HostedDiskView | null;
  folder: string;
}

/** One archive kept for another server (`GET /api/backups/hosted/:memberId/archives`). */
export interface HostedArchiveView {
  ref: string;
  name: string;
  bytes: number;
  createdAt: string;
}

export interface DestinationView {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  createdAt: string;
  /**
   * Where a destination writes, by type; null for the local disk and Telegram.
   * Never the keys, never a user name.
   */
  target?: S3TargetView | SftpTargetView | WebdavTargetView | RcloneTargetView | PeerTargetView | null;
  /** Where a Telegram destination writes: the chat, never the session or the account. */
  telegram?: { chat: "channel" | "saved"; title: string | null; linked: boolean } | null;
  /** A local destination's folder of its own; null for the panel's archive folder. */
  directory?: string | null;
  /** The policies writing here that this account can see; `primary` when it is their first destination. */
  usedBy?: { id: string; name: string; primary?: boolean }[];
  /** All of them, seen or not. */
  usedByCount?: number;
  archives?: number;
  archiveBytes?: number;
}

export interface RunsResponse {
  runs: RunView[];
  overview: {
    lastRun: RunView | null;
    nextRunAt: string | null;
    totalBytes: number;
    runCount: number;
    recent: { ok: number; failed: number };
    policiesEnabled: number;
  };
  activeRunId: string | null;
}

export interface TargetCatalog {
  services: { id: string; name: string; type: string; version: string; databases: string[] }[];
  projects: { id: string; slug: string; name: string; sourceType: string; volumes: string[] }[];
}

/**
 * Where a Telegram destination writes, said for a list: "Telegram · canale
 * «RunPanel · backup di srv1»". Shared by the destinations list and the
 * policy form, which both name a destination by where it puts things.
 */
export function telegramWhere(telegram: DestinationView["telegram"]): string {
  if (!telegram) return "Telegram";
  if (!telegram.linked) return "Telegram · account da collegare";
  return telegram.chat === "channel" ? `Telegram · canale «${telegram.title ?? "senza nome"}»` : "Telegram · Messaggi salvati";
}

/**
 * Where a policy's archives go, as the end of a sentence: "Ogni giorno alle
 * 03:00 · su Backblaze B2". Every local destination is the same folder on this
 * server, whatever it is called, so it is named for what it is.
 */
export function destinationPhrase(type: string | null | undefined, name: string | null | undefined): string {
  if (!name) return "destinazione non più configurata";
  // A server on an older version sends the name without the type: say the name.
  return type === "local" ? "sul disco di questo server" : `su ${name}`;
}

/**
 * Where a policy's copies go, as the end of the same sentence: "sul disco di
 * questo server e su Backblaze", "… e su altre 2 destinazioni". With several
 * local destinations, each is named: "this server's disk" twice says nothing.
 */
export function destinationsPhrase(list: readonly { destinationType: string | null; destinationName: string | null }[]): string {
  if (list.length === 0) return "destinazione non più configurata";
  const locals = list.filter((entry) => entry.destinationType === "local").length;
  const phrase = (entry: (typeof list)[number]) =>
    locals > 1 && entry.destinationType === "local" && entry.destinationName
      ? `su «${entry.destinationName}»`
      : destinationPhrase(entry.destinationType, entry.destinationName);
  if (list.length === 1) return phrase(list[0]);
  if (list.length === 2) return `${phrase(list[0])} e ${phrase(list[1])}`;
  return `${phrase(list[0])} e su altre ${list.length - 1} destinazioni`;
}

/** A policy's destinations, from a server that may predate copies. */
export function policyDestinations(policy: PolicyView): PolicyDestinationView[] {
  return policy.destinations && policy.destinations.length > 0
    ? policy.destinations
    : [{ destinationId: policy.destinationId, destinationName: policy.destinationName, destinationType: policy.destinationType, retention: null }];
}

/** How a copy's state reads as a status badge: the panel's one vocabulary. */
export const COPY_STATUS: Record<CopyView["status"], string> = {
  pending: "pending",
  uploading: "uploading",
  done: "success",
  failed: "failed",
};

const INCLUDE_WORDS: Record<ProjectInclude, string> = {
  config: "configurazione",
  volumes: "dati",
  repo: "codice",
};

/** "configurazione e dati" rather than the wire names "config, volumes". */
function includeWords(include: ProjectInclude[]): string {
  const words = include.map((item) => INCLUDE_WORDS[item] ?? item);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}` : (words[0] ?? "");
}

/** How a target reads in a list, without the editor having to be open. */
export function describeTarget(target: BackupTarget, catalog?: TargetCatalog | null): string {
  switch (target.kind) {
    case "panel":
      return "Store del pannello";
    case "all-services":
      return "Tutti i database";
    case "all-projects":
      return `Tutti i progetti (${includeWords(target.include)})`;
    case "service": {
      const service = catalog?.services.find((entry) => entry.id === target.id);
      const name = service?.name ?? "database rimosso";
      return target.databases?.length ? `${name}: ${target.databases.join(", ")}` : name;
    }
    case "project": {
      const project = catalog?.projects.find((entry) => entry.id === target.id);
      return `${project?.slug ?? "progetto rimosso"} (${includeWords(target.include)})`;
    }
  }
}
