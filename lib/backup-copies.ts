/**
 * The rules of a backup's copies: which destinations a policy may list, the
 * order copies are read in, what each one keeps, and how they add up.
 *
 * A policy writes the same archive to an ordered list of destinations — the
 * 3-2-1 rule: losing a disk, a bucket or an account must never lose the
 * backups. The writing and the reading are in services/backup/copies.ts. What
 * is decided here is pure and has no imports, because the server and the
 * browser have to agree on it (the run page says which copy a restore would
 * read), and because the unit suite loads it on its own.
 */

export type CopyStatus = "pending" | "uploading" | "done" | "failed";

/**
 * Destinations per policy. Three is the rule; five leaves room for a copy on
 * the way out while its replacement fills up, and keeps a run's wait — copies
 * are sent one after the other — something a person can still reason about.
 */
export const MAX_COPIES = 5;

// --- What a policy lists ------------------------------------------------------

/** How many archives a destination keeps. Every field null: all of them. */
export interface RetentionRule {
  count: number | null;
  days: number | null;
  bytes: number | null;
}

/** One destination of a policy, in order: the first is the primary. */
export interface PolicyDestination {
  destinationId: string;
  /** Null: the policy's own rule. */
  retention: RetentionRule | null;
}

export function hasLimit(rule: RetentionRule): boolean {
  return Boolean(rule.count || rule.days || rule.bytes);
}

/** What a destination's copies keep: its own rule if it has one, the policy's otherwise. */
export function ruleFor(
  destinationId: string | null,
  list: readonly PolicyDestination[],
  policyRule: RetentionRule
): RetentionRule {
  const entry = destinationId ? list.find((item) => item.destinationId === destinationId) : undefined;
  return entry?.retention ?? policyRule;
}

/** What the list needs to know about each destination it may name. */
export interface DestinationFacts {
  name: string;
  /**
   * Where it writes, as a string two destinations share only when they write
   * to the same place. Null when that cannot be told — a type this check does
   * not know is trusted to be somewhere else.
   */
  location: string | null;
}

export type ListProblem = { error: string; notFound?: boolean };

/**
 * Why a list of destinations cannot be a policy's, or null.
 *
 * Two copies in the same place are refused, not only the same destination
 * twice: two "local disk" rows writing to one folder would hold one file
 * under two names, and deleting either copy would delete both.
 */
export function destinationListProblem(
  ids: readonly string[],
  known: ReadonlyMap<string, DestinationFacts>
): ListProblem | null {
  if (ids.length === 0) return { error: "Scegli almeno una destinazione" };
  if (ids.length > MAX_COPIES) return { error: `Al massimo ${MAX_COPIES} destinazioni per pianificazione` };

  const seen = new Set<string>();
  const places = new Map<string, string>();
  for (const id of ids) {
    const facts = known.get(id);
    if (!facts) return { error: "Destinazione non trovata", notFound: true };
    if (seen.has(id)) return { error: `«${facts.name}» è nella lista due volte` };
    seen.add(id);
    if (!facts.location) continue;
    const other = places.get(facts.location);
    if (other) {
      return {
        error: `«${other}» e «${facts.name}» scrivono nello stesso posto: una seconda copia lì non protegge da niente. Scegli una destinazione che scriva altrove.`,
      };
    }
    places.set(facts.location, facts.name);
  }
  return null;
}

/**
 * A list whose primary is `destinationId`, for a client that only knows one
 * destination per policy: moved to the front if it is listed already, in
 * place of the old primary if not. The other copies stay — a client that
 * never heard of them must not be able to remove them by accident.
 */
export function withPrimary(list: readonly PolicyDestination[], destinationId: string): PolicyDestination[] {
  if (list[0]?.destinationId === destinationId) return [...list];
  const listed = list.find((item) => item.destinationId === destinationId);
  if (listed) return [listed, ...list.filter((item) => item !== listed)];
  return [{ destinationId, retention: null }, ...list.slice(1)];
}

// --- Reading a run's copies --------------------------------------------------------

export interface ReadableCopy {
  status: CopyStatus;
  position: number;
  /** Its destination still exists. */
  configured: boolean;
  /** It keeps its archives on this server's disk: nothing to download. */
  local: boolean;
}

/**
 * The copies a restore, a download or an integrity check tries, in the order
 * it tries them: only those that hold the archive and whose destination still
 * exists; the ones on this server's disk first, since reading them needs no
 * network and no room for a download; then the policy's order.
 */
export function readOrder<T extends ReadableCopy>(copies: readonly T[]): T[] {
  return copies
    .filter((copy) => copy.status === "done" && copy.configured)
    .sort((a, b) => Number(b.local) - Number(a.local) || a.position - b.position);
}

/**
 * The copy a run's own `archive_path` and `destination_id` describe: the first
 * in the policy's order that holds the archive, one whose destination still
 * exists before one whose destination was deleted. Null when none holds it.
 */
