/**
 * How much of a message a toast shows: see lib/toast.ts.
 *
 * No imports, so the standalone suite can load it directly — the same reason
 * `lib/proxy-names.ts` has none.
 */

export const TOAST_MAX_CHARS = 180;

/** The first line, cut on a word, and whether that left anything out. */
export function summarize(text: string): { short: string; cut: boolean } {
  const whole = text.trim();
  const first = whole.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  let short = first;
  if (first.length > TOAST_MAX_CHARS) {
    const slice = first.slice(0, TOAST_MAX_CHARS);
    const space = slice.lastIndexOf(" ");
    short = `${(space > TOAST_MAX_CHARS * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
  }
  return { short, cut: short !== whole };
}
