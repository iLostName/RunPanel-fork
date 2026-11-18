/**
 * What went wrong with a remote destination, said the way a person acts on it.
 *
 * The same shape as the S3 adapter's problems (lib/s3-errors.ts): a cause and a
 * fix in plain Italian for the toast and the run, and the server's own words
 * in `detail` for expert mode and the log. The SFTP, WebDAV and rclone drivers
 * each turn their failures into one of these; the runner prints `detail` under
 * the sentence, as it does for S3.
 *
 * Zero imports, so the unit suites load it directly.
 */

export interface DestinationProblem {
  /** Ours (`AUTH`, `HOST_KEY_CHANGED`, `DNS`…), stable enough for expert mode and the log. */
  code: string;
  /** What is wrong, in one plain sentence. */
  cause: string;
  /** What to do about it, in one sentence. */
  fix: string;
  /** The server's or the tool's own words. Never a secret. */
  detail: string | null;
}

export function problemText(problem: DestinationProblem): string {
  return `${problem.cause} ${problem.fix}`.trim();
}

/** An error a remote driver throws: the message is already the Italian text. */
export class DestinationFailure extends Error {
  readonly problem: DestinationProblem;
  constructor(problem: DestinationProblem) {
    super(problemText(problem));
    this.name = "DestinationFailure";
    this.problem = problem;
  }
}

export function problem(code: string, cause: string, fix: string, detail: string | null = null): DestinationProblem {
  return { code, cause, fix, detail };
}

/** One line, at most `max` characters: a server's error page is not a detail. */
export function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Text with every secret in it masked.
 *
 * Tools print what they were given more often than they should: a URL with the
 * password in it, a token in an error body. Whatever reaches `detail` goes
 * through here first, with every secret the destination holds. Short values
 * are left alone — masking every "a" in a message helps nobody.
 */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  const values = secrets
    .filter((value): value is string => typeof value === "string" && value.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join("•••");
  return out;
}

/** What "Verifica" answers when a step fails, with the step said first. */
export function failedCheck(step: string, found: DestinationProblem) {
  return {
    ok: false as const,
    message: `${step}${problemText(found)}`,
    code: found.code,
    detail: found.detail,
  };
}

/** The problem an error carries, or a generic one built from its message. */
export function problemOf(err: unknown, fallback: (message: string) => DestinationProblem): DestinationProblem {
  if (err instanceof DestinationFailure) return err.problem;
  const message = err instanceof Error ? err.message : String(err);
  return fallback(message);
}
