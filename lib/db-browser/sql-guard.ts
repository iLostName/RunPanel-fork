/**
 * What the data browser lets someone type into its query box.
 *
 * One read, and nothing else: a single SELECT, WITH, VALUES or TABLE — which
 * the browser wraps with its own LIMIT — or a SHOW, EXPLAIN or, in MySQL,
 * DESCRIBE, which it runs as they are. This is the first of the layers that
 * keep the box read-only, and the one that explains itself: the engine is
 * then asked, separately, to run the statement in a READ ONLY transaction with
 * a time limit (`services/db-browser`), and that is what would hold if this
 * file were wrong. Both have to be right, because the data on the other side
 * is the owner's production data.
 *
 * Statements are told apart with a real lexer, per dialect, rather than a
 * regular expression, because the question "is that semicolon inside a
 * string?" is exactly what an attacker would make hard: `E'\''` is a quote in
 * PostgreSQL and the end of a string in MySQL. The two lexers agree with their
 * engines where it matters — on where a literal, an identifier or a comment
 * ends — and refuse the few constructs where that agreement cannot be
 * promised:
 *
 *  - PostgreSQL: `U&'…'` and `U&"…"`, whose escapes would let a name be spelled
 *    without its letters. The session forces `standard_conforming_strings`, so
 *    a backslash in a plain string is a backslash, as assumed here.
 *  - MySQL: every backslash. Its meaning inside a string depends on the
 *    server's `sql_mode` (NO_BACKSLASH_ESCAPES), which this file cannot see.
 *    Without one, MySQL's strings end in the same place in every mode.
 *    Also `/*! … *\/` and `/*+ … *\/`, which the server executes.
 *
 * Function names are checked on the raw text, strings included, so that no
 * disagreement about quoting can hide one: a few functions do things a
 * read-only transaction does not stop (end other connections, change the
 * session's settings, read files of the server, run SQL given as text).
 *
 * Zero imports: the unit suite loads this file directly, and the query box
 * runs it in the browser to say what is wrong before anything is sent.
 */

export type SqlDialect = "postgresql" | "mysql";

export type GuardResult =
  | {
      ok: true;
      /** The statement, without its final semicolon. */
      sql: string;
      /** `rows`: wrapped by the browser with its LIMIT. `direct`: run as it is. */
      mode: "rows" | "direct";
      keyword: string;
    }
  | { ok: false; reason: string };

export const MAX_QUERY_LENGTH = 20_000;

interface Token {
  kind: "word" | "quoted" | "string" | "number" | "param" | "punct";
  text: string;
  start: number;
}

type Lexed = { tokens: Token[] } | { error: string };

const UNTERMINATED = "Una stringa, un nome tra virgolette o un commento non è chiuso.";

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isIdentStart(c: string | undefined): boolean {
  if (c === undefined) return false;
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c.charCodeAt(0) >= 0x80;
}

function isIdentPart(c: string | undefined): boolean {
  return c !== undefined && (isIdentStart(c) || isDigit(c) || c === "$");
}

