/**
 * The rules of the uptime check: what counts as an answer, when a run of
 * failures becomes an incident, and how the result is said in words.
 *
 * Zero imports, for the unit suite and for the browser: the card on the project
 * page phrases its sentence with the same functions the checker decides with.
 */

/** One request a minute per app: enough to notice a site that is down before its users write in. */
export const UPTIME_INTERVAL_MS = 60_000;

/**
 * Short on purpose. A page that takes longer than this to send its first byte
 * is, for the person waiting on it, not working — and a long timeout would let
 * one hung app hold the whole round.
 */
export const UPTIME_TIMEOUT_MS = 5_000;

/**
 * Two in a row either way. One failed request is a garbage-collection pause, a
 * restart under a restart policy, a deploy swapping containers; two a minute
 * apart are an app that is not answering. The same on the way back, so an app
 * that answers one request in three does not send a recovery every other
 * minute.
 */
export const DOWN_AFTER = 2;
export const UP_AFTER = 2;

// --- One answer ------------------------------------------------------------------------

/**
 * Why a check failed, as a short code stored with the incident and turned into
 * words by `causeLabel`. `status:<code>` for an HTTP answer that counts as a
 * failure.
 */
export type UptimeCause = "timeout" | "refused" | "reset" | "path" | "error" | `status:${number}`;

/**
 * Whether an HTTP status means the app is working.
 *
 * With `expectStatus` set, exactly those. Without it, anything but a server
 * error: a 404 or a 401 on `/` is an app answering — a login wall, a site with
 * no home page — while a 502 is the proxy inside a stack saying the app behind
 * it is gone, and a 500 on every request is a site that is down as far as
 * anyone using it can tell. The deploy check is laxer (any answer will do)
 * because its question is narrower: did the process bind the port.
 */
export function judgeStatus(status: number, expectStatus: readonly number[]): { ok: boolean; cause: UptimeCause | null } {
  const ok = expectStatus.length > 0 ? expectStatus.includes(status) : status < 500;
  return { ok, cause: ok ? null : `status:${status}` };
}

/** What a failed `fetch` was, from the error undici throws. */
export function causeOfError(err: unknown): UptimeCause {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } } | null;
  const name = e?.name ?? "";
  const code = e?.cause?.code ?? e?.code ?? "";
  if (name === "AbortError" || name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return "timeout";
  }
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") return "reset";
  return "error";
}

/** The cause in plain Italian, for the card and for the notification. */
export function causeLabel(cause: string | null | undefined, timeoutMs = UPTIME_TIMEOUT_MS): string {
  if (!cause) return "Motivo sconosciuto";
  if (cause === "timeout") return `Non ha risposto entro ${Math.round(timeoutMs / 1000)} secondi`;
  if (cause === "refused") return "Nessuno risponde sulla porta: l'app è ferma o si sta riavviando";
  if (cause === "reset") return "La connessione si è interrotta prima della risposta";
  if (cause === "path") return "Il percorso del controllo non è valido: correggilo nelle impostazioni";
  const status = /^status:(\d{3})$/.exec(cause);
  if (status) {
    const code = Number(status[1]);
    return code >= 500 ? `Risponde con un errore (HTTP ${code})` : `Risposta diversa da quella attesa (HTTP ${code})`;
  }
  return "La richiesta non è riuscita";
}

// --- From checks to incidents ------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  at: number;
  cause: UptimeCause | null;
}

export interface UptimeState {
  /** Whether an incident is open. */
  down: boolean;
  /** Consecutive results against the current state, and when that run began. */
  streak: number;
  streakStart: number | null;
  /** The cause of the latest failure, which is what an incident is filed under. */
  cause: UptimeCause | null;
}

export function initialUptimeState(down = false): UptimeState {
  return { down, streak: 0, streakStart: null, cause: null };
}

export type UptimeEvent =
  | { kind: "down"; startedAt: number; cause: UptimeCause | null }
  | { kind: "up"; endedAt: number };

/**
 * One check through the rule.
 *
 * The incident starts at the first failure of the run that opened it and ends
 * at the first success of the run that closed it — not at the confirming
 * check — so its duration is what users saw, not what the hysteresis added.
 */
