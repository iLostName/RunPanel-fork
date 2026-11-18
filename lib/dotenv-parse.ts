/**
 * A pasted `.env`, read the way people actually write them.
 *
 * The new project wizard and the Variables tab accept the contents of a
 * `.env` file instead of one row at a time. What arrives is whatever the
 * person had in their editor: `export` prefixes from a shell script, quotes
 * around values with spaces, a private key over several lines, comments,
 * Windows line endings. Each of those has to come out as the value the app
 * would have read, or the paste quietly changes the configuration.
 *
 * Follows the dotenv conventions most runtimes share: `#` starts a comment
 * only at the start of a line or after whitespace in an unquoted value; double
 * quotes understand `\n`, `\t`, `\"` and `\\`; single quotes and backticks are
 * literal; quoted values may span lines. A line that is none of these is
 * reported with its number rather than dropped, so a typo is visible.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export interface EnvPair {
  key: string;
  value: string;
}

export interface ParsedEnv {
  /** In file order; for a repeated key, the last value at the first key's position. */
  vars: EnvPair[];
  /** Lines that could not be read, 1-based, with why. */
  invalid: { line: number; text: string; reason: string }[];
  /** Keys that appeared more than once: the last value wins, as in a shell. */
  duplicates: string[];
}

/** Same rule as the variables API (`envVarsSchema`), so nothing parsed here is refused there. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY = 64;
const MAX_VALUE = 65_536;

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function unescapeDouble(raw: string): string {
  return raw.replace(/\\([nrt"\\])/g, (_, ch: string) => ESCAPES[ch]);
}

export function parseDotenv(text: string): ParsedEnv {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const order: string[] = [];
  const values = new Map<string, string>();
  const duplicates = new Set<string>();
  const invalid: ParsedEnv["invalid"] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const body = trimmed.replace(/^export\s+/, "");
    const eq = body.indexOf("=");
    if (eq <= 0) {
      invalid.push({ line: lineNo, text: trimmed, reason: eq === 0 ? "manca il nome prima di =" : "manca il segno =" });
      continue;
    }

    const key = body.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key) || key.length > MAX_KEY) {
      invalid.push({ line: lineNo, text: trimmed, reason: "nome non valido: lettere, numeri e _, senza iniziare con un numero" });
      continue;
    }

    let rest = body.slice(eq + 1).trimStart();
    let value: string;
    const quote = rest[0];

    if (quote === '"' || quote === "'" || quote === "`") {
      // Find the closing quote, possibly on a later line.
      let collected = rest.slice(1);
      let close = findClose(collected, quote);
      let j = i;
      while (close < 0 && j + 1 < lines.length) {
        j++;
        collected += "\n" + lines[j];
        close = findClose(collected, quote);
      }
      if (close < 0) {
        invalid.push({ line: lineNo, text: trimmed, reason: `virgolette ${quote} non chiuse` });
        continue;
      }
      i = j;
      const inner = collected.slice(0, close);
      value = quote === '"' ? unescapeDouble(inner) : inner;
      // Anything after the closing quote may only be a comment.
      rest = collected.slice(close + 1).trim();
      if (rest && !rest.startsWith("#")) {
        invalid.push({ line: lineNo, text: trimmed, reason: "testo dopo le virgolette di chiusura" });
        continue;
      }
    } else {
      // An unquoted value ends at a comment that follows whitespace: `a#b` is a value.
      const comment = rest.search(/\s#/);
      value = (comment >= 0 ? rest.slice(0, comment) : rest).trim();
    }

    if (value.length > MAX_VALUE) {
      invalid.push({ line: lineNo, text: `${key}=…`, reason: "valore troppo lungo" });
      continue;
    }

    if (values.has(key)) duplicates.add(key);
    else order.push(key);
    values.set(key, value);
  }

  return {
    vars: order.map((key) => ({ key, value: values.get(key) ?? "" })),
    invalid,
    duplicates: [...duplicates],
  };
}

/** Index of the closing quote in `text`, honouring backslash escapes inside double quotes. */
function findClose(text: string, quote: string): number {
  for (let i = 0; i < text.length; i++) {
    if (quote === '"' && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export type MergeMode = "overwrite" | "skip";

/**
 * Pasted variables laid over the ones a project already has.
 *
 * "overwrite" replaces values of keys that exist; "skip" keeps them. New keys
 * are appended in pasted order either way, and nothing is ever removed: a
 * paste is an addition, not a replacement of the whole set.
 */
export function mergeEnv(
  existing: readonly EnvPair[],
  incoming: readonly EnvPair[],
  mode: MergeMode
): { vars: EnvPair[]; added: number; replaced: number; kept: number } {
  const vars = existing.map((pair) => ({ ...pair }));
  const index = new Map(vars.map((pair, i) => [pair.key, i]));
  let added = 0;
  let replaced = 0;
  let kept = 0;

  for (const pair of incoming) {
    const at = index.get(pair.key);
    if (at === undefined) {
      index.set(pair.key, vars.length);
      vars.push({ ...pair });
      added++;
    } else if (vars[at].value === pair.value) {
      kept++;
    } else if (mode === "overwrite") {
      vars[at] = { ...pair };
      replaced++;
    } else {
      kept++;
    }
  }

  return { vars, added, replaced, kept };
}