export function primaryCopy<T extends { status: CopyStatus; position: number; configured: boolean }>(
  copies: readonly T[]
): T | null {
  const done = copies.filter((copy) => copy.status === "done").sort((a, b) => a.position - b.position);
  return done.find((copy) => copy.configured) ?? done[0] ?? null;
}

export interface CopyCount {
  total: number;
  done: number;
  failed: number;
  /** Waiting or being sent. */
  inFlight: number;
}

export function countCopies(copies: readonly { status: CopyStatus }[]): CopyCount {
  const count: CopyCount = { total: copies.length, done: 0, failed: 0, inFlight: 0 };
  for (const copy of copies) {
    if (copy.status === "done") count.done++;
    else if (copy.status === "failed") count.failed++;
    else count.inFlight++;
  }
  return count;
}

/**
 * What a finished run is, from its items and its copies.
 *
 * A copy that did not arrive does not fail the backup: the archive exists in
 * the others, and the run says so as a warning. Only a run with no copy at all
 * failed — there is nothing to restore from.
 */
export function runOutcome(failedArtifacts: number, copies: CopyCount): "success" | "partial" | "failed" {
  if (copies.done === 0) return "failed";
  return failedArtifacts > 0 ? "partial" : "success";
}

/** "1 copia", "3 copie", "2 copie su 3": the count a list shows. */
export function copiesLabel(count: CopyCount): string {
  if (count.done === count.total) return count.total === 1 ? "1 copia" : `${count.total} copie`;
  return `${count.done} ${count.done === 1 ? "copia" : "copie"} su ${count.total}`;
}

/**
 * Why a copy cannot be sent again now, or null. The archive comes from another
 * copy, so there has to be one that holds it.
 */
export function retryProblem(
  copy: { status: CopyStatus; configured: boolean },
  copies: readonly ReadableCopy[],
  runStatus: string
): string | null {
  if (runStatus === "running") return "Il backup è ancora in corso: aspetta che finisca";
  if (copy.status === "done") return "Questa copia è già al suo posto";
  if (copy.status !== "failed") return "Questa copia è già in corso";
  if (!copy.configured) return "La destinazione di questa copia non esiste più";
  if (readOrder(copies).length === 0) {
    return "Non c'è nessuna copia da cui ripartire: l'archivio non è più da nessuna parte. Fai un nuovo backup.";
  }
  return null;
}

// --- Retention, one destination at a time ---------------------------------------------

export interface KeptCopy {
  id: string;
  destinationId: string | null;
  bytes: number | null;
  /** When its run started: what "newest" and "older than" are measured on. */
  startedAt: string;
}

/**
 * Which copies retention removes.
 *
 * Each destination is counted on its own, by its own rule: a disk that keeps
 * a week and a bucket that keeps a year. The two rules that made the
 * single-destination version safe hold on every destination:
 *
 *  - the newest copy on each one is never removed, whatever the numbers say,
 *    so the newest backup keeps every copy it has;
 *  - the limits apply together.
 *
 * Copies left behind by deleted destinations are counted together, under the
 * policy's rule: removing one forgets the row, the file is out of reach.
 */
export function prunableCopies(
  copies: readonly KeptCopy[],
  rule: (destinationId: string | null) => RetentionRule,
  now: number
): string[] {
  const groups = new Map<string | null, KeptCopy[]>();
  for (const copy of copies) {
    const group = groups.get(copy.destinationId);
    if (group) group.push(copy);
    else groups.set(copy.destinationId, [copy]);
  }

  const doomed: string[] = [];
  for (const [destinationId, group] of groups) {
    const newestFirst = [...group].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    for (const copy of selectDoomed(newestFirst, rule(destinationId), now)) doomed.push(copy.id);
  }
  return doomed;
}

/** Newest first in, oldest first out. The head of the list is untouchable. */
function selectDoomed(newestFirst: KeptCopy[], rule: RetentionRule, now: number): KeptCopy[] {
  if (!hasLimit(rule) || newestFirst.length <= 1) return [];
  const head = newestFirst[0];
  const doomed = new Set<KeptCopy>();

  if (rule.count && rule.count >= 1) {
    for (const copy of newestFirst.slice(rule.count)) doomed.add(copy);
  }

  if (rule.days) {
    const cutoff = now - rule.days * 86_400_000;
    for (const copy of newestFirst.slice(1)) {
      if (Date.parse(copy.startedAt) < cutoff) doomed.add(copy);
    }
  }

  if (rule.bytes) {
    let total = 0;
    for (const copy of newestFirst) {
      total += copy.bytes ?? 0;
      if (total > rule.bytes && copy !== head) doomed.add(copy);
    }
  }

  doomed.delete(head);
  return newestFirst.filter((copy) => doomed.has(copy));
}