export function stepUptime(state: UptimeState, check: CheckResult): { state: UptimeState; event: UptimeEvent | null } {
  const against = state.down ? check.ok : !check.ok;
  const cause = check.ok ? state.cause : check.cause;

  if (!against) {
    return { state: { down: state.down, streak: 0, streakStart: null, cause }, event: null };
  }

  const streak = state.streak + 1;
  const streakStart = state.streakStart ?? check.at;
  const needed = state.down ? UP_AFTER : DOWN_AFTER;
  if (streak < needed) {
    return { state: { down: state.down, streak, streakStart, cause }, event: null };
  }

  if (state.down) {
    return { state: { down: false, streak: 0, streakStart: null, cause: null }, event: { kind: "up", endedAt: streakStart } };
  }
  return { state: { down: true, streak: 0, streakStart: null, cause }, event: { kind: "down", startedAt: streakStart, cause } };
}

// --- Saying it ---------------------------------------------------------------------------

/** Up over total, or null when nothing was checked. */
export function uptimeRatio(up: number, total: number): number | null {
  if (!(total > 0)) return null;
  return Math.max(0, Math.min(1, up / total));
}

/**
 * "99,98%", truncated rather than rounded: a day with four minutes down is not
 * "100%", which is what rounding 99,996 would print. Exactly 100 only when
 * nothing failed.
 */
export function formatUptimePercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  if (ratio >= 1) return "100%";
  const truncated = Math.floor(ratio * 10_000) / 100;
  return `${truncated.toFixed(2).replace(".", ",")}%`;
}

/** "12 giorni", "1 ora", "meno di un minuto": a duration as a person says it, one unit. */
export function durationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "meno di un minuto";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes === 1 ? "1 minuto" : `${minutes} minuti`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 ora" : `${hours} ore`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 giorno" : `${days} giorni`;
}

/** "4 min", "1 h 12 min", "2 g 3 h": an incident's length, two units at most. */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "meno di 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} g ${hours % 24} h` : `${days} g`;
}

export interface UptimeBucket {
  /** Start of the bucket. */
  ts: number;
  /** Width of the bucket in ms; a raw check counts as one interval. */
  size: number;
  /** Share of checks that passed, 0–1. */
  up: number;
}

/**
 * Since when the app has been answering without a break, walking back from the
 * newest bucket: the end of the last one with a failure, or the start of the
 * first after a stretch with no checks at all (the panel was off, the project
 * stopped — nobody knows what happened then).
 *
 * `atLeast` when the walk reached the oldest data kept: the streak is longer
 * than the panel remembers, and the sentence has to say "da più di".
 */
export function upSince(buckets: readonly UptimeBucket[], now: number, maxGapMs = 20 * 60_000): { at: number; atLeast: boolean } | null {
  const sorted = [...buckets].sort((a, b) => b.ts - a.ts);
  if (sorted.length === 0) return null;
  const newest = sorted[0];
  if (newest.up < 1 || now - (newest.ts + newest.size) > maxGapMs) return null;

  let since = newest.ts;
  let later = newest;
  for (const bucket of sorted.slice(1)) {
    if (later.ts - (bucket.ts + bucket.size) > maxGapMs) return { at: later.ts, atLeast: false };
    if (bucket.up < 1) return { at: bucket.ts + bucket.size, atLeast: false };
    since = bucket.ts;
    later = bucket;
  }
  return { at: since, atLeast: true };
}

/**
 * One value per local day for the last `days` days, oldest first: the share of
 * checks that passed, or null for a day with none. The strip under the uptime
 * figure is drawn from it.
 */
export function dailyRatios(
  buckets: readonly { ts: number; up: number; n: number }[],
  days: number,
  now: number,
  offsetMinutes = 0
): { day: number; ratio: number | null }[] {
  const DAY = 86_400_000;
  const shift = -offsetMinutes * 60_000;
  const today = Math.floor((now + shift) / DAY) * DAY - shift;
  const out = Array.from({ length: days }, (_, i) => ({ day: today - (days - 1 - i) * DAY, up: 0, n: 0 }));
  for (const bucket of buckets) {
    const index = Math.floor((bucket.ts - out[0].day) / DAY);
    if (index < 0 || index >= days) continue;
    out[index].up += bucket.up * bucket.n;
    out[index].n += bucket.n;
  }
  return out.map((d) => ({ day: d.day, ratio: d.n > 0 ? Math.max(0, Math.min(1, d.up / d.n)) : null }));
}