/** The index just past a `'…'` whose opening quote is at `from - 1`, or -1. */
function endOfQuoted(sql: string, from: number, quote: string, backslashEscapes: boolean): number {
  let i = from;
  while (i < sql.length) {
    const c = sql[i];
    if (backslashEscapes && c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

const DOLLAR_TAG = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/** PostgreSQL's lexer, as far as where things end is concerned. */
function lexPostgres(sql: string): Lexed {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      // PostgreSQL nests block comments, unlike the standard and MySQL.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return { error: UNTERMINATED };
      continue;
    }
    if ((c === "u" || c === "U") && next === "&" && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      return { error: "Le stringhe e i nomi Unicode U&'…' non sono supportati nel browser: usa la console." };
    }
    // A prefix letter only counts at the start of a token: in `abe'x'` the
    // identifier `abe` has already been read whole by the branch below.
    if ((c === "e" || c === "E") && next === "'") {
      const end = endOfQuoted(sql, i + 2, "'", true);
      if (end < 0) return { error: UNTERMINATED };
      tokens.push({ kind: "string", text: sql.slice(i, end), start: i });
      i = end;
      continue;
    }
    if ("bBxX".includes(c) && next === "'") {
      // Bit and hex strings end at the first quote: no doubling, as in the server.
      const close = sql.indexOf("'", i + 2);
      if (close < 0) return { error: UNTERMINATED };
      tokens.push({ kind: "string", text: sql.slice(i, close + 1), start: i });
      i = close + 1;
      continue;
    }
    if ((c === "n" || c === "N") && next === "'") {
      const end = endOfQuoted(sql, i + 2, "'", false);
      if (end < 0) return { error: UNTERMINATED };
      tokens.push({ kind: "string", text: sql.slice(i, end), start: i });
      i = end;
      continue;
    }
    if (c === "'") {
      const end = endOfQuoted(sql, i + 1, "'", false);
      if (end < 0) return { error: UNTERMINATED };
      tokens.push({ kind: "string", text: sql.slice(i, end), start: i });
      i = end;
      continue;
    }
    if (c === '"') {
      const end = endOfQuoted(sql, i + 1, '"', false);
      if (end < 0) return { error: UNTERMINATED };
      tokens.push({ kind: "quoted", text: sql.slice(i, end), start: i });
      i = end;
      continue;
    }
    if (c === "$") {
      if (isDigit(next)) {
        let j = i + 1;
        while (isDigit(sql[j])) j++;
        tokens.push({ kind: "param", text: sql.slice(i, j), start: i });
        i = j;
        continue;
      }
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 130));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) return { error: UNTERMINATED };
        const end = close + tag[0].length;
        tokens.push({ kind: "string", text: sql.slice(i, end), start: i });
        i = end;
        continue;
      }
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (isIdentPart(sql[j])) j++;
      tokens.push({ kind: "word", text: sql.slice(i, j), start: i });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(next))) {
      let j = i + 1;
      while (j < n && (isDigit(sql[j]) || isIdentStart(sql[j]) || sql[j] === ".")) j++;
      tokens.push({ kind: "number", text: sql.slice(i, j), start: i });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", text: c, start: i });
    i++;
  }
  return { tokens };
}

/** MySQL's, with no backslash anywhere: `guardQuery` refuses those first. */
function lexMysql(sql: string): Lexed {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (isSpace(c)) {
      i++;
      continue;
    }
    // `--` is a comment only when a space or a control character follows:
    // `1--1` is arithmetic in MySQL.
    if (c === "#" || (c === "-" && next === "-" && (i + 2 >= n || sql.charCodeAt(i + 2) <= 0x20))) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const kind = sql[i + 2];
      if (kind === "!" || kind === "+" || (kind === "M" && sql[i + 3] === "!")) {
        return { error: "I commenti eseguibili /*! … */ e gli hint /*+ … */ non sono ammessi nel browser." };
      }
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) return { error: UNTERMINATED };
      i = close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const end = endOfQuoted(sql, i + 1, c, false);
      if (end < 0) return { error: UNTERMINATED };
      tokens.push({ kind: c === "`" ? "quoted" : "string", text: sql.slice(i, end), start: i });
      i = end;
      continue;
    }
    if (isIdentPart(c)) {
      let j = i + 1;
      while (isIdentPart(sql[j])) j++;
      tokens.push({ kind: isDigit(c) ? "number" : "word", text: sql.slice(i, j), start: i });
      i = j;
      continue;
    }
    tokens.push({ kind: "punct", text: c, start: i });
    i++;
  }
  return { tokens };
}

/** Statements the browser wraps in `SELECT … FROM (<query>) LIMIT n`. */
const ROW_KEYWORDS = new Set(["SELECT", "WITH", "VALUES", "TABLE"]);

