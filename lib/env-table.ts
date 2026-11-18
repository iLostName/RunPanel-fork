/**
 * The Variables tab's rules, without React.
 *
 * The tab edits one list two ways — a table and a `.env` text — and saves it
 * with a PUT that replaces the whole set. Everything that decides what reaches
 * that PUT lives here, where a unit suite can hold it to the server's rules:
 * which rows are sent, which are wrong and why, how a value is written back as
 * text so that reading the text again gives the same value, and what pasting a
 * file over the current list is about to do.
 *
 * The limits are the ones `envVarsSchema` enforces. They are repeated, not
 * imported, because this file is loaded directly by the unit suite and by the
 * browser; the suite checks the two agree.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export interface EnvPair {
  key: string;
  value: string;
}

/** A row of the editor. `id` is the row's identity: names can be edited, repeated or empty. */
export interface EnvRow extends EnvPair {
  id: number;
}

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_KEY = 64;
export const MAX_ENV_VALUE = 65_536;
export const MAX_ENV_VARS = 500;

export const KEY_RULE = "Nome non valido: usa lettere, numeri e _ e non iniziare con un numero";
export const KEY_MISSING = "Manca il nome";
export const KEY_TOO_LONG = `Nome troppo lungo: al massimo ${MAX_ENV_KEY} caratteri`;
export const KEY_REPEATED = "Nome ripetuto: ogni variabile può comparire una volta sola";
export const VALUE_TOO_LONG = "Valore troppo lungo: al massimo 64 KB";

/** What is wrong with one row, by field. */
export interface RowProblem {
  key?: string;
  value?: string;
}

/**
 * The rows the API is sent, and which row each one came from.
 *
 * Names are trimmed — the schema refuses a space, and " FOO" is always a typo.
 * A row with neither name nor value is the empty line "Aggiungi" leaves behind
 * and is dropped; a row with a value and no name is kept, so the problem is
 * reported on it instead of the value vanishing.
 */
export function rowsToPairs(rows: readonly EnvRow[]): { pairs: EnvPair[]; ids: number[] } {
  const pairs: EnvPair[] = [];
  const ids: number[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && row.value === "") continue;
    pairs.push({ key, value: row.value });
    ids.push(row.id);
  }
  return { pairs, ids };
}

/**
 * Every problem the server would refuse, on the row that has it.
 *
 * A repeated name is marked on every copy: which one to keep is the operator's
 * call, and marking only the second would suggest the first is the right one.
 */
export function rowProblems(rows: readonly EnvRow[]): Map<number, RowProblem> {
  const problems = new Map<number, RowProblem>();
  const set = (id: number, field: keyof RowProblem, message: string) => {
    const current = problems.get(id) ?? {};
    if (!current[field]) problems.set(id, { ...current, [field]: message });
  };

  const seen = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) {
      if (row.value !== "") set(row.id, "key", KEY_MISSING);
    } else if (key.length > MAX_ENV_KEY) {
      set(row.id, "key", KEY_TOO_LONG);
    } else if (!ENV_KEY_PATTERN.test(key)) {
      set(row.id, "key", KEY_RULE);
    } else {
      seen.set(key, [...(seen.get(key) ?? []), row.id]);
    }
    if (row.value.length > MAX_ENV_VALUE) set(row.id, "value", VALUE_TOO_LONG);
  }

  for (const ids of seen.values()) {
    if (ids.length > 1) for (const id of ids) set(id, "key", KEY_REPEATED);
  }
  return problems;
}

/** The problem that belongs to no row: only the size of the whole set. */
export function listProblem(pairs: readonly EnvPair[]): string | null {
  return pairs.length > MAX_ENV_VARS ? `Troppe variabili: il massimo è ${MAX_ENV_VARS}` : null;
}

/**
 * A 400 from the variables API, put back on the rows it is about.
 *
 * The issues carry zod paths into the body that was sent (`vars.3.key`), and
 * the body is not the table: blank rows were dropped on the way. `ids` is the
 * row each sent entry came from, as `rowsToPairs` returned it. zod's own
 * messages for a length are English, so those three are rewritten; the rest
 * (the name rule, a repeated name) already arrive in Italian.
 */
export function serverIssuesToRows(
  issues: unknown,
  ids: readonly number[]
): { rows: Map<number, RowProblem>; general: string | null } {
  const rows = new Map<number, RowProblem>();
  let general: string | null = null;
  if (!Array.isArray(issues)) return { rows, general };

  for (const raw of issues) {
    const issue = raw as { path?: unknown; message?: unknown; code?: unknown };
    const path: unknown[] = Array.isArray(issue.path) ? issue.path : [];
    const message = typeof issue.message === "string" ? issue.message : "";
    const [root, index, part] = path;
    const field: keyof RowProblem | null = part === "key" || part === "value" ? part : null;

    if (root === "vars" && typeof index === "number" && field) {
      const id = ids[index];
      // The first issue of a field is the one to read: an empty name also
      // fails the name pattern, and "doesn't match" says less than "missing".
      if (id === undefined || rows.get(id)?.[field]) continue;
      const text =
        field === "value"
          ? VALUE_TOO_LONG
          : issue.code === "too_small"
            ? KEY_MISSING
            : issue.code === "too_big"
              ? KEY_TOO_LONG
              : message || KEY_RULE;
      rows.set(id, { ...rows.get(id), [field]: text });
    } else if (!general) {
      general = root === "vars" && issue.code === "too_big" ? `Troppe variabili: il massimo è ${MAX_ENV_VARS}` : message || null;
    }
  }
  return { rows, general };
}

