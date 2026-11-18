import { createReporter } from "../harness.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The tail of a log, without reading the log.
 *
 * Checked against the whole-file reading it replaced, which is the definition
 * of the right answer, on the shapes a chunked reader gets wrong: lines longer
 * than a chunk, characters cut by a chunk boundary, no final newline, nothing.
 */
export const meta = { name: "log-file-unit", needsDocker: false, drivers: [], standalone: true };

/** What `readLogFile` did before: read everything, split, slice. */
function reference(content, tailLines) {
  const lines = content.split("\n");
  return lines.slice(Math.max(0, lines.length - tailLines)).join("\n");
}

export async function run({ repoRoot }) {
  const r = createReporter("log-file-unit");
  const { readLogFile, tailLogFile, tailLogLines, mergeLogTails, MAX_TAIL_BYTES } = await import(
    pathToFileURL(join(repoRoot, "services", "log-file.ts")).href
  );

  const dir = mkdtempSync(join(tmpdir(), "rp-log-file-"));
  const file = join(dir, "x.log");

  try {
    const long = "x".repeat(200 * 1024);
    // Three bytes each, so 64 KB chunks fall inside a character.
    const wide = "€".repeat(70 * 1024);
    const cases = [
      ["an empty file", ""],
      ["a single newline", "\n"],
      ["one line without a newline", "only"],
      ["one line with a newline", "only\n"],
      ["no final newline", "a\nb\nc"],
      ["a final newline", "a\nb\nc\n"],
      ["empty lines", "a\n\n\nb\n\n"],
      ["lines longer than a chunk", `${long}\n${long}b\n${long}c\n`],
      ["a line longer than a chunk with no final newline", `first\n${long}`],
      ["characters across chunk boundaries", `start\n${wide}\n${wide}\n`],
      ["four-byte characters", `a\n${"😀".repeat(40 * 1024)}\nb`],
      ["newlines right on a chunk boundary", `${"y".repeat(64 * 1024 - 1)}\n${"z".repeat(64 * 1024 - 1)}\nend\n`],
    ];

    for (const [what, content] of cases) {
      writeFileSync(file, content);
      for (const tail of [1, 2, 3, 500]) {
        const expected = reference(content, tail);
        r.check(`${what}: sync tail of ${tail}`, readLogFile(file, tail) === expected);
        r.check(`${what}: async tail of ${tail}`, (await tailLogFile(file, tail)) === expected);
      }
    }

    writeFileSync(file, "a\nb\n");
    r.check("no tail still returns the whole file", readLogFile(file) === "a\nb\n");
    r.check("a tail of 0 still means the whole file", readLogFile(file, 0) === "a\nb\n");

    const missing = join(dir, "missing.log");
    r.check("a missing file reads as empty", readLogFile(missing, 10) === "");
    r.check("a missing file tails as empty", (await tailLogFile(missing, 10)) === "");
    r.check("a missing file has no lines", (await tailLogLines(missing, 10)).length === 0);

    // --- the bound ------------------------------------------------------------
    // No newline for longer than the cap, with a cut that falls inside a character.
    const huge = `a${"é".repeat(MAX_TAIL_BYTES)}`;
    writeFileSync(file, huge);
    for (const [how, text] of [
      ["sync", readLogFile(file, 10)],
      ["async", await tailLogFile(file, 10)],
    ]) {
      r.check(`${how}: a line past the cap is bounded`, Buffer.byteLength(text) <= MAX_TAIL_BYTES + 64 * 1024, String(text.length));
      r.check(`${how}: a line past the cap reads to the end of the file`, text.length > 0 && huge.endsWith(text));
      r.check(`${how}: the cut leaves no broken character`, !text.includes("�"));
    }

    // --- lines ----------------------------------------------------------------
    writeFileSync(file, "a\n\nb\nc\n");
    r.check("the last lines skip the final newline", (await tailLogLines(file, 2)).join() === "b,c");
    writeFileSync(file, "a\nb\nc");
    r.check("the last lines need no final newline", (await tailLogLines(file, 2)).join() === "b,c");
    writeFileSync(file, Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join("\n"));
    r.check("a long file returns only what was asked", (await tailLogLines(file, 3)).join() === "line 99997,line 99998,line 99999");

    // --- two streams, one budget ----------------------------------------------
    const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    const merged = mergeLogTails(lines("o", 100), lines("e", 100), 100);
    r.check("a busy stderr cannot hide stdout", merged.filter((l) => l.startsWith("o")).length === 50);
    r.check("each stream keeps its newest lines", merged.includes("o99") && merged.includes("e99") && !merged.includes("o49"));
    r.check("stdout comes first", merged[0] === "o50" && merged.at(-1) === "e99");
    r.check("a quiet stdout leaves its share to stderr", mergeLogTails(lines("o", 5), lines("e", 200), 100).length === 100);
    r.check("a quiet stderr leaves its share to stdout", mergeLogTails(lines("o", 200), lines("e", 5), 100).filter((l) => l.startsWith("o")).length === 95);
    r.check("a short log comes back whole", mergeLogTails(["o"], ["e"], 100).join() === "o,e");
    r.check("no output is no lines", mergeLogTails([], [], 100).length === 0);
    r.check("an odd budget is not exceeded", mergeLogTails(lines("o", 50), lines("e", 50), 41).length === 41);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