const DIRECT_KEYWORDS: Record<SqlDialect, ReadonlySet<string>> = {
  postgresql: new Set(["SHOW", "EXPLAIN"]),
  mysql: new Set(["SHOW", "EXPLAIN", "DESCRIBE", "DESC"]),
};

/**
 * Words that can only mean a write inside a statement that starts as a read:
 * a data-modifying CTE (`WITH d AS (DELETE …)`), `EXPLAIN ANALYZE UPDATE`, or
 * MySQL's `WITH … UPDATE`. `INSERT` is not here for MySQL, where it is also a
 * string function and cannot follow a WITH anyway; nor `REPLACE`, for the
 * same reason.
 */
const WRITE_WORDS: Record<SqlDialect, ReadonlySet<string>> = {
  postgresql: new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]),
  mysql: new Set(["UPDATE", "DELETE"]),
};

/** Exact names, lower case. */
const BLOCKED_FUNCTIONS: Record<SqlDialect, ReadonlySet<string>> = {
  postgresql: new Set([
    // the session's settings, statement_timeout and read-only included
    "set_config",
    // other connections and the server itself
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_rotate_logfile_old",
    "pg_promote",
    "pg_start_backup",
    "pg_stop_backup",
    "pg_log_backend_memory_contexts",
    "pg_import_system_collations",
    "pg_extension_config_dump",
    // a message to whoever LISTENs: an app may act on it
    "pg_notify",
    // files of the server
    "pg_read_file",
    "pg_read_binary_file",
    "pg_stat_file",
    "pg_logdir_ls",
    "lo_import",
    "lo_export",
    "lo_unlink",
    "lo_create",
    "lo_creat",
    "lo_from_bytea",
    "lo_put",
    "lo_get",
    "lo_truncate",
    "lo_truncate64",
    "lo_open",
    "lo_close",
    "lo_lseek",
    "lo_lseek64",
    "lo_tell",
    "lo_tell64",
    "loread",
    "lowrite",
    // SQL given as text, which no check here would ever see
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
    "cursor_to_xml",
    "cursor_to_xmlschema",
    "ts_stat",
    "ts_rewrite",
    "crosstab",
    "crosstab2",
    "crosstab3",
    "crosstab4",
  ]),
  mysql: new Set([
    "load_file",
    "get_lock",
    "release_lock",
    "release_all_locks",
    "master_pos_wait",
    "source_pos_wait",
    "wait_for_executed_gtid_set",
    "wait_until_sql_thread_after_gtids",
    "sys_exec",
    "sys_eval",
    "sys_set",
    "sys_get",
  ]),
};

/** Families, by prefix, lower case. */
const BLOCKED_PREFIXES: Record<SqlDialect, readonly string[]> = {
  postgresql: [
    "pg_switch_",
    "pg_create_",
    "pg_drop_",
    "pg_copy_",
    "pg_replication_",
    "pg_logical_",
    "pg_wal_replay_",
    "pg_xlog_replay_",
    "pg_backup_",
    "pg_stat_reset",
    "pg_stat_statements_reset",
    "pg_advisory_",
    "pg_try_advisory_",
    "pg_ls_",
    "pg_file_",
    "pg_signal_",
    "pg_background_",
    // runs SQL on another connection, outside this read-only transaction
    "dblink",
  ],
  mysql: [],
};

/** The first blocked function named anywhere in the text, strings and comments included. */
export function blockedFunction(sql: string, dialect: SqlDialect): string | null {
  const exact = BLOCKED_FUNCTIONS[dialect];
  const prefixes = BLOCKED_PREFIXES[dialect];
  for (const match of sql.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    const name = match[0].toLowerCase();
    if (exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) return name;
  }
  return null;
}

const quoteHint: Record<SqlDialect, string> = {
  postgresql: 'Se è il nome di una colonna, scrivilo tra virgolette doppie: "update".',
  mysql: "Se è il nome di una colonna, scrivilo tra apici inversi: `update`.",
};

