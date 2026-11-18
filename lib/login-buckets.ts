/**
 * Which login limits a success may reset. Zero imports: the unit suite loads
 * this file directly.
 *
 * Forgiving typos is what a reset is for, and that is a matter between one
 * address or one account and the panel. The global ceiling counts everyone's
 * attempts: if a success cleared it, anyone with a working account could sign
 * in between batches of guesses at other accounts and never reach it. A success
 * only gives back its own attempt; failures expire with the window.
 */
export const LOGIN_GLOBAL_KEY = "login:global";

export function bucketsResetByLogin<T extends { key: string }>(buckets: T[]): T[] {
  return buckets.filter((bucket) => bucket.key !== LOGIN_GLOBAL_KEY);
}
