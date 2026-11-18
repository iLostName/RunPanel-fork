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

export interface DestinationView {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  createdAt: string;
  /** Where an S3 destination writes; null for the local disk. Never the keys. */
  target?: { endpoint: string; region: string; bucket: string; prefix: string | null; pathStyle: boolean } | null;
  /** Where a Telegram destination writes: the chat, never the session or the account. */
  telegram?: { chat: "channel" | "saved"; title: string | null; linked: boolean } | null;
  /** The policies writing here that this account can see. */
  usedBy?: { id: string; name: string }[];
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
      const name = service?.name ?? "servizio rimosso";
      return target.databases?.length ? `${name}: ${target.databases.join(", ")}` : name;
    }
    case "project": {
      const project = catalog?.projects.find((entry) => entry.id === target.id);
      return `${project?.slug ?? "progetto rimosso"} (${includeWords(target.include)})`;
    }
  }
}
