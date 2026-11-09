import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { createReporter } from "../harness.mjs";

/**
 * That a toast stays a toast.
 *
 * A failed compose or build used to put docker's whole output in the error,
 * thousands of characters, and the toast grew past the screen and left after
 * four seconds. `summarize` decides what the toast shows; the rest opens in a
 * dialog. Standalone: `lib/toast-text.ts` has no imports.
 */
export const meta = { name: "toast-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("toast-unit");
  const { summarize, TOAST_MAX_CHARS } = await import(pathToFileURL(join(repoRoot, "lib", "toast-text.ts")).href);

  const plain = summarize("Salvataggio non riuscito");
  r.check("a sentence is shown whole", plain.short === "Salvataggio non riuscito" && plain.cut === false, JSON.stringify(plain));

  const output = `Command failed: docker compose up -d\n${"x".repeat(8000)}`;
  const long = summarize(output);
  r.check("an 8k-character error shows its first line", long.short === "Command failed: docker compose up -d" && long.cut, long.short.slice(0, 80));

  const line = summarize(`${"parola ".repeat(80)}fine`);
  r.check("a long single line is cut on a word", line.cut && line.short.length <= TOAST_MAX_CHARS + 1 && line.short.endsWith("parola…"), line.short);

  const blank = summarize("\n\n  Errore vero\n");
  r.check("blank lines before the message are skipped", blank.short === "Errore vero" && blank.cut === false, JSON.stringify(blank));

  return r.result();
}
