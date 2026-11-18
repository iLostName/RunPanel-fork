import { createReporter } from "../harness.mjs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The Variables tab's rules: what is sent, what is wrong and on which row, and
 * how the list is written as a `.env` and read back.
 *
 * The round trip is the one that matters most. The text view rewrites the list
 * every time it is opened, and a value that does not come back byte for byte —
 * a private key losing a newline, a `#` cutting a password — is a broken app
 * after the next deploy, saved by somebody who changed nothing.
 */
export const meta = { name: "env-table-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("env-table-unit");

  // `lib/validation.ts` imports its neighbours without an extension; see validation-unit.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      const fromTs = context.parentURL?.endsWith(".ts");
      return nextResolve(extensionless && fromTs ? `${specifier}.ts` : specifier, context);
    },
  });

  const table = await import(pathToFileURL(join(repoRoot, "lib", "env-table.ts")).href);
  const { parseDotenv, mergeEnv } = await import(pathToFileURL(join(repoRoot, "lib", "dotenv-parse.ts")).href);
  const { envVarsSchema } = await import(pathToFileURL(join(repoRoot, "lib", "validation.ts")).href);
  const {
    rowsToPairs,
    rowProblems,
    listProblem,
    serverIssuesToRows,
    countChanges,
    serializeDotenv,
    pasteSummary,
    pasteSummaryText,
    buildPrefixOf,
    filterRows,
    KEY_MISSING,
    KEY_REPEATED,
    KEY_RULE,
    VALUE_TOO_LONG,
  } = table;

  let id = 0;
  const rows = (...pairs) => pairs.map(([key, value]) => ({ id: ++id, key, value }));

  // --- what is sent -----------------------------------------------------------
  const sent = rowsToPairs(rows(["  API_URL ", "x"], ["", ""], ["", "orphan"], ["B", ""]));
  r.check("names are trimmed", sent.pairs[0].key === "API_URL");
  r.check("an empty row is not sent", sent.pairs.length === 3);
  r.check("a value without a name is kept, to be reported", sent.pairs.some((p) => p.key === "" && p.value === "orphan"));
  r.check("a name without a value is a variable", sent.pairs.some((p) => p.key === "B" && p.value === ""));
  r.check("each sent entry knows its row", sent.ids.length === sent.pairs.length && new Set(sent.ids).size === sent.ids.length);

  // --- what is wrong, on the row --------------------------------------------
  const list = rows(["OK", "1"], ["1BAD", "2"], ["", "3"], ["DUP", "a"], ["DUP", "b"], ["BIG", "x".repeat(65_537)], ["", ""]);
  const problems = rowProblems(list);
  r.check("a valid row has no problem", !problems.has(list[0].id));
  r.check("a bad name is on its row", problems.get(list[1].id)?.key === KEY_RULE);
  r.check("a value without a name says the name is missing", problems.get(list[2].id)?.key === KEY_MISSING);
  r.check("a repeated name is marked on every copy", problems.get(list[3].id)?.key === KEY_REPEATED && problems.get(list[4].id)?.key === KEY_REPEATED);
  r.check("a long value is on the value", problems.get(list[5].id)?.value === VALUE_TOO_LONG);
  r.check("an empty row is not a problem", !problems.has(list[6].id));
  r.check("the name rule says the same as the server", KEY_RULE === "Nome non valido: usa lettere, numeri e _ e non iniziare con un numero");
  r.check("the count limit is the server's", listProblem(Array.from({ length: 501 }, (_, i) => ({ key: `K${i}`, value: "" }))) !== null && listProblem([]) === null);

  // The client's verdict and the server's agree, row by row.
  const samples = [["A", "1"], ["_x", ""], ["a b", "1"], ["9", "x"], ["É", "x"], ["K".repeat(64), ""], ["K".repeat(65), ""], ["V", "x".repeat(65_536)], ["V2", "x".repeat(65_537)]];
  for (const [key, value] of samples) {
    const one = rows([key, value]);
    const client = !rowProblems(one).has(one[0].id);
    const server = envVarsSchema.safeParse({ vars: [{ key, value }] }).success;
    r.check(`client and server agree on «${key.slice(0, 12)}» (${value.length} chars)`, client === server, `client ${client}, server ${server}`);
  }
  const twice = envVarsSchema.safeParse({ vars: [{ key: "A", value: "1" }, { key: "A", value: "2" }] });
  r.check("the server refuses a repeated name too", !twice.success && twice.error.issues[0]?.path.join(".") === "vars.1.key", JSON.stringify(twice.error?.issues));

  // --- a 400 back on the rows -----------------------------------------------
  const shown = rows(["", ""], ["OK", "1"], ["1BAD", "2"], ["LONG", "x"]);
  const body = rowsToPairs(shown);
  const parsed = envVarsSchema.safeParse({ vars: [...body.pairs.slice(0, 2), { key: "LONG", value: "x".repeat(70_000) }] });
  const mapped = serverIssuesToRows(parsed.error?.issues, body.ids);
  r.check("a server issue lands on the row it is about, past a dropped blank row", mapped.rows.get(shown[2].id)?.key?.startsWith("Nome non valido") === true, JSON.stringify([...mapped.rows]));
  r.check("a too-long value is said in Italian", mapped.rows.get(shown[3].id)?.value === VALUE_TOO_LONG);
  const empty = envVarsSchema.safeParse({ vars: [{ key: "", value: "1" }] });
  r.check("zod's English for an empty name is replaced", serverIssuesToRows(empty.error?.issues, [42]).rows.get(42)?.key === KEY_MISSING);
  const many = envVarsSchema.safeParse({ vars: Array.from({ length: 501 }, (_, i) => ({ key: `K${i}`, value: "" })) });
  r.check("a problem of the whole list is general", serverIssuesToRows(many.error?.issues, []).general?.includes("500") === true);
  r.check("garbage issues are ignored", serverIssuesToRows("nope", []).rows.size === 0);

  // --- unsaved changes --------------------------------------------------------
  const saved = [{ key: "A", value: "1" }, { key: "B", value: "2" }];
  r.check("nothing changed is zero", countChanges(saved, [{ key: "B", value: "2" }, { key: "A", value: "1" }]) === 0);
  r.check("an edit, an addition and a removal are three", countChanges(saved, [{ key: "A", value: "9" }, { key: "C", value: "3" }]) === 3);
  r.check("a repeated name counts", countChanges(saved, [...saved, { key: "A", value: "1" }]) === 1);
  r.check("a value typed before its name counts", countChanges(saved, [...saved, { key: "", value: "x" }]) === 1);

  // --- table to text and back -------------------------------------------------
  const tricky = [
    { key: "PLAIN", value: "valore" },
    { key: "EMPTY", value: "" },
    { key: "URL", value: "postgres://u:p@h:5432/db?sslmode=require&x=1" },
    { key: "HASH_LEADING", value: "#ff0000" },
    { key: "HASH_AFTER_SPACE", value: "pass #word" },
    { key: "SPACES", value: "  padded  " },
    { key: "QUOTE_START", value: '"quoted" inside' },
    { key: "SINGLE_START", value: "'x'" },
    { key: "BACKTICK", value: "`cmd`" },
    { key: "QUOTE_MIDDLE", value: 'say "hi"' },
    { key: "BACKSLASH", value: "C:\\new\\table" },
    { key: "ESCAPES_LITERAL", value: "a\\nb\\\"c" },
    { key: "PEM", value: "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----" },
    { key: "CRLF", value: "line1\r\nline2" },
    { key: "TAB", value: "a\tb" },
    { key: "UNICODE", value: "città € 😀" },
    { key: "EQUALS", value: "a=b=c" },
    { key: "DOLLAR", value: "$HOME and ${X}" },
  ];
  const text = serializeDotenv(tricky);
  const back = parseDotenv(text);
  r.check("the text reads back without invalid lines", back.invalid.length === 0, JSON.stringify(back.invalid));
  for (const pair of tricky) {
    const found = back.vars.find((v) => v.key === pair.key);
    r.check(`${pair.key} comes back byte for byte`, found?.value === pair.value, JSON.stringify(found?.value));
  }
  r.check("the order is kept", back.vars.map((v) => v.key).join() === tricky.map((v) => v.key).join());
  r.check("an ordinary value is written as typed", text.split("\n")[0] === "PLAIN=valore");
  r.check("a multi-line value keeps real newlines", text.includes('PEM="-----BEGIN KEY-----\nabc'));
  r.check("blank rows are not written", serializeDotenv([{ key: "", value: "" }, { key: "A", value: "1" }]) === "A=1");

  // --- pasting over the list --------------------------------------------------
  const existing = [{ key: "A", value: "1" }, { key: "B", value: "2" }, { key: "C", value: "3" }];
  const incoming = [{ key: "B", value: "20" }, { key: "C", value: "3" }, { key: "D", value: "4" }, { key: "E", value: "5" }];
  const over = pasteSummary(existing, incoming, "overwrite");
  const skip = pasteSummary(existing, incoming, "skip");
  r.check("overwrite counts", over.added === 2 && over.replaced === 1 && over.same === 1 && over.skipped === 0, JSON.stringify(over));
  r.check("skip counts", skip.added === 2 && skip.replaced === 0 && skip.same === 1 && skip.skipped === 1, JSON.stringify(skip));
  for (const [mode, summary] of [["overwrite", over], ["skip", skip]]) {
    const merged = mergeEnv(existing, incoming, mode);
    r.check(`the summary agrees with mergeEnv (${mode})`, merged.added === summary.added && merged.replaced === summary.replaced && merged.kept === summary.same + summary.skipped);
  }
  r.check("the summary reads in Italian", pasteSummaryText(over) === "2 aggiunte, 1 sostituita, 1 uguale", pasteSummaryText(over));
  r.check("singular and skipped", pasteSummaryText({ added: 1, replaced: 0, same: 2, skipped: 1 }) === "1 aggiunta, 1 lasciata com'era, 2 uguali");
  r.check("nothing to paste says so", pasteSummaryText({ added: 0, replaced: 0, same: 0, skipped: 0 }) === "nessuna variabile");

  // --- badges and search ------------------------------------------------------
  const prefixes = ["NEXT_PUBLIC_", "VITE_"];
  r.check("a prefixed name goes to the build", buildPrefixOf("NEXT_PUBLIC_API", prefixes) === "NEXT_PUBLIC_");
  r.check("a name is matched after trimming", buildPrefixOf("  VITE_X", prefixes) === "VITE_");
  r.check("an unprefixed name does not", buildPrefixOf("API_SECRET", prefixes) === null);
  r.check("an empty prefix matches nothing", buildPrefixOf("ANY", [""]) === null);
  const found = filterRows(rows(["DATABASE_URL", "x"], ["API_KEY", "database"], ["db_name", "y"]), "data");
  r.check("search looks at names, not values", found.length === 1 && found[0].key === "DATABASE_URL");
  r.check("search ignores case", filterRows(rows(["db_name", "y"]), "DB").length === 1);
  r.check("an empty search shows all", filterRows(rows(["A", ""], ["B", ""]), "  ").length === 2);

  return r.result();
}
