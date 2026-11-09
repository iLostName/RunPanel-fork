/**
 * Joining what several servers answered into one list.
 *
 * Every row of an aggregated list carries the server it lives on, so the page
 * can link to it and act on it there. Servers that did not answer are kept
 * apart, with the reason, so the page can say "or non raggiungibile" instead
 * of silently showing a shorter list.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export interface MemberStatus {
  id: string;
  name: string;
  self: boolean;
  /** The member answered with data. */
  ok: boolean;
  /** The member answered at all (a 403 is reachable but not ok). */
  reachable: boolean;
  error: string | null;
}

export interface OnServer {
  memberId: string;
  memberName: string;
}

export type Located<T> = T & OnServer;

export interface Aggregated<T> {
  items: Located<T>[];
  members: MemberStatus[];
  /** Last known rows of the servers that did not answer, where the route keeps them. Never part of `items`. */
  offline?: Located<T>[];
}

/**
 * Tag each member's rows with the member and concatenate them, this server
 * first, then by server name, keeping each server's own order.
 */
export function mergeByMember<T>(
  parts: Array<{ member: { id: string; name: string; self: boolean }; items: T[] | null | undefined }>
): Located<T>[] {
  const ordered = [...parts].sort((a, b) => (a.member.self !== b.member.self ? (a.member.self ? -1 : 1) : a.member.name.localeCompare(b.member.name)));
  const out: Located<T>[] = [];
  for (const part of ordered) {
    for (const item of part.items ?? []) out.push({ ...item, memberId: part.member.id, memberName: part.member.name });
  }
  return out;
}

/** Members that did not answer with data, for the "non raggiungibile" rows. */
export function failedMembers(members: MemberStatus[]): MemberStatus[] {
  return members.filter((m) => !m.ok);
}

/** Keep the rows of one server, or all of them when `memberId` is null. */
export function onlyMember<T extends OnServer>(items: T[], memberId: string | null): T[] {
  return memberId ? items.filter((i) => i.memberId === memberId) : items;
}

// --- Server summaries -------------------------------------------------------

export interface ServerSummary {
  version: string | null;
  docker: boolean | null;
  metrics: {
    cpu: number;
    memory: { total: number; used: number };
    disk: { total: number; used: number; free: number };
    uptime: number;
  } | null;
  projects: { total: number; running: number };
  services: { total: number; running: number };
  problems: number | null;
  update: { behind: number } | null;
}

export type ServerWarningKind = "unreachable" | "disk-critical" | "disk-low" | "version" | "docker" | "problems" | "update";

export interface ServerWarning {
  kind: ServerWarningKind;
  tone: "danger" | "warn";
  text: string;
}

const GB = 1024 ** 3;

/**
 * What deserves attention on a server, worst first. The disk thresholds are
 * the same as the Telegram disk alert: critical under 2 GB or 3% free, low
 * under 4 GB or 10%.
 */
export function serverWarnings(
  summary: ServerSummary | null,
  opts: { reachable: boolean; panelVersion: string | null }
): ServerWarning[] {
  if (!opts.reachable || !summary) return [{ kind: "unreachable", tone: "danger", text: "Non raggiungibile" }];
  const out: ServerWarning[] = [];

  const disk = summary.metrics?.disk;
  if (disk && disk.total > 0) {
    const share = disk.free / disk.total;
    if (disk.free < 2 * GB || share < 0.03) out.push({ kind: "disk-critical", tone: "danger", text: "Disco quasi pieno" });
    else if (disk.free < 4 * GB || share < 0.1) out.push({ kind: "disk-low", tone: "warn", text: "Disco in esaurimento" });
  }
  if (summary.docker === false) out.push({ kind: "docker", tone: "danger", text: "Docker non risponde" });
  if (opts.panelVersion && summary.version && summary.version !== opts.panelVersion) {
    out.push({ kind: "version", tone: "warn", text: `Versione ${summary.version}` });
  }
  if (summary.problems && summary.problems > 0) {
    out.push({ kind: "problems", tone: "warn", text: `${summary.problems} ${summary.problems === 1 ? "cosa" : "cose"} da sistemare` });
  }
  if (summary.update && summary.update.behind > 0) {
    out.push({ kind: "update", tone: "warn", text: "Aggiornamento disponibile" });
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1));
}

/** One object per server (monitor, diagnostics, updates), with how the server answered. */
export interface PerServer<T> {
  memberId: string;
  memberName: string;
  self: boolean;
  data: T | null;
  error: string | null;
  reachable: boolean;
}

/**
 * What the Overview may say when no check came back bad.
 *
 * "No problems" is a claim about servers that answered. One that did not has
 * not been checked, so the all-clear is only for when every server answered:
 * the banner used to be green with the dead server in brackets. `missing` names
 * what went unchecked, for the panel that lists real problems above it.
 */
export function healthVerdict(
  servers: ReadonlyArray<Pick<PerServer<unknown>, "memberName" | "data" | "reachable">>
): { clean: boolean; text: string; missing: string | null } {
  const silent = servers.filter((s) => !s.data);
  if (silent.length === 0) return { clean: true, text: "Nessun problema rilevato.", missing: null };

  const down = silent.filter((s) => !s.reachable).map((s) => s.memberName);
  const refused = silent.filter((s) => s.reachable).map((s) => s.memberName);
  const parts: string[] = [];
  if (down.length > 0) parts.push(`${down.join(", ")} non raggiungibil${down.length === 1 ? "e" : "i"}`);
  if (refused.length > 0) parts.push(`${refused.join(", ")} senza risposta ai controlli`);
  const missing = parts.join(", ");
  const rest = silent.length < servers.length ? "Sugli altri server nessun problema rilevato." : "Stato non verificato.";
  return { clean: false, text: `${missing}. ${rest}`, missing };
}
