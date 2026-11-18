import { createReporter } from "../harness.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The data browser of the database page, without an engine.
 *
 * It reads the owner's production data, so the two things worth proving are
 * that what it sends cannot write and that what comes back is read exactly:
 * the query guard against everything a person or an attacker could type, the
 * builders against names that try to break out of their quotes, and each
 * client's output format against the values that break naive parsers — NULL
 * next to the string "NULL", tabs, newlines, quotes, emoji, bytes that are
 * not text. The engines themselves need Docker; what can be checked from the
 * source is checked from the source.
 *
 * Standalone: everything under lib/db-browser has no imports.
 */
export const meta = { name: "db-browser-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("db-browser-unit");
  const load = (file) => import(pathToFileURL(join(repoRoot, "lib", "db-browser", file)).href);
  const read = (...parts) => readFileSync(join(repoRoot, ...parts), "utf8");

  const { guardQuery, blockedFunction, MAX_QUERY_LENGTH } = await load("sql-guard.ts");
  const out = await load("output.ts");
  const build = await load("sql-build.ts");
  const redis = await load("redis-wire.ts");
  const mongo = await load("mongo-wire.ts");

  const pg = (sql) => guardQuery(sql, "postgresql");
  const my = (sql) => guardQuery(sql, "mysql");
  const accepts = (label, result, mode) => r.check(label, result.ok === true && (!mode || result.mode === mode), JSON.stringify(result));
  const refuses = (label, result, fragment) =>
    r.check(label, result.ok === false && (!fragment || result.reason.includes(fragment)), JSON.stringify(result));

  // --- the guard: what a read looks like ---------------------------------------
  {
    accepts("pg: a plain select", pg("SELECT 1"), "rows");
    accepts("pg: lower case, a limit and a final semicolon", pg("select * from users limit 10;"), "rows");
    r.check("pg: the final semicolon is dropped", pg("SELECT 1;").sql === "SELECT 1");
    r.check("pg: and a comment after it", pg("SELECT 1; -- fatto").sql === "SELECT 1");
    accepts("pg: a CTE", pg("  WITH x AS (SELECT 1) SELECT * FROM x"), "rows");
    accepts("pg: a parenthesised union", pg("(SELECT 1) UNION (SELECT 2)"), "rows");
    accepts("pg: VALUES", pg("VALUES (1, 'a')"), "rows");
    accepts("pg: TABLE", pg("TABLE users"), "rows");
    accepts("pg: SHOW runs as it is", pg("SHOW search_path"), "direct");
    accepts("pg: EXPLAIN ANALYZE of a select", pg("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t"), "direct");
    accepts("pg: a leading comment", pg("/* ciao */ SELECT 1"), "rows");
    accepts("pg: tabs and newlines", pg("\tSELECT\n1"), "rows");
    accepts("pg: mixed case", pg("sElEcT 1"), "rows");
    accepts("pg: a semicolon inside a string", pg("SELECT 'a;b' AS x"));
    accepts("pg: inside a dollar quote", pg("SELECT $$;$$"));
    accepts("pg: inside a tagged dollar quote", pg("SELECT $tag$ it's ; $tag$"));
    accepts("pg: inside an E-string after an escaped quote", pg("SELECT E'\\';'"));
    accepts("pg: inside a quoted identifier", pg('SELECT "weird;name" FROM t'));
    accepts("pg: inside nested comments", pg("SELECT 1 /* ; outer /* ; inner */ ; */"));
    accepts("pg: a doubled apostrophe", pg("SELECT 'it''s'"));
    accepts("pg: $ inside an identifier is not a dollar quote", pg("SELECT a$b$ FROM t"));
    accepts("pg: a word that only starts like a write", pg("SELECT update_at, created FROM t"));
    accepts("pg: a quoted column named like a keyword", pg('SELECT "update", "into" FROM t'));
    accepts("pg: FOR in substring() is not a lock", pg("SELECT substring(x FROM 1 FOR 3) FROM t"));
    accepts("pg: a write inside a string is just text", pg("SELECT * FROM t WHERE note = 'DELETE FROM users; DROP TABLE x'"));
    accepts("pg: and inside a comment", pg("SELECT 1 -- DROP TABLE x; DELETE FROM y"));
    accepts("pg: bit and hex strings", pg("SELECT B'1010', X'1F'"));
    accepts("pg: pg_sleep is bounded by the timeout", pg("SELECT pg_sleep(1)"));
  }

  // --- the guard: what is refused ------------------------------------------------
  {
    refuses("pg: nothing", pg(""), "Scrivi");
    refuses("pg: only a semicolon", pg("   ;"), "Scrivi");
    refuses("pg: only a comment", pg("-- solo un commento"), "Scrivi");
    refuses("pg: two statements", pg("SELECT 1; DROP TABLE users"), "Una query per volta");
    refuses("pg: two semicolons", pg("SELECT 1;;"), "Una query per volta");
    refuses("pg: a statement after a block comment", pg("SELECT 1 /* */ ; DROP TABLE t"), "Una query per volta");
    refuses("pg: a statement after a line comment", pg("SELECT 1 --\n; DROP TABLE t"), "Una query per volta");
    refuses("pg: an E-string that ends early hides nothing", pg("SELECT E'\\\\'; DROP TABLE x; --'"), "Una query per volta");
    refuses("pg: a backslash does not escape in a plain string", pg("SELECT 'a\\'; DROP TABLE x; --'"), "Una query per volta");
    refuses("pg: a dollar quote closed before the semicolon", pg("SELECT $a$ x $a$; DROP TABLE t"), "Una query per volta");
    refuses("pg: an identifier with $ then a statement", pg("SELECT a$b$; DROP TABLE t"), "Una query per volta");
    refuses("pg: whose $b$ is no dollar quote to hide it in", pg("SELECT a$b$; DROP TABLE t; $b$"));
    refuses("pg: DROP", pg("DROP TABLE users"), "solo letture");
    refuses("pg: delete", pg("delete from users"), "solo letture");
    refuses("pg: INSERT", pg("INSERT INTO t VALUES (1)"), "solo letture");
    refuses("pg: COPY to a file", pg("COPY t TO '/tmp/x'"), "solo letture");
    refuses("pg: COPY to a program", pg("COPY (SELECT 1) TO PROGRAM 'rm -rf /'"), "solo letture");
    refuses("pg: a parenthesised write", pg("(DELETE FROM t)"), "solo letture");
    refuses("pg: a parenthesised SHOW", pg("(SHOW search_path)"), "solo letture");
    refuses("pg: SET", pg("SET statement_timeout = 0"), "solo letture");
    refuses("pg: BEGIN", pg("BEGIN"), "solo letture");
    refuses("pg: DO", pg("DO $$ BEGIN DELETE FROM t; END $$"), "solo letture");
    refuses("pg: a data-modifying CTE (DELETE)", pg("WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d"), "DELETE");
    refuses("pg: a data-modifying CTE (UPDATE)", pg("WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT 1"), "UPDATE");
    refuses("pg: a data-modifying CTE (INSERT)", pg("WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT 1"), "INSERT");
    refuses("pg: a data-modifying CTE (MERGE)", pg("with m as (merge into t using s on true when matched then delete) select 1"), "MERGE");
    refuses("pg: EXPLAIN ANALYZE of a write", pg("EXPLAIN ANALYZE DELETE FROM users"), "DELETE");
    refuses("pg: SELECT INTO creates a table", pg("SELECT * INTO copia FROM users"), "INTO");
    refuses("pg: FOR UPDATE", pg("SELECT * FROM t FOR UPDATE"), "FOR UPDATE");
    refuses("pg: for share", pg("select * from t for share"), "FOR UPDATE");
    refuses("pg: FOR NO KEY UPDATE", pg("SELECT * FROM t FOR NO KEY UPDATE"), "FOR UPDATE");
    refuses("pg: FOR KEY SHARE", pg("SELECT * FROM t FOR KEY SHARE"), "FOR UPDATE");
    refuses("pg: a bare write word suggests quoting", pg("SELECT update FROM t"), '"update"');
    refuses("pg: ending other connections", pg("SELECT pg_terminate_backend(pid) FROM pg_stat_activity"), "pg_terminate_backend");
    refuses("pg: schema-qualified", pg("SELECT pg_catalog.pg_terminate_backend(1)"), "pg_terminate_backend");
    refuses("pg: quoted", pg('SELECT "pg_terminate_backend"(1)'), "pg_terminate_backend");
    refuses("pg: in capitals", pg("SELECT PG_TERMINATE_BACKEND(1)"), "pg_terminate_backend");
    refuses("pg: with a comment before the parenthesis", pg("SELECT pg_cancel_backend/**/(1)"), "pg_cancel_backend");
    refuses("pg: changing the session's settings", pg("SELECT set_config('statement_timeout', '0', false)"), "set_config");
    refuses("pg: dblink", pg("SELECT * FROM dblink('dbname=x', 'DROP TABLE t') AS t(a int)"), "dblink");
    refuses("pg: dblink_exec", pg("SELECT dblink_exec('DROP TABLE t')"), "dblink_exec");
    refuses("pg: SQL passed as text", pg("SELECT query_to_xml('DELETE FROM t', true, true, '')"), "query_to_xml");
    refuses("pg: SQL passed as text, built at run time", pg("SELECT query_to_xml('DEL' || 'ETE FROM t', true, true, '')"), "query_to_xml");
    refuses("pg: writing a file", pg("SELECT lo_export(1, '/tmp/x')"), "lo_export");
    refuses("pg: reading a file of the server", pg("SELECT pg_read_file('/etc/passwd')"), "pg_read_file");
    refuses("pg: listing a directory", pg("SELECT pg_ls_dir('.')"), "pg_ls_dir");
    refuses("pg: resetting statistics", pg("SELECT pg_stat_reset()"), "pg_stat_reset");
    refuses("pg: an advisory lock", pg("SELECT pg_advisory_lock(1)"), "pg_advisory_lock");
    refuses("pg: a notification", pg("SELECT pg_notify('ch', 'x')"), "pg_notify");
    refuses("pg: reloading the configuration", pg("SELECT pg_reload_conf()"), "pg_reload_conf");
    refuses("pg: switching WAL", pg("SELECT pg_switch_wal()"), "pg_switch_wal");
    refuses("pg: a restore point", pg("SELECT pg_create_restore_point('x')"), "pg_create_restore_point");
    refuses("pg: a WAL message", pg("SELECT pg_logical_emit_message(true, 'x', 'y')"), "pg_logical_emit_message");
    refuses("pg: a function named inside a string is refused too", pg("SELECT 'pg_terminate_backend'"), "pg_terminate_backend");
    refuses("pg: Unicode strings", pg("SELECT U&'\\0041'"), "U&");
    refuses("pg: Unicode identifiers", pg('SELECT U&"d\\0061t"'), "U&");
    refuses("pg: an unterminated string", pg("SELECT 'aperta"), "non è chiuso");
    refuses("pg: an unterminated dollar quote", pg("SELECT $$aperta"), "non è chiuso");
    refuses("pg: an unterminated comment", pg("SELECT /* aperto"), "non è chiuso");
    refuses("pg: a nested comment closed only once", pg("SELECT /* a /* b */ ancora aperto"), "non è chiuso");
    refuses("pg: an unterminated identifier", pg('SELECT "aperto'), "non è chiuso");
    refuses("pg: a NUL", pg("SELECT 1\u0000"), "non valido");
    refuses("pg: too long", pg(`SELECT '${"x".repeat(MAX_QUERY_LENGTH)}'`), "troppo lunga");
  }

  // --- the guard: MySQL ----------------------------------------------------------
  {
    accepts("my: a plain select", my("SELECT 1"), "rows");
    accepts("my: backticks and a final semicolon", my("select * from `users` limit 5;"), "rows");
    accepts("my: SHOW", my("SHOW TABLES"), "direct");
    accepts("my: DESCRIBE", my("DESCRIBE users"), "direct");
    accepts("my: DESC", my("DESC users"), "direct");
    accepts("my: EXPLAIN", my("EXPLAIN SELECT 1"), "direct");
    accepts("my: a semicolon in a string", my("SELECT 'a;b'"));
    accepts("my: in a double-quoted string", my('SELECT "x;y"'));
    accepts("my: in a backtick name", my("SELECT `weird;name` FROM t"));
    accepts("my: in a # comment", my("SELECT 1 # commento ; qui"));
    accepts("my: in a -- comment", my("SELECT 1 -- commento ; qui"));
    accepts("my: 1--1 is arithmetic, and has no semicolon", my("SELECT 1--1"));
    accepts("my: INSERT() is a string function", my("SELECT INSERT('abc', 1, 1, 'x')"));
    accepts("my: REPLACE() too", my("SELECT REPLACE('a', 'a', 'b')"));
    accepts("my: a CTE", my("WITH x AS (SELECT 1) SELECT * FROM x"), "rows");
    accepts("my: a doubled apostrophe", my("SELECT 'it''s'"));

    refuses("my: a backslash, whatever sql_mode says", my("SELECT 'it\\'s'"), "\\");
    refuses("my: two statements", my("SELECT 1; DROP TABLE t"), "Una query per volta");
    refuses("my: --; is not a comment", my("SELECT 1 --; DROP TABLE t"), "Una query per volta");
    refuses("my: SHOW twice", my("SHOW TABLES; SHOW DATABASES"), "Una query per volta");
    refuses("my: INTO OUTFILE", my("SELECT * FROM t INTO OUTFILE '/tmp/x'"), "INTO");
    refuses("my: INTO a variable", my("SELECT 1 INTO @a"), "INTO");
    refuses("my: an executable comment", my("SELECT * FROM t WHERE 1 /*! INTO OUTFILE '/tmp/x' */"), "/*!");
    refuses("my: a versioned executable comment", my("SELECT 1 /*!50000 , SLEEP(100) */"), "/*!");
    refuses("my: an optimizer hint", my("SELECT /*+ MAX_EXECUTION_TIME(0) */ 1"), "/*+");
    refuses("my: FOR UPDATE", my("SELECT * FROM t FOR UPDATE"), "FOR UPDATE");
    refuses("my: FOR SHARE", my("SELECT * FROM t FOR SHARE"), "FOR UPDATE");
    refuses("my: LOCK IN SHARE MODE", my("SELECT * FROM t LOCK IN SHARE MODE"), "LOCK IN SHARE MODE");
    refuses("my: WITH … UPDATE", my("WITH x AS (SELECT 1) UPDATE t SET a = 1"), "UPDATE");
    refuses("my: WITH … DELETE", my("WITH x AS (SELECT 1) DELETE FROM t"), "DELETE");
    refuses("my: EXPLAIN ANALYZE runs past the time limit", my("EXPLAIN ANALYZE SELECT 1"), "EXPLAIN ANALYZE");
    refuses("my: reading a file of the server", my("SELECT LOAD_FILE('/etc/passwd')"), "load_file");
    refuses("my: a named lock", my("SELECT GET_LOCK('x', 10)"), "get_lock");
    refuses("my: SET", my("SET @a = 1"), "solo letture");
    refuses("my: DO", my("DO SLEEP(1)"), "solo letture");
    refuses("my: HANDLER", my("HANDLER t OPEN"), "solo letture");
    refuses("my: CALL", my("CALL p()"), "solo letture");
    refuses("my: LOAD DATA", my("LOAD DATA INFILE '/tmp/x' INTO TABLE t"), "solo letture");
    refuses("my: a client command", my("system ls"), "solo letture");
    refuses("my: an unterminated string", my("SELECT 'aperta"), "non è chiuso");
    refuses("my: an unterminated comment", my("SELECT /* aperto"), "non è chiuso");
    refuses("my: an unterminated backtick", my("SELECT `aperto"), "non è chiuso");

    r.check("blockedFunction is per dialect", blockedFunction("SELECT load_file('x')", "postgresql") === null && blockedFunction("SELECT set_config()", "mysql") === null);
    r.check("blockedFunction does not match a longer name", blockedFunction("SELECT my_set_config_value FROM t", "postgresql") === null);
  }

  // --- CSV, as psql writes it ---------------------------------------------------
  {
    const simple = out.parseCsv("a,b\n1,2\n");
    r.check("csv: records and fields", JSON.stringify(simple.records) === JSON.stringify([["a", "b"], ["1", "2"]]) && simple.complete);
    const quoted = out.parseCsv('"x,y","line\none","say ""hi""",,"",é😀\r\n');
    r.check(
      "csv: commas, newlines, doubled quotes, empty fields, CRLF, unicode",
      JSON.stringify(quoted.records) === JSON.stringify([["x,y", "line\none", 'say "hi"', "", "", "é😀"]]),
      JSON.stringify(quoted.records)
    );
    r.check("csv: a field cut inside its quotes is reported", out.parseCsv('"never closed').complete === false);
    r.check("csv: no text, no records", out.parseCsv("").records.length === 0);
    const json = out.parseCsv('"[""a,b"",null,""tab\\tnl\\n""]"\n');
    r.check("csv: a JSON row survives the quoting", JSON.stringify(out.parseTextRow(json.records[0][0])) === JSON.stringify(["a,b", null, "tab\tnl\n"]));
  }

  // --- rows reduced to JSON -----------------------------------------------------
  {
    r.check("row: NULL stays apart from the word NULL", JSON.stringify(out.parseTextRow('["NULL",null,""]')) === JSON.stringify(["NULL", null, ""]));
    r.check("row: numbers become text, exactly", JSON.stringify(out.parseTextRow("[1, 2.50, true]")) === JSON.stringify(["1", "2.5", "true"]));
    r.check("row: nested values are not a row", out.parseTextRow('[["a"]]') === null && out.parseTextRow('[{"a":1}]') === null);
    r.check("row: not JSON is not a row", out.parseTextRow("nope") === null && out.parseTextRow('{"a":1}') === null);
  }

  // --- mysql --batch ---------------------------------------------------------------
  {
    r.check("batch: escapes are undone", out.unescapeMysqlBatch("a\\tb\\nc\\\\d\\0e\\rf") === "a\tb\nc\\d\u0000e\rf");
    r.check("batch: a value without backslashes is left alone", out.unescapeMysqlBatch("plain") === "plain");
    r.check("batch: a lone trailing backslash is kept", out.unescapeMysqlBatch("x\\") === "x\\");
    const lines = out.mysqlBatchLines('["a\\\\"b"]\r\n["c"]\n\n');
    r.check("batch: lines, CRLF and blank lines", lines.length === 2 && lines[0] === '["a\\"b"]', JSON.stringify(lines));
    r.check("batch: and the JSON inside reads back", JSON.stringify(out.parseTextRow(lines[0])) === JSON.stringify(['a"b']));
  }

  // --- mysql --column-type-info --------------------------------------------------
  {
    const sample = [
      "Field   1:  `id`",
      "Catalog:    `def`",
      "Database:   ``",
      "Table:      `rp_q`",
      "Org_table:  ``",
      "Type:       LONGLONG",
      "Collation:  binary (63)",
      "Length:     20",
      "Max_length: 0",
      "Decimals:   0",
      "Flags:      NOT_NULL NUM",
      "",
      "Field   2:  `na`me`",
      "Catalog:    `def`",
      "Database:   ``",
      "Table:      `rp_q`",
      "Org_table:  ``",
      "Type:       VAR_STRING",
      "Collation:  utf8mb4_0900_ai_ci (255)",
      "Length:     1020",
      "Max_length: 0",
      "Decimals:   0",
      "Flags:      ",
      "",
      "Field   3:  `avatar`",
      "Type:       BLOB",
      "Collation:  binary (63)",
      "Flags:      BLOB BINARY",
      "",
      "Field   4:  `bio`",
      "Type:       BLOB",
      "Collation:  utf8mb4_0900_ai_ci (255)",
      "Flags:      BLOB",
      "",
      "Field   5:  `stato`",
      "Type:       STRING",
      "Collation:  utf8mb4_0900_ai_ci (255)",
      "Flags:      ENUM",
      "",
      "Field   6:  `flags`",
      "Type:       BIT",
      "Collation:  binary (63)",
      "Flags:      UNSIGNED",
      "",
      "",
    ].join("\n");
    const fields = out.parseMysqlFieldTypes(sample);
    r.check("types: every field", fields.length === 6, JSON.stringify(fields));
    r.check("types: a name with a backtick in it", fields[1]?.name === "na`me");
    r.check("types: type and charset", fields[0]?.type === "LONGLONG" && fields[0]?.charsetnr === 63 && fields[1]?.charsetnr === 255);
    r.check(
      "types: how each is read",
      JSON.stringify(fields.map(out.mysqlFieldKind)) === JSON.stringify(["text", "text", "binary", "text", "text", "bit"]),
      JSON.stringify(fields.map(out.mysqlFieldKind))
    );
    r.check(
      "types: the names a person reads",
      JSON.stringify(fields.map(out.mysqlFieldTypeName)) === JSON.stringify(["bigint", "varchar", "blob", "text", "enum", "bit"]),
      JSON.stringify(fields.map(out.mysqlFieldTypeName))
    );
    r.check("types: nothing printed, nothing found", out.parseMysqlFieldTypes("").length === 0);
  }

  // --- mysql --xml ------------------------------------------------------------------
  {
    const xml = [
      '<?xml version="1.0"?>',
      "",
      '<resultset statement="SHOW COLUMNS FROM t WHERE x &lt; 1',
      '" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
      "  <row>",
      '\t<field name="Field">id</field>',
      '\t<field name="Default" xsi:nil="true" />',
      '\t<field name="Extra"></field>',
      '\t<field name="a &quot;b&quot; &amp; c">x &lt;y&gt; &amp; "z"\nriga due\ttab</field>',
      "  </row>",
      "  <row>",
      '\t<field name="Field">NULL</field>',
      '\t<field name="Default">0</field>',
      '\t<field name="Extra">auto_increment</field>',
      '\t<field name="a &quot;b&quot; &amp; c">😀</field>',
      "  </row>",
      "</resultset>",
    ].join("\n");
    const parsed = out.parseMysqlXml(xml);
    r.check("xml: column names, entities decoded", JSON.stringify(parsed.columns) === JSON.stringify(["Field", "Default", "Extra", 'a "b" & c']), JSON.stringify(parsed.columns));
    r.check("xml: NULL from xsi:nil, empty from an empty element", parsed.rows[0][1] === null && parsed.rows[0][2] === "");
    r.check("xml: the word NULL is a string", parsed.rows[1][0] === "NULL");
    r.check("xml: escapes, a newline and a tab in a value", parsed.rows[0][3] === 'x <y> & "z"\nriga due\ttab', JSON.stringify(parsed.rows[0][3]));
    r.check("xml: unicode", parsed.rows[1][3] === "😀");
    const empty = out.parseMysqlXml('<?xml version="1.0"?>\n<resultset statement="SHOW TABLES\n" xmlns:xsi="x">\n</resultset>\n');
    r.check("xml: no rows, no columns", empty.rows.length === 0 && empty.columns.length === 0);
  }

  // --- cutting values -----------------------------------------------------------------
  {
    r.check("cut: a short value is whole", JSON.stringify(out.cutCell("abc", 5)) === JSON.stringify({ value: "abc", cut: false }));
    r.check("cut: the limit itself is whole", out.cutCell("abcde", 5).cut === false);
    r.check("cut: one more is cut", JSON.stringify(out.cutCell("abcdef", 5)) === JSON.stringify({ value: "abcde", cut: true }));
    r.check("cut: NULL is not cut", JSON.stringify(out.cutCell(null, 5)) === JSON.stringify({ value: null, cut: false }));
    const emoji = "😀".repeat(5);
    r.check("cut: emoji count as one character, as the engine counts them", out.cutCell(emoji, 5).cut === false);
    r.check("cut: and are never split in half", out.cutCell("😀".repeat(6), 5).value === emoji);
    r.check("cut: code points", out.codePointLength("a😀é") === 3);
    r.check("cut: hex values by bytes", JSON.stringify(out.cutHexCell("0x0102030405", 2)) === JSON.stringify({ value: "0x0102", cut: true }));
    r.check("cut: a short hex value is whole", out.cutHexCell("0x01", 2).cut === false);
  }

  // --- engine errors --------------------------------------------------------------------
  {
    const pgError = 'ERROR:  syntax error at or near "FORM"\nLINE 2: SELECT * FORM users\n                 ^\nHINT:  Forse intendevi FROM.\n';
    r.check("pg error: the message and its hint, not the wrapper's line", out.cleanPgError(pgError) === 'syntax error at or near "FORM"\nHINT:  Forse intendevi FROM.', out.cleanPgError(pgError));
    const pgConn = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  database "x" does not exist\n';
    r.check("pg error: a connection failure", out.cleanPgError(pgConn).includes('database "x" does not exist'));
    const myError = "mysql: [Warning] Using a password on the command line interface can be insecure.\nERROR 1146 (42S02) at line 8: Table 'app.x' doesn't exist\n";
    r.check("mysql error: code kept, script line dropped", out.cleanMysqlError(myError) === "1146 (42S02): Table 'app.x' doesn't exist", out.cleanMysqlError(myError));
    r.check("explain: a timeout", out.explainEngineError("canceling statement due to statement timeout")?.includes("tempo massimo"));
    r.check("explain: MySQL's timeout", out.explainEngineError("3024 (HY000): Query execution was interrupted, maximum statement execution time exceeded")?.includes("tempo massimo"));
    r.check("explain: a refused write", out.explainEngineError("cannot execute INSERT in a read-only transaction")?.includes("sola lettura"));
    r.check("explain: a lock", out.explainEngineError("canceling statement due to lock timeout")?.includes("bloccata"));
    r.check("explain: Redis auth", out.explainEngineError("WRONGPASS invalid username-password pair")?.includes("credenziali"));
    r.check("explain: nothing to add", out.explainEngineError('relation "x" does not exist') === null);
    const keyspace = out.parseRedisKeyspace("# Keyspace\r\ndb0:keys=12,expires=1,avg_ttl=0\r\ndb3:keys=4,expires=0,avg_ttl=0\r\n");
    r.check("redis INFO keyspace", JSON.stringify(keyspace) === JSON.stringify([{ index: 0, keys: 12, expires: 1 }, { index: 3, keys: 4, expires: 0 }]));
  }

  // --- the SQL the browser builds ------------------------------------------------------
  {
    r.check("pg: identifiers double their quotes", build.pgIdent('a"b') === '"a""b"');
    r.check("pg: literals double their apostrophes", build.pgLiteral("it's") === "'it''s'");
    r.check("a narrow table gets long values", build.cellLimit(1) === 10_000);
    r.check("a wide one shorter ones", build.cellLimit(10) === 3000 && build.cellLimit(1000) === 40);

    const hostile = 'x"; DROP TABLE y; --';
    const preview = build.pgPreviewSql({ schema: "public", table: hostile, columns: ["id", 'na"me'], key: ["id"], addressable: true, offset: 100, limit: 200 });
    r.check("pg preview: a hostile name stays one quoted identifier", preview.includes('"x""; DROP TABLE y; --"') && pg(preview).ok, preview);
    r.check("pg preview: each value cut in the engine", preview.includes('left(rp_t."id"::text, 201)') && preview.includes('left(rp_t."na""me"::text, 201)'));
    r.check("pg preview: ordered by the key, one row past the page", preview.includes('ORDER BY rp_t."id"') && preview.includes("LIMIT 51 OFFSET 100"));
    r.check("pg preview: the row's address last", preview.includes("rp_t.tableoid::text || ':' || rp_t.ctid::text"));
    const view = build.pgPreviewSql({ schema: "s", table: "v", columns: [], key: [], addressable: false, offset: 0, limit: 40 });
    r.check("pg preview: a view has no address, and no columns is still valid", !view.includes("ctid") && view.includes("ARRAY[]::text[]") && !view.includes("ORDER BY"));

    const cell = build.pgCellSql("public", "users", "bio", "16384:(0,7)");
    r.check("pg cell: found by tableoid and ctid", cell?.includes("rp_t.tableoid = 16384 AND rp_t.ctid = '(0,7)'::tid") && cell.includes(`${build.FULL_VALUE_LIMIT + 1}`));
    r.check(
      "pg cell: a handle that is not one is refused",
      [`16384:(0,7);DROP`, "abc", "1:(0,1) OR true", "1:(1,2,3)", ""].every((key) => build.pgCellSql("p", "t", "c", key) === null)
    );

    const typed = "SELECT 1 -- un commento";
    r.check("pg: a trailing comment ends before the wrapper", pg(build.pgDescribeSql(typed)).ok && build.pgDescribeSql(typed).endsWith("\n) AS rp_q LIMIT 0"));
    const rows = build.pgQueryRowsSql("SELECT a, a FROM t", 2, 50, 100);
    r.check("pg query: columns by position, so duplicates are two", rows.includes("AS rp_q(c1, c2)") && rows.includes("left(rp_q.c2::text, 101)") && rows.includes("LIMIT 51 OFFSET 50"));
    const types = build.pgTypesSql("SELECT 1", 1);
    r.check("pg types: one marked row even with no rows", types.includes(`'${build.PG_TYPES_MARK}'`) && types.includes("RIGHT JOIN (VALUES (1))") && pg(types).ok);
    r.check("pg tables: the fixed listing is a read", pg(build.PG_TABLES_SQL).ok, JSON.stringify(pg(build.PG_TABLES_SQL)));
    r.check("pg meta: names as literals, both statements reads", build.pgTableMetaSql("pu'b", "t").every((sql) => sql.includes("'pu''b'") && pg(sql).ok));

    r.check("my: identifiers double their backticks", build.myIdent("a`b") === "`a``b`");
    r.check("my: values as hex, read in one collation", build.myText("é'\\") === "CONVERT(X'c3a9275c' USING utf8mb4) COLLATE utf8mb4_bin");
    r.check("my: bytes as hex, or nothing", build.myBytes("0aFF") === "X'0aFF'" && build.myBytes("xyz") === null && build.myBytes("abc") === null);

    const script = build.mysqlScript(["SELECT 1;"], 10_000);
    const lines = script.trim().split("\n");
    r.check(
      "my script: read-only session and transaction, a time limit, a rollback",
      lines[0] === "SET SESSION TRANSACTION READ ONLY;" && lines.includes("START TRANSACTION READ ONLY;") && lines.includes("SET SESSION max_execution_time = 10000;") && lines.at(-1) === "ROLLBACK;",
      script
    );

    const typedQuery = "SELECT 'a;b\\' FROM `t\\`; DROP TABLE x; -- ";
    const prepared = build.mysqlPrepared(typedQuery);
    const hex = /X'([0-9a-f]*)'/.exec(prepared)?.[1] ?? "";
    r.check("my prepared: the text reaches the server only as hex", !prepared.includes("DROP") && !prepared.includes("\\") && prepared.split(";").length === 5, prepared);
    r.check("my prepared: and reads back exactly", Buffer.from(hex, "hex").toString("utf8") === typedQuery);
    r.check("my direct: on its own line before the semicolon", build.mysqlDirect("SHOW TABLES # c") === "SHOW TABLES # c\n;");

    r.check(
      "my kinds",
      ["varbinary", "LONGBLOB", "bit", "point", "vector", "varchar", "json"].map(build.myKindOfDataType).join() === "binary,binary,bit,geometry,vector,text,text"
    );
    r.check("my value: text cut in the engine", build.myValueExpr("`c`", "text", 100) === "LEFT(CAST(`c` AS CHAR), 101)");
    r.check("my value: bytes as hex, by bytes", build.myValueExpr("`c`", "binary", 100) === "IF(`c` IS NULL, NULL, CONCAT('0x', HEX(LEFT(`c`, 50))))");
    r.check("my value: bits and shapes", build.myValueExpr("`c`", "bit", 9).includes("BIN(`c` + 0)") && build.myValueExpr("`c`", "geometry", 9).includes("ST_AsText"));

    const plan = {
      table: "us`ers",
      columns: [{ name: "id", kind: "text" }, { name: "avatar", kind: "binary" }],
      key: [{ name: "id", kind: "text" }],
      offset: 0,
      limit: 100,
      timeoutMs: 10_000,
    };
    const myPreview = build.myPreviewSql(plan);
    r.check(
      "my preview: hint, quoted names, key last, ordered, one past the page",
      myPreview.startsWith("SELECT /*+ MAX_EXECUTION_TIME(10000) */ JSON_ARRAY(") &&
        myPreview.includes("FROM `us``ers` ORDER BY `id` LIMIT 51 OFFSET 0") &&
        myPreview.includes("CAST(`id` AS CHAR))"),
      myPreview
    );
    const myCell = build.myCellSql("t", { name: "bio", kind: "text" }, [{ name: "id", kind: "text" }, { name: "uid", kind: "binary" }], ["42", "00ff"], 10_000);
    r.check("my cell: found by the whole key, as literals", myCell?.includes("WHERE `id` = CONVERT(X'3432' USING utf8mb4) COLLATE utf8mb4_bin AND `uid` = X'00ff' LIMIT 1"), myCell);
    r.check(
      "my cell: a key that does not match is refused",
      build.myCellSql("t", { name: "c", kind: "text" }, [{ name: "id", kind: "text" }], ["1", "2"], 1) === null &&
        build.myCellSql("t", { name: "c", kind: "text" }, [{ name: "id", kind: "binary" }], ["zz"], 1) === null &&
        build.myCellSql("t", { name: "c", kind: "text" }, [{ name: "id", kind: "text" }], [1], 1) === null &&
        build.myCellSql("t", { name: "c", kind: "text" }, [], [], 1) === null
    );
    const myRows = build.myQueryRowsSql("SELECT 1 # c", [{ name: "1", kind: "text" }], 0, 50, 10_000);
    r.check("my query: columns by their derived names, after the typed text's own line", myRows.includes("rp_q.`1`") && myRows.includes("# c\n) AS rp_q"));
  }

  // --- Redis --------------------------------------------------------------------------------
  {
    const payload = redis.scanPayload({ cursor: "0", pattern: "utente:è*" });
    const bytes = [...payload];
    const e8 = Buffer.from("è", "utf8");
    r.check("redis payload: UTF-8 bytes travel as themselves", payload.includes(e8) && !payload.toString("latin1").includes("\\u00c3"), payload.toString("latin1"));
    const parsed = JSON.parse(payload.toString("latin1"));
    r.check("redis payload: the script's arguments", parsed.op === "scan" && parsed.cursor === "0" && parsed.limit === redis.REDIS_PAGE_KEYS && bytes.length > 0);

    const key = new Uint8Array([0x00, 0x0a, 0x22, 0x5c, 0xc3, 0xa8, 0xff]);
    const keyed = JSON.parse(redis.keyPayload(key, false).toString("latin1"));
    r.check("redis payload: a binary key reads back as the same bytes", Buffer.from(keyed.key, "latin1").equals(Buffer.from(key)));
    r.check("redis payload: full raises the cap", JSON.parse(redis.keyPayload(key, true).toString("latin1")).strcap === redis.REDIS_FULL_CAP);

    // cjson writes control characters as \u00XX and bytes above 0x7f as they are.
    const reply = Buffer.concat([Buffer.from(`${redis.REDIS_REPLY_MARK}{"k":[[["a\\u0000`, "latin1"), Buffer.from([0xc3, 0xa8]), Buffer.from('",4],"string",-1,3]],"c":"17","n":9,"e":100}', "latin1")]);
    const decoded = redis.decodeRedisReply(reply);
    const first = redis.describeBytes(decoded.k[0][0]);
    r.check("redis reply: a NUL makes a key binary, shown as redis-cli would", first.binary && first.text === "a\\x00\\xc3\\xa8", JSON.stringify(first));
    r.check("redis reply: and its bytes come back exactly", Buffer.from(first.raw, "base64").equals(Buffer.from([0x61, 0x00, 0xc3, 0xa8])));
    r.check("redis reply: the cursor stays a string", decoded.c === "17");
    r.check("redis reply: anything else is not a reply", redis.decodeRedisReply(Buffer.from("(error) NOAUTH Authentication required.")) === null);
    r.check("redis reply: an empty Lua table is an empty list", Array.isArray(redis.asList({})) && redis.asList({}).length === 0);

    const text = redis.describeBytes([Buffer.from("città", "utf8").toString("latin1"), 6]);
    r.check("redis bytes: UTF-8 is text", text.text === "città" && !text.binary && text.length === undefined);
    const cut = Buffer.from("perché", "utf8");
    const half = redis.describeBytes([cut.subarray(0, cut.length - 1).toString("latin1"), cut.length]);
    r.check("redis bytes: cut inside a character is still text", !half.binary && half.text === "perch" && half.length === cut.length, JSON.stringify(half));
    const tab = redis.describeBytes(["a\tb\nc", 5]);
    r.check("redis bytes: tabs and newlines are text", !tab.binary && tab.text === "a\tb\nc");
    r.check("redis key: base64 or nothing", redis.decodeKey("YQ==")?.[0] === 0x61 && redis.decodeKey("not base64!") === null && redis.decodeKey("YQ") === null);

    const calls = [...redis.REDIS_SCRIPT.matchAll(/redis\.call\("([A-Z_]+)"/g)].map((m) => m[1]);
    const reads = new Set(["SCAN", "TYPE", "PTTL", "STRLEN", "LLEN", "SCARD", "ZCARD", "HLEN", "XLEN", "DBSIZE", "GETRANGE", "LRANGE", "SSCAN", "ZRANGE", "HSCAN", "XRANGE"]);
    r.check("redis script: every command is a read", calls.length > 10 && calls.every((c) => reads.has(c)), calls.join(","));
    r.check("redis script: never KEYS", !/\bKEYS\b/.test(redis.REDIS_SCRIPT));
    r.check("redis script: a page looks at a bounded number of keys", redis.REDIS_SCRIPT.includes("examined >= p.budget") && redis.REDIS_SCAN_BUDGET <= 50_000);
  }

  // --- MongoDB -----------------------------------------------------------------------------
  {
    r.check("mongo filter: empty means everything", JSON.stringify(mongo.checkMongoFilter("  ")) === JSON.stringify({ ok: true, filter: "{}" }));
    r.check("mongo filter: JSON passes", mongo.checkMongoFilter('{"stato": "attivo", "n": {"$gt": 1}}').ok);
    r.check("mongo filter: Extended JSON passes", mongo.checkMongoFilter('{"_id": {"$oid": "5f1d7f3e9b1e8a3b2c4d5e6f"}}').ok);
    r.check("mongo filter: $expr passes", mongo.checkMongoFilter('{"$expr": {"$gt": ["$a", 1]}}').ok);
    r.check("mongo filter: shell syntax is not JSON", !mongo.checkMongoFilter("{stato: 'attivo'}").ok);
    r.check("mongo filter: an array is not a filter", !mongo.checkMongoFilter("[1]").ok && !mongo.checkMongoFilter("null").ok);
    r.check("mongo filter: $where runs code", mongo.checkMongoFilter('{"$where": "sleep(100)"}').reason?.includes("$where"));
    r.check("mongo filter: so does $function, nested", mongo.checkMongoFilter('{"a": {"$elemMatch": {"$expr": {"$function": {"body": "x", "args": [], "lang": "js"}}}}}').reason?.includes("$function"));
    r.check("mongo filter: and $accumulator, in an array", mongo.checkMongoFilter('{"$or": [{"a": 1}, {"$accumulator": {}}]}').reason?.includes("$accumulator"));
    let deep = "1";
    for (let i = 0; i < 60; i++) deep = `{"a": ${deep}}`;
    r.check("mongo filter: too deep", !mongo.checkMongoFilter(deep).ok);
    r.check("mongo filter: too long", !mongo.checkMongoFilter(`{"a": "${"x".repeat(mongo.MONGO_MAX_FILTER)}"}`).ok);

    const answer = mongo.decodeMongoReply(`Warning: something\n${mongo.MONGO_REPLY_MARK}{"ok":true,"docs":[]}\n`);
    r.check("mongo reply: found among other output", answer?.ok === true);
    r.check("mongo reply: none is none", mongo.decodeMongoReply("MongoServerError: Authentication failed.") === null);
    r.check("mongo script: reads its arguments from the environment", mongo.MONGO_SCRIPT.includes(`process.env.${mongo.MONGO_ARGS_VAR}`));
    r.check(
      "mongo script: no aggregation and nothing that writes",
      !/\.(aggregate|insert\w*|update\w*|delete\w*|replace\w*|drop\w*|remove|findAndModify|findOneAnd\w+|bulkWrite|create\w*|rename\w*)\(/.test(mongo.MONGO_SCRIPT)
    );
    r.check("mongo script: a time limit on every find", (mongo.MONGO_SCRIPT.match(/\.find\(/g) ?? []).length === (mongo.MONGO_SCRIPT.match(/maxTimeMS\(p\.timeoutMs\)/g) ?? []).length);
  }

  // --- what only the source can show ------------------------------------------------------
  {
    const route = read("app", "api", "services", "[serviceId]", "browse", "route.ts");
    r.check("the route asks for the console permission", route.includes('requireService(serviceId, "console")'));
    r.check("the route refuses API tokens", route.includes("denied.session.apiToken"));
    r.check("the route keeps rows out of caches", route.includes('"Cache-Control": "no-store"'));
    r.check("MCP tools cannot call it", read("services", "mcp", "panel-api.ts").includes("/^\\/api\\/services\\/[^/]+\\/browse$/"));

    const postgres = read("services", "db-browser", "postgres.ts");
    r.check(
      "psql: read-only session, time limits, standard strings",
      ["default_transaction_read_only=on", "statement_timeout=", "lock_timeout=", "standard_conforming_strings=on"].every((s) => postgres.includes(s))
    );
    r.check("psql: a read-only transaction around every call", postgres.includes('"-c", "BEGIN READ ONLY"') && postgres.includes('"-c", "ROLLBACK"'));
    r.check("psql: statements as -c, never a script on stdin", !postgres.includes('"-f"') && !postgres.includes("input:"));

    const mysql = read("services", "db-browser", "mysql.ts");
    r.check("mysql: client commands off, script through mysqlScript", mysql.includes('"--binary-mode"') && mysql.includes("mysqlScript(statements"));

    const files = ["exec.ts", "errors.ts", "index.ts", "postgres.ts", "mysql.ts", "redis.ts", "mongo.ts"].map((f) => read("services", "db-browser", f));
    r.check("nothing in the browser writes to the log", files.every((text) => !/console\.(log|error|warn|info)/.test(text)));
    r.check("no password on a command line", files.every((text) => !/"-p",|--password|-a",/.test(text)));
  }

  return r.result();
}