function nextWord(tokens: Token[], index: number): string {
  const token = tokens[index + 1];
  return token?.kind === "word" ? token.text.toUpperCase() : "";
}

/** Whether `sql` is one read the browser may run, and how to run it. */
export function guardQuery(input: string, dialect: SqlDialect): GuardResult {
  if (input.length > MAX_QUERY_LENGTH) {
    return { ok: false, reason: `La query è troppo lunga: al massimo ${MAX_QUERY_LENGTH.toLocaleString("it-IT")} caratteri.` };
  }
  if (input.includes("\u0000")) return { ok: false, reason: "La query contiene un carattere non valido." };
  if (dialect === "mysql" && input.includes("\\")) {
    return {
      ok: false,
      reason: "Il carattere \\ non è ammesso nelle query MySQL del browser: per un apice dentro una stringa raddoppialo, come in 'l''altro'.",
    };
  }

  const lexed = dialect === "postgresql" ? lexPostgres(input) : lexMysql(input);
  if ("error" in lexed) return { ok: false, reason: lexed.error };

  let tokens = lexed.tokens;
  let end = input.length;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === "punct" && last.text === ";") {
    end = last.start;
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) return { ok: false, reason: "Scrivi una query." };
  if (tokens.some((t) => t.kind === "punct" && t.text === ";")) {
    return { ok: false, reason: "Una query per volta: il punto e virgola è ammesso solo alla fine." };
  }

  let first = 0;
  while (tokens[first]?.kind === "punct" && tokens[first].text === "(") first++;
  const head = tokens[first];
  const keyword = head?.kind === "word" ? head.text.toUpperCase() : "";
  const direct = DIRECT_KEYWORDS[dialect];
  if (!ROW_KEYWORDS.has(keyword) && (first > 0 || !direct.has(keyword))) {
    const list = dialect === "mysql" ? "SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN o DESCRIBE" : "SELECT, WITH, VALUES, TABLE, SHOW o EXPLAIN";
    return { ok: false, reason: `Il browser esegue solo letture: la query deve iniziare con ${list}. Per il resto usa la console.` };
  }

  const writes = WRITE_WORDS[dialect];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== "word") continue;
    const word = token.text.toUpperCase();
    if (word === "FOR" && ["UPDATE", "SHARE", "NO", "KEY"].includes(nextWord(tokens, index))) {
      return { ok: false, reason: "FOR UPDATE e FOR SHARE bloccano righe che altre connessioni stanno usando: il browser non li esegue." };
    }
    if (dialect === "mysql" && word === "LOCK" && nextWord(tokens, index) === "IN") {
      return { ok: false, reason: "LOCK IN SHARE MODE blocca righe che altre connessioni stanno usando: il browser non lo esegue." };
    }
    if (word === "INTO") {
      return { ok: false, reason: "SELECT … INTO scrive, in una tabella, in un file o in una variabile: il browser è in sola lettura." };
    }
    if (writes.has(word)) {
      return { ok: false, reason: `${word} modifica i dati e il browser è in sola lettura: per scrivere usa la console. ${quoteHint[dialect]}` };
    }
  }

  if (dialect === "mysql" && keyword === "EXPLAIN" && tokens.some((t) => t.kind === "word" && t.text.toUpperCase() === "ANALYZE")) {
    return {
      ok: false,
      reason: "In MySQL EXPLAIN ANALYZE esegue la query fuori dal limite di tempo del browser: usa EXPLAIN senza ANALYZE, oppure la console.",
    };
  }

  const fn = blockedFunction(input, dialect);
  if (fn) {
    return {
      ok: false,
      reason: `${fn} non è ammessa nel browser: agisce oltre la lettura (altre connessioni, impostazioni, file del server o SQL passato come testo). Usa la console.`,
    };
  }

  return {
    ok: true,
    sql: input.slice(0, end).trim(),
    mode: ROW_KEYWORDS.has(keyword) ? "rows" : "direct",
    keyword,
  };
}
