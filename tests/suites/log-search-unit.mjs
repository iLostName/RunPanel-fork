import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The stored form of an app's log, and finding a line in it.
 *
 * The server searches its files and the Logs tab searches its buffer with the
 * same functions, so a line found in one place is found in the other. The
 * Docker half is about never storing a line twice and never skipping one,
 * across reads that start where the previous one ended.
 */
export const meta = { name: "log-search-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("log-search-unit");
  const log = await import(pathToFileURL(join(repoRoot, "lib", "log-search.ts")).href);
  const {
    cleanLogText,
    toArchiveLine,
    fromArchiveLine,
    toDownloadLine,
    makeLogFilter,
    highlightParts,
    normalizeDockerTs,
    splitTimestamped,
    isoFromDockerTs,
    mergeStamped,
    freshSince,
    MAX_LOG_LINE_CHARS,
    APP_LOG_RETENTION,
  } = log;
  const ESC = String.fromCharCode(27);

  // --- one line, cleaned ----------------------------------------------------
  r.check("colour codes go", cleanLogText(`${ESC}[31mred${ESC}[0m text`) === "red text");
  r.check("a trailing CR goes", cleanLogText("windows\r") === "windows");
  r.check("a progress bar keeps its last state", cleanLogText("10%\r50%\r100%") === "100%");
  r.check("a tab stays", cleanLogText("a\tb") === "a\tb");
  r.check("other control characters go", cleanLogText(`a${String.fromCharCode(7)}b${String.fromCharCode(0)}c`) === "abc");
  r.check("brackets in ordinary text stay", cleanLogText("[Hello] [31m") === "[Hello] [31m");
  const long = cleanLogText("x".repeat(MAX_LOG_LINE_CHARS + 100));
  r.check("a huge line is cut and says so", long.length < MAX_LOG_LINE_CHARS + 30 && long.endsWith("[riga troncata]"));

  // --- the stored line -------------------------------------------------------
  const entry = { at: "2026-11-18T10:00:00.123Z", stream: "stderr", text: "Error:\tcolumn\tvalue" };
  r.check("a stored line reads back", JSON.stringify(fromArchiveLine(toArchiveLine(entry))) === JSON.stringify(entry));
  r.check("an unknown time reads back as null", fromArchiveLine(toArchiveLine({ at: null, stream: "stdout", text: "x" }))?.at === null);
  r.check("an empty text is a line", fromArchiveLine(toArchiveLine({ at: null, stream: "stdout", text: "" }))?.text === "");
  r.check("something else is not a stored line", fromArchiveLine("plain text") === null && fromArchiveLine("a\tx\tb") === null && fromArchiveLine("") === null);
  r.check("the download has time, stream and text", toDownloadLine(entry) === "2026-11-18T10:00:00.123Z  stderr  Error:\tcolumn\tvalue");
  r.check("an unknown time keeps the columns", toDownloadLine({ at: null, stream: "stdout", text: "x" }).indexOf("stdout") === toDownloadLine(entry).indexOf("stderr"));
  r.check("the retention is bounded", APP_LOG_RETENTION.fileBytes * APP_LOG_RETENTION.files <= 32 * 1024 * 1024);

  // --- search ---------------------------------------------------------------
  const lines = [
    { text: "Server listening on :3000", stream: "stdout" },
    { text: "TypeError: Cannot read (undefined)", stream: "stderr" },
    { text: "GET /api/users 200", stream: "stdout" },
    { text: "warning: deprecated", stream: "stderr" },
    { text: "no stream given" },
  ];
  const count = (filter) => lines.filter(makeLogFilter(filter)).length;
  r.check("no filter keeps everything", count({}) === 5 && count({ query: "  ", stream: "all" }) === 5);
  r.check("search ignores case", count({ query: "typeerror" }) === 1);
  r.check("search is literal, brackets and all", count({ query: "read (undefined)" }) === 1 && count({ query: ".*" }) === 0);
  r.check("stderr only", count({ stream: "stderr" }) === 2);
  r.check("a line without a stream is stdout", count({ stream: "stdout" }) === 3);
  r.check("both filters together", count({ query: "api", stream: "stdout" }) === 1 && count({ query: "api", stream: "stderr" }) === 0);
  r.check("the filter can be reused", (() => { const f = makeLogFilter({ query: "a" }); return f({ text: "a" }) && f({ text: "a" }) && f({ text: "ba" }); })());

  const parts = highlightParts("Error: error ERROR", "error");
  r.check("every match is highlighted, in its own case", parts.filter((p) => p.match).map((p) => p.text).join() === "Error,error,ERROR");
  r.check("the pieces put back are the line", parts.map((p) => p.text).join("") === "Error: error ERROR");
  r.check("no query is one plain piece", highlightParts("abc", " ").length === 1 && highlightParts("abc", "").at(0)?.match === false);
  r.check("a query with regex characters is literal", highlightParts("a+b a+b", "a+b").filter((p) => p.match).length === 2);
  r.check("accented text matches", highlightParts("Città città", "CITTÀ").filter((p) => p.match).length === 2);

  // --- Docker's stamps ------------------------------------------------------
  r.check("a short fraction is padded", normalizeDockerTs("2026-11-18T10:00:00.12Z") === "2026-11-18T10:00:00.120000000Z");
  r.check("no fraction is padded too", normalizeDockerTs("2026-11-18T10:00:00Z") === "2026-11-18T10:00:00.000000000Z");
  r.check("a full fraction stays", normalizeDockerTs("2026-11-18T10:00:00.123456789Z") === "2026-11-18T10:00:00.123456789Z");
  r.check("garbage is not a stamp", normalizeDockerTs("yesterday") === null && normalizeDockerTs("2026-11-18 10:00:00Z") === null);
  r.check("padded stamps sort as text", normalizeDockerTs("2026-11-18T10:00:00.12Z") < normalizeDockerTs("2026-11-18T10:00:00.1234Z"));
  const split = splitTimestamped("2026-11-18T10:00:00.5Z GET / 200 ok");
  r.check("a stamped line splits once", split?.ts === "2026-11-18T10:00:00.500000000Z" && split?.text === "GET / 200 ok");
  r.check("an empty stamped line has empty text", splitTimestamped("2026-11-18T10:00:00Z")?.text === "");
  r.check("an unstamped line does not split", splitTimestamped("plain line") === null);
  r.check("the stored time is milliseconds", isoFromDockerTs("2026-11-18T10:00:00.123456789Z") === "2026-11-18T10:00:00.123Z");
  r.check("which a Date reads", !Number.isNaN(Date.parse(isoFromDockerTs("2026-11-18T10:00:00.123456789Z"))));

  const at = (n) => `2026-11-18T10:00:0${n}.000000000Z`;
  const out = [{ ts: at(1), stream: "stdout", text: "o1" }, { ts: at(3), stream: "stdout", text: "o3" }, { ts: at(3), stream: "stdout", text: "o3b" }];
  const err = [{ ts: at(2), stream: "stderr", text: "e2" }, { ts: at(3), stream: "stderr", text: "e3" }];
  const merged = mergeStamped(out, err);
  r.check("the two pipes merge by time", merged.map((l) => l.text).join() === "o1,e2,o3,o3b,e3", merged.map((l) => l.text).join());
  r.check("an empty pipe merges to the other", mergeStamped(out, []).length === 3 && mergeStamped([], err).length === 2);

  // A read, then a read from its last stamp: nothing twice, nothing missing.
  const first = freshSince(merged, { since: null, skip: 0 });
  r.check("the first read stores everything", first.fresh.length === 5);
  r.check("and starts the next at its last stamp", first.cursor.since === at(3) && first.cursor.skip === 3, JSON.stringify(first.cursor));
  const again = [...merged.filter((l) => l.ts >= at(3)), { ts: at(3), stream: "stdout", text: "o3c" }, { ts: at(4), stream: "stdout", text: "o4" }];
  const second = freshSince(again, first.cursor);
  r.check("the next read stores only what is new", second.fresh.map((l) => l.text).join() === "o3c,o4", second.fresh.map((l) => l.text).join());
  r.check("and moves on", second.cursor.since === at(4) && second.cursor.skip === 1);
  const idle = freshSince(again.slice(0, 4), { since: at(3), skip: 4 });
  r.check("a read with nothing new keeps the cursor", idle.fresh.length === 0 && idle.cursor.since === at(3) && idle.cursor.skip === 4);
  r.check("lines older than the cursor are never stored", freshSince([{ ts: at(1), stream: "stdout", text: "old" }], { since: at(2), skip: 0 }).fresh.length === 0);
  r.check("an empty read is nothing", freshSince([], { since: null, skip: 0 }).fresh.length === 0);

  return r.result();
}
