/**
 * The three brakes on a notifier, as state machines with the clock passed in.
 *
 * A monitor that repeats itself gets muted, and a muted monitor is worse than
 * none. So:
 *
 *  1. **Cooldown, per event and subject.** The same thing about the same
 *     project is said once per window; the repeats are counted, and the next
 *     message says how many there were. A crash-looping project is one message
 *     every quarter of an hour, not one every sweep.
 *  2. **Bursts, per channel.** Different things at the same moment — Docker
 *     goes down and twenty services stop with it — are not twenty messages.
 *     The first goes out at once; what follows within the window is held and
 *     sent as one, when the window closes.
 *  3. **A rate cap, per webhook.** A program wants every event separately, so
 *     a webhook is not joined, only capped: a loop somewhere cannot turn the
 *     panel into a load test of somebody's endpoint.
 *
 * Pure: no timers and no `Date.now()` here. `services/notify/deliver.ts` holds
 * the state on `globalThis` and owns the timers; the unit suite drives these
 * with a fake clock. No TypeScript-only syntax either (no parameter
 * properties), since the suite loads the file with Node's type stripping.
 */

// --- 1. Cooldown -----------------------------------------------------------------

export type CooldownVerdict = { send: true; repeats: number; previousAt: number | null } | { send: false };

export class Cooldown {
  readonly windowMs: number;
  readonly maxKeys: number;
  private entries = new Map<string, { at: number; repeats: number }>();

  constructor(windowMs: number, maxKeys = 200) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /**
   * Whether an event with this key goes out now.
   *
   * An empty key is never held back: a deploy, a backup or a scheduled restart
   * is a thing that happened once, and two of them minutes apart are two pieces
   * of news. When one is let through, `repeats` is how many were held back since
   * the previous one, and `previousAt` when that one went out.
   */
  admit(key: string, now: number): CooldownVerdict {
    if (!key) return { send: true, repeats: 0, previousAt: null };

    const entry = this.entries.get(key);
    if (entry && now - entry.at < this.windowMs) {
      entry.repeats++;
      return { send: false };
    }

    this.entries.set(key, { at: now, repeats: 0 });
    // Keyed by subject, so a panel that has seen a hundred projects come and go
    // would otherwise keep a hundred entries for ever.
    if (this.entries.size > this.maxKeys) {
      for (const [candidate, value] of this.entries) {
        if (now - value.at >= this.windowMs) this.entries.delete(candidate);
      }
    }
    return { send: true, repeats: entry?.repeats ?? 0, previousAt: entry?.at ?? null };
  }

  /** For a test, and for nothing else. */
  size(): number {
    return this.entries.size;
  }
}

// --- 2. Bursts ---------------------------------------------------------------------

export interface BurstState<T> {
  /** When the last message left, or null for never. */
  lastSentAt: number | null;
  pending: T[];
  /** Messages beyond `maxPending`, counted rather than kept. */
  dropped: number;
  /** When the held messages are due, or null when nothing is held. */
  flushAt: number | null;
}

export function newBurst<T>(): BurstState<T> {
  return { lastSentAt: null, pending: [], dropped: 0, flushAt: null };
}

/**
 * Offer one message to a channel.
 *
 * `send` is the message to send now, or null when it was held. `scheduleAt` is
 * set only on the offer that started holding, so the caller arms exactly one
 * timer per window.
 */
export function offerBurst<T>(
  state: BurstState<T>,
  item: T,
  now: number,
  windowMs: number,
  maxPending = 20
): { send: T | null; scheduleAt: number | null } {
  const quiet = state.lastSentAt === null || now - state.lastSentAt >= windowMs;
  if (state.flushAt === null && quiet) {
    state.lastSentAt = now;
    return { send: item, scheduleAt: null };
  }

  if (state.pending.length < maxPending) state.pending.push(item);
  else state.dropped++;

  if (state.flushAt !== null) return { send: null, scheduleAt: null };
  state.flushAt = Math.max(now, (state.lastSentAt ?? now) + windowMs);
  return { send: null, scheduleAt: state.flushAt };
}

/** Take what was held, when its time has come. The window starts again from now. */
export function drainBurst<T>(state: BurstState<T>, now: number): { items: T[]; dropped: number } {
  const items = state.pending;
  const dropped = state.dropped;
  state.pending = [];
  state.dropped = 0;
  state.flushAt = null;
  if (items.length > 0 || dropped > 0) state.lastSentAt = now;
  return { items, dropped };
}

// --- 3. Rate cap ---------------------------------------------------------------------

export interface RateState {
  windowStart: number;
  count: number;
  /** Refused since the window opened, reported once it closes. */
  refused: number;
}

export function newRate(now: number): RateState {
  return { windowStart: now, count: 0, refused: 0 };
}

/**
 * Whether one more request fits in the current window. A fixed window, which
 * is coarse and enough: the point is a ceiling, not a smooth rate.
 *
 * `refusedBefore` is how many were refused in the window that just closed, so
 * the caller can say so once rather than once per refusal.
 */
export function allowRate(
  state: RateState,
  now: number,
  max: number,
  windowMs: number
): { allowed: boolean; refusedBefore: number } {
  let refusedBefore = 0;
  if (now - state.windowStart >= windowMs) {
    refusedBefore = state.refused;
    state.windowStart = now;
    state.count = 0;
    state.refused = 0;
  }
  if (state.count < max) {
    state.count++;
    return { allowed: true, refusedBefore };
  }
  state.refused++;
  return { allowed: false, refusedBefore };
}