/**
 * How many variables an edit adds, removes or changes.
 *
 * Counted by name against what the server last confirmed, so typing a value
 * and typing it back counts as nothing — which is what "unsaved" means.
 */
export function countChanges(saved: readonly EnvPair[], current: readonly EnvPair[]): number {
  const before = new Map(saved.map((v) => [v.key, v.value]));
  const after = new Map(current.filter((v) => v.key).map((v) => [v.key, v.value]));
  let changes = 0;
  for (const [key, value] of after) if (before.get(key) !== value) changes++;
  for (const key of before.keys()) if (!after.has(key)) changes++;
  // A name typed twice is one entry in the map and two rows on screen, and a
  // value typed before its name is in neither: both are edits all the same.
  const repeated = Math.max(0, current.filter((v) => v.key).length - after.size);
  const unnamed = current.filter((v) => !v.key && v.value !== "").length;
  return changes + repeated + unnamed;
}

/**
 * Whether a value has to be quoted to be read back unchanged.
 *
 * The reader (`lib/dotenv-parse.ts`) trims an unquoted value, ends it at a `#`
 * that follows whitespace, treats a leading quote as the start of a quoted one,
 * and reads one line. Anything that would trip one of those goes in double
 * quotes; everything else is written as typed, so an ordinary file stays
 * ordinary.
 */
export function needsQuotes(value: string): boolean {
  if (value === "") return false;
  if (/^\s|\s$/.test(value)) return true;
  if (/^["'`]/.test(value)) return true;
  if (/[\r\n]/.test(value)) return true;
  return /\s#/.test(value);
}

function quote(value: string): string {
  // Backslashes first, or the ones added for the quotes would be doubled too.
  // Real newlines stay real: a private key written over several lines is how
  // people keep one in a .env, and the reader joins them back. A carriage
  // return would not survive the reader's line split, so it is spelled out.
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/** The list as a `.env` file that `parseDotenv` reads back into the same list. */
export function serializeDotenv(pairs: readonly EnvPair[]): string {
  return pairs
    .filter((pair) => pair.key || pair.value)
    .map((pair) => `${pair.key}=${needsQuotes(pair.value) ? quote(pair.value) : pair.value}`)
    .join("\n");
}

export type PasteMode = "overwrite" | "skip";

export interface PasteSummary {
  /** New names. */
  added: number;
  /** Existing names whose value the paste replaces ("sovrascrivi"). */
  replaced: number;
  /** Existing names the paste gives the same value: nothing changes. */
  same: number;
  /** Existing names with a different value that the paste leaves alone ("salta"). */
  skipped: number;
}

/**
 * What a paste is about to do, counted before it is applied.
 *
 * The same rule as `mergeEnv`: a name repeated in the list counts at its last
 * value, nothing is ever removed, and "skip" only matters for a name whose
 * value differs.
 */
export function pasteSummary(existing: readonly EnvPair[], incoming: readonly EnvPair[], mode: PasteMode): PasteSummary {
  const current = new Map(existing.map((pair) => [pair.key, pair.value]));
  const summary: PasteSummary = { added: 0, replaced: 0, same: 0, skipped: 0 };
  for (const pair of incoming) {
    if (!current.has(pair.key)) {
      summary.added++;
      current.set(pair.key, pair.value);
    } else if (current.get(pair.key) === pair.value) {
      summary.same++;
    } else if (mode === "overwrite") {
      summary.replaced++;
      current.set(pair.key, pair.value);
    } else {
      summary.skipped++;
    }
  }
  return summary;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 aggiunte, 1 sostituita, 2 uguali" — only the parts that are not zero. */
export function pasteSummaryText(summary: PasteSummary): string {
  const parts = [
    summary.added > 0 && counted(summary.added, "aggiunta", "aggiunte"),
    summary.replaced > 0 && counted(summary.replaced, "sostituita", "sostituite"),
    summary.skipped > 0 && counted(summary.skipped, "lasciata com'era", "lasciate com'erano"),
    summary.same > 0 && counted(summary.same, "uguale", "uguali"),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "nessuna variabile";
}

/** The prefix that sends a variable to the build too, if one does. */
export function buildPrefixOf(key: string, prefixes: readonly string[]): string | null {
  const name = key.trim();
  if (!name) return null;
  return prefixes.find((prefix) => prefix && name.startsWith(prefix)) ?? null;
}

/** Rows whose name contains `query`, case-insensitively. An empty query matches all. */
export function filterRows<T extends EnvPair>(rows: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => row.key.toLowerCase().includes(needle));
}
