import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Reading a pasted `.env` the way the app would have read the file.
 *
 * A paste that changes a value silently (a stripped `#`, a quote kept, a key
 * lost) changes the app's configuration without anyone noticing.
 * Standalone: lib/dotenv-parse.ts has no imports.
 */
export const meta = { name: "dotenv-parse-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("dotenv-parse-unit");
  const { parseDotenv, mergeEnv } = await import(pathToFileURL(join(repoRoot, "lib", "dotenv-parse.ts")).href);
  const value = (text, key) => parseDotenv(text).vars.find((v) => v.key === key)?.value;

  r.check("plain pairs", JSON.stringify(parseDotenv("A=1\nB=two").vars) === JSON.stringify([{ key: "A", value: "1" }, { key: "B", value: "two" }]));
  r.check("comments and blank lines are skipped", parseDotenv("# c\n\n  # indented\nA=1\n").vars.length === 1);
  r.check("export prefix", value("export TOKEN=abc", "TOKEN") === "abc");
  r.check("spaces around =", value("NAME = valore", "NAME") === "valore");
  r.check("CRLF line endings", value("A=1\r\nB=2\r\n", "B") === "2");
  r.check("BOM is ignored", parseDotenv("﻿A=1").vars[0]?.key === "A");
  r.check("inline comment after whitespace is dropped", value("A=1 # note", "A") === "1");
  r.check("a # inside an unquoted value is kept", value("COLOR=#ff0000", "COLOR") === "#ff0000" && value("U=a#b", "U") === "a#b");
  r.check("double quotes keep spaces and #", value('MSG="ciao # mondo"', "MSG") === "ciao # mondo");
  r.check("double quotes understand escapes", value('S="a\nb\t\\"c\\""', "S") === 'a\nb\t"c"');
  r.check("single quotes are literal", value("S='a\nb'", "S") === "a\nb");
  r.check("empty values", value("EMPTY=", "EMPTY") === "" && value('Q=""', "Q") === "");
  r.check("a URL with = in it", value("DATABASE_URL=postgres://u:p@h/db?sslmode=require", "DATABASE_URL") === "postgres://u:p@h/db?sslmode=require");

  const multi = parseDotenv('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1');
  r.check("a quoted value may span lines", multi.vars[0]?.value === "-----BEGIN-----\nabc\n-----END-----" && multi.vars[1]?.key === "NEXT");

  const bad = parseDotenv("JUST_A_WORD\n1BAD=x\n=x\nOK=1\nOPEN=\"never closed");
  r.check("bad lines are reported with their number", JSON.stringify(bad.invalid.map((i) => i.line)) === JSON.stringify([1, 2, 3, 5]), JSON.stringify(bad.invalid));
  r.check("and the good ones still parse", bad.vars.length === 1 && bad.vars[0].key === "OK");
  r.check("text after a closing quote is refused", parseDotenv('A="x" y').invalid.length === 1);

  const dup = parseDotenv("A=1\nB=2\nA=3");
  r.check("a repeated key keeps its first position and last value", JSON.stringify(dup.vars) === JSON.stringify([{ key: "A", value: "3" }, { key: "B", value: "2" }]));
  r.check("and is reported", JSON.stringify(dup.duplicates) === JSON.stringify(["A"]));

  const existing = [{ key: "A", value: "1" }, { key: "B", value: "2" }];
  const incoming = [{ key: "B", value: "20" }, { key: "C", value: "3" }, { key: "A", value: "1" }];
  const over = mergeEnv(existing, incoming, "overwrite");
  r.check("overwrite replaces changed values and appends new keys", JSON.stringify(over.vars) === JSON.stringify([{ key: "A", value: "1" }, { key: "B", value: "20" }, { key: "C", value: "3" }]) && over.added === 1 && over.replaced === 1 && over.kept === 1);
  const skip = mergeEnv(existing, incoming, "skip");
  r.check("skip keeps existing values", skip.vars.find((v) => v.key === "B")?.value === "2" && skip.added === 1 && skip.replaced === 0 && skip.kept === 2);
  r.check("merging never mutates the input", existing[1].value === "2");

  return r.result();
}
