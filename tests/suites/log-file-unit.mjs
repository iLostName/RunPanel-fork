import { createReporter } from "../harness.mjs";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
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
  const { readLogFile, tailLogFile, tailLogLines, mergeLogTails, MAX_TAIL_BYTES, planRotation, RotatingLogFile, readNewLines } =
    await import(pathToFileURL(join(repoRoot, "services", "log-file.ts")).href);

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

    // --- rotation: the plan ---------------------------------------------------
    const policy = { fileBytes: 100, files: 3 };
    const plan = (size, bytes) => planRotation(size, bytes, policy);
    r.check("lines that fit go in the live file", JSON.stringify(plan(10, [20, 20])) === JSON.stringify({ skip: 0, groups: [{ rotate: false, count: 2 }] }));
    r.check("a line that does not fit starts a new file", JSON.stringify(plan(90, [20, 20]).groups) === JSON.stringify([{ rotate: true, count: 2 }]));
    r.check("a long batch rotates as often as it needs", plan(0, Array(10).fill(30)).groups.map((g) => `${g.rotate}:${g.count}`).join() === "false:3,true:3,true:3,true:1");
    r.check("a batch larger than everything kept drops its oldest lines", plan(0, Array(20).fill(30)).skip === 10);
    r.check("a line larger than a file gets one of its own", JSON.stringify(plan(50, [150]).groups) === JSON.stringify([{ rotate: true, count: 1 }]));
    r.check("an empty live file never rotates first", plan(0, [150]).groups[0].rotate === false);
    r.check("a line larger than everything kept is still kept", plan(0, [500]).skip === 0 && plan(0, [10, 500]).skip === 1);
    r.check("no lines, no plan", plan(10, []).groups.length === 0);

    // --- rotation: the files --------------------------------------------------
    const rotDir = join(dir, "rotated");
    const rotating = new RotatingLogFile(rotDir, "app", policy);
    for (let i = 0; i < 40; i++) rotating.append([`line ${String(i).padStart(3, "0")} ${"x".repeat(14)}`]);
    const files = rotating.files();
    r.check("never more files than the policy keeps", files.length === 3, files.join());
    r.check("files are listed oldest first", files[files.length - 1].endsWith("app.log") && files[0].endsWith("app.2.log"));
    r.check("no file passes its size", files.every((f) => statSync(f).size <= 100));
    const kept = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean));
    r.check("the newest lines are kept, in order", kept.at(-1)?.startsWith("line 039") === true && kept.every((l, i) => i === 0 || l > kept[i - 1]));
    r.check("the total is bounded", rotating.totalBytes() <= 300);
    rotating.append(["a", "b", "c"]);
    const joined = rotating.files().map((f) => readFileSync(f, "utf8")).join("");
    r.check("a batch split across files reads back in order", joined.endsWith("a\nb\nc\n"));
    r.check("and the live file starts at a line", /^[a-z]/.test(readFileSync(rotating.fileAt(0), "utf8")));
    rotating.remove();
    r.check("remove takes the files and the folder", !existsSync(rotDir));

    // --- reading a file someone else writes -------------------------------------
    const pm2 = join(dir, "app-out.log");
    writeFileSync(pm2, "one\ntwo\npart");
    let read = readNewLines(pm2, null, 1024);
    r.check("the first read takes the complete lines", read.lines.join() === "one,two" && !read.restarted);
    r.check("and stops before the unfinished one", read.cursor.offset === 8);
    appendFileSync(pm2, "ial\nthree\n");
    read = readNewLines(pm2, read.cursor, 1024);
    r.check("the next read starts where it stopped", read.lines.join() === "partial,three", read.lines.join());
    const settled = readNewLines(pm2, read.cursor, 1024);
    r.check("nothing new is nothing", settled.lines.length === 0 && settled.cursor.offset === read.cursor.offset);

    truncateSync(pm2, 0);
    appendFileSync(pm2, "new run\n");
    read = readNewLines(pm2, read.cursor, 1024);
    r.check("an emptied file is read again from its start", read.restarted && read.lines.join() === "new run");

    // Emptied and filled past the old offset between two reads: only the mark can tell.
    const cursorBefore = read.cursor;
    truncateSync(pm2, 0);
    appendFileSync(pm2, "a much longer second run line\nand another\n");
    read = readNewLines(pm2, cursorBefore, 1024);
    r.check("a refilled file is noticed by its bytes", read.restarted && read.lines[0] === "a much longer second run line", JSON.stringify(read));

    const big = join(dir, "big-out.log");
    writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n") + "\n");
    read = readNewLines(big, null, 1000);
    r.check("a long file is first read from its end", read.lines.at(-1) === "row 4999" && read.lines.length < 200);
    r.check("from a whole line", /^row \d+$/.test(read.lines[0]));
    let backlog = readNewLines(big, { offset: 0, mark: "" }, 1000);
    let rounds = 1;
    while (backlog.lines.length > 0 && rounds < 200) {
      backlog = readNewLines(big, backlog.cursor, 1000);
      rounds++;
    }
    r.check("a backlog is read over several calls", rounds > 10 && backlog.cursor.offset === statSync(big).size);

    writeFileSync(pm2, "x".repeat(70 * 1024));
    read = readNewLines(pm2, null, 128 * 1024);
    r.check("a line that never ends is taken past its limit", read.lines.length === 1 && read.cursor.offset === 70 * 1024);
    r.check("a missing file is null", readNewLines(join(dir, "nope.log"), null, 10) === null);

    writeFileSync(pm2, "città\n€uro\n");
    r.check("characters come back whole", readNewLines(pm2, null, 1024).lines.join() === "città,€uro");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
