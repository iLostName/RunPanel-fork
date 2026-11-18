import { createReporter } from "../harness.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Scheduled tasks, without a server: the rules that decide what an unattended
 * command does on somebody's real machine.
 *
 *  - when an occurrence is due, late, or missed — across time zones and the
 *    two nights a year the clock jumps — and that a sequence of ticks runs
 *    each occurrence exactly once and never piles up after an outage;
 *  - whether a run may start: never twice at once, never during a deploy;
 *  - the failure streak and what is worth a notification;
 *  - how output is capped;
 *  - the store: migration 041 twice over, and the index that refuses a second
 *    run in flight;
 *  - the two shell scripts that stop a command inside a container, run here
 *    against a real `sh` and a real process tree when the machine has one.
 */
export const meta = { name: "tasks-unit", needsDocker: false, drivers: [], standalone: true };

const MIN = 60_000;
const HOUR = 60 * MIN;

export async function run({ repoRoot }) {
  const r = createReporter("tasks-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const t = await load("lib", "tasks-rules.ts");
  const cron = await load("lib", "cron.ts");
  const shell = await load("lib", "tasks-shell.ts");

  dueTimes(r, t, cron);
  ticks(r, t, cron);
  startRules(r, t);
  streaks(r, t);
  output(r, t);
  words(r, t);
  await shellErrors(r, t, repoRoot, load);
  await migration(r, repoRoot);
  await containerScripts(r, shell);

  return r.result();
}

function dueTimes(r, t, cron) {
  const at = "2026-03-10T03:00:00.000Z";
  const due = Date.parse(at);
  r.check("nothing is due without a next instant", t.dueVerdict(null, due, HOUR) === "not-due");
  r.check("before its instant it is not due", t.dueVerdict(at, due - 1, 24 * HOUR) === "not-due");
  r.check("at its instant it runs", t.dueVerdict(at, due, 24 * HOUR) === "run");
  r.check("a few minutes late it still runs", t.dueVerdict(at, due + 20 * MIN, 24 * HOUR) === "run");
  r.check("a nightly an hour and a bit late is missed", t.dueVerdict(at, due + 61 * MIN, 24 * HOUR) === "missed");
  r.check("garbage is not due", t.dueVerdict("domani", due, HOUR) === "not-due");

  r.check("the grace never drops under three ticks", t.lateGraceMs(MIN) === 90_000, String(t.lateGraceMs(MIN)));
  r.check("an hourly task has half an hour", t.lateGraceMs(HOUR) === 30 * MIN, String(t.lateGraceMs(HOUR)));
  r.check("a nightly one at most an hour", t.lateGraceMs(24 * HOUR) === HOUR);
  r.check("an unknown spacing gets the longest grace", t.lateGraceMs(null) === HOUR);
  r.check(
    "a minutely task two minutes late is missed, not run twice",
    t.dueVerdict(at, due + 2 * MIN, MIN) === "missed"
  );

  // The zone decides the instant: 03:00 in Rome is 02:00 UTC in winter, 01:00 in summer.
  const parse = (expression) => cron.parseCron(expression).spec;
  const winter = cron.nextAfter(parse("0 3 * * *"), new Date("2026-01-14T12:00:00Z"), "Europe/Rome");
  r.check("03:00 in Rome in January is 02:00 UTC", winter?.toISOString() === "2026-01-15T02:00:00.000Z", winter?.toISOString());
  const summer = cron.nextAfter(parse("0 3 * * *"), new Date("2026-07-14T12:00:00Z"), "Europe/Rome");
  r.check("and in July 01:00 UTC", summer?.toISOString() === "2026-07-15T01:00:00.000Z", summer?.toISOString());
  const ny = cron.nextAfter(parse("0 3 * * *"), new Date("2026-07-14T12:00:00Z"), "America/New_York");
  r.check("a task in its own zone keeps its own clock", ny?.toISOString() === "2026-07-15T07:00:00.000Z", ny?.toISOString());

  // Spring forward: 02:30 does not exist in Rome on 29 March 2026.
  const gap = cron.nextAfter(parse("30 2 * * *"), new Date("2026-03-28T12:00:00Z"), "Europe/Rome");
  r.check(
    "a time inside the spring gap runs at the jump, not never",
    gap?.toISOString() === "2026-03-29T01:00:00.000Z",
    gap?.toISOString()
  );
  // Fall back: 02:30 happens twice on 25 October 2026.
  const twice = cron.nextAfter(parse("30 2 * * *"), new Date("2026-10-24T12:00:00Z"), "Europe/Rome");
  r.check("a time that happens twice runs at the first", twice?.toISOString() === "2026-10-25T00:30:00.000Z", twice?.toISOString());
  const after = twice ? cron.nextAfter(parse("30 2 * * *"), twice, "Europe/Rome") : null;
  r.check("and not again an hour later", after?.toISOString() === "2026-10-26T01:30:00.000Z", after?.toISOString());
}

/**
 * The scheduler's loop, replayed with its own pure parts: a tick every thirty
 * seconds, a claim that moves `next` to the first occurrence after now, a
 * late run within the grace and a missed one beyond it. What it checks is the
 * composition — that an occurrence is taken once, and an outage costs at most
 * one late run or one missed record, however long it was.
 */
function ticks(r, t, cron) {
  const replay = ({ expression, zone, from, until, down = [] }) => {
    const spec = cron.parseCron(expression).spec;
    let next = cron.nextAfter(spec, new Date(from), zone)?.toISOString() ?? null;
    const runs = [];
    const missed = [];
    for (let now = Date.parse(from); now <= Date.parse(until); now += 30_000) {
      if (down.some(([a, b]) => now >= Date.parse(a) && now < Date.parse(b))) continue;
      const due = next ? Date.parse(next) : NaN;
      const following = Number.isFinite(due) ? cron.nextAfter(spec, new Date(due), zone) : null;
      const verdict = t.dueVerdict(next, now, following ? following.getTime() - due : null);
      if (verdict === "not-due") continue;
      (verdict === "run" ? runs : missed).push(next);
      next = cron.nextAfter(spec, new Date(now), zone)?.toISOString() ?? null;
    }
    return { runs, missed };
  };

  const nightly = replay({
    expression: "30 2 * * *",
    zone: "Europe/Rome",
    from: "2026-10-23T12:00:00Z",
    until: "2026-10-27T12:00:00Z",
  });
  r.check(
    "across the autumn change a nightly runs once a night",
    nightly.runs.length === 4 && nightly.missed.length === 0,
    JSON.stringify(nightly)
  );
  r.check(
    "and on the long night only once",
    nightly.runs.filter((at) => at.startsWith("2026-10-25")).length === 1,
    JSON.stringify(nightly.runs)
  );

  const spring = replay({ expression: "30 2 * * *", zone: "Europe/Rome", from: "2026-03-27T12:00:00Z", until: "2026-03-31T12:00:00Z" });
  r.check("across the spring change no night is skipped", spring.runs.length === 4 && spring.missed.length === 0, JSON.stringify(spring));

  const shortOutage = replay({
    expression: "0 3 * * *",
    zone: "UTC",
    from: "2026-05-01T00:00:00Z",
    until: "2026-05-02T00:00:00Z",
    down: [["2026-05-01T02:55:00Z", "2026-05-01T03:20:00Z"]],
  });
  r.check(
    "back twenty minutes after 03:00, the nightly runs once, late",
    shortOutage.runs.length === 1 && shortOutage.missed.length === 0,
    JSON.stringify(shortOutage)
  );

  const longOutage = replay({
    expression: "*/5 * * * *",
    zone: "UTC",
    from: "2026-05-01T00:00:00Z",
    until: "2026-05-01T12:00:00Z",
    down: [["2026-05-01T01:00:00Z", "2026-05-01T07:00:00Z"]],
  });
  // 00:05–00:55 before, 07:05–12:00 after. The 07:00 occurrence is the
  // instant the panel is back: the catch-up that records the missed 01:00
  // starts the schedule again from there, so it is part of that one record.
  const expected = 11 + 60;
  r.check(
    "six hours down cost one missed record, not seventy-two runs",
    longOutage.missed.length === 1 && longOutage.runs.length === expected,
    `${longOutage.runs.length} runs, ${longOutage.missed.length} missed (expected ${expected} and 1)`
  );
}

function startRules(r, t) {
  const base = {
    alreadyRunning: false,
    lockHolder: null,
    busyMessage: null,
    projectStatus: "running",
    panelClosing: false,
    savedRunsIn: "container",
    currentRunsIn: "container",
  };
  const decide = (change) => t.decideStart({ ...base, ...change });

  r.check("a free project runs", decide({}).start === true);
  r.check("never twice at once", decide({ alreadyRunning: true }).code === "running");
  r.check(
    "the run already going wins over any other reason",
    decide({ alreadyRunning: true, lockHolder: "deploy" }).code === "running"
  );
  r.check("never during a deploy", decide({ lockHolder: "deploy" }).code === "deploying");
  r.check("a row saying deploying is enough", decide({ projectStatus: "deploying" }).code === "deploying");
  const busy = decide({ lockHolder: "restart", busyMessage: "Il progetto si sta riavviando: aspetta che finisca." });
  r.check("another holder is named in its own words", busy.code === "busy" && busy.reason === "il progetto si sta riavviando", JSON.stringify(busy));
  r.check("a holder without words still says busy", decide({ lockHolder: "restore" }).code === "busy");
  r.check("nothing starts while the panel restarts", decide({ panelClosing: true }).code === "panel-closing");
  r.check(
    "a project that moved to the host waits for its tasks to be saved again",
    decide({ savedRunsIn: "container", currentRunsIn: "host" }).code === "context-changed"
  );
  r.check("docker and compose run in a container", t.runsInFor("docker") === "container" && t.runsInFor("compose") === "container");
  r.check("node, static and custom on the host", ["node", "static", "custom"].every((rt) => t.runsInFor(rt) === "host"));
}

function streaks(r, t) {
  const now = Date.parse("2026-06-01T03:00:00Z");
  const clean = { consecutiveFailures: 0, failureNotifiedAt: null };

  let step = t.afterRun(clean, "succeeded", "schedule", now);
  r.check("a success on a clean task says nothing", step.notice === null && step.streak.consecutiveFailures === 0);

  step = t.afterRun(clean, "failed", "schedule", now);
  r.check("the first scheduled failure is announced", step.notice === "failed" && step.streak.consecutiveFailures === 1);
  r.check("and remembered as announced", step.streak.failureNotifiedAt === new Date(now).toISOString());

  const second = t.afterRun(step.streak, "failed", "schedule", now + HOUR);
  r.check("the next one an hour later is counted, not announced", second.notice === null && second.streak.consecutiveFailures === 2);

  const reminder = t.afterRun(second.streak, "timed_out", "schedule", now + 12 * HOUR);
  r.check("twelve hours on, a reminder", reminder.notice === "failed" && reminder.streak.consecutiveFailures === 3);
  r.check("a timeout is a failure", t.isFailure("timed_out") && !t.isFailure("cancelled"));

  for (const status of ["skipped", "cancelled", "interrupted"]) {
    const neutral = t.afterRun(second.streak, status, "schedule", now + 2 * HOUR);
    r.check(`${status} neither breaks nor extends the streak`, neutral.notice === null && neutral.streak === second.streak);
  }

  const back = t.afterRun(reminder.streak, "succeeded", "manual", now + 13 * HOUR);
  r.check("the first success after an announced failure says so", back.notice === "recovered");
  r.check("and starts clean", back.streak.consecutiveFailures === 0 && back.streak.failureNotifiedAt === null);

  const manual = t.afterRun(clean, "failed", "manual", now);
  r.check("a failed Esegui ora is counted but not announced", manual.notice === null && manual.streak.consecutiveFailures === 1);
  r.check("leaving the streak unannounced", manual.streak.failureNotifiedAt === null);
  const thenScheduled = t.afterRun(manual.streak, "failed", "schedule", now + MIN);
  r.check("so the next scheduled failure announces it", thenScheduled.notice === "failed" && thenScheduled.streak.consecutiveFailures === 2);
  const quietRecovery = t.afterRun(manual.streak, "succeeded", "schedule", now + MIN);
  r.check("a recovery from failures nobody was told about is quiet", quietRecovery.notice === null);
}

function output(r, t) {
  const small = new t.OutputCapture(100, 300);
  small.push("uno\n");
  small.push("due\n");
  r.check("short output is kept whole", small.text() === "uno\ndue\n" && small.dropped === 0);

  const big = new t.OutputCapture(100, 300);
  for (let i = 0; i < 2000; i++) big.push(`riga ${i}\n`);
  const text = big.text();
  r.check("the head is kept", text.startsWith("riga 0\nriga 1\n"), text.slice(0, 40));
  r.check("the tail is kept", text.endsWith("riga 1999\n"), text.slice(-40));
  r.check("what is in between is counted, not hidden", /… .* di output non conservati …/.test(text) && big.dropped > 0, text.slice(90, 170));
  r.check("the tail starts on a line", /non conservati …\nriga \d+\n/.test(text), text.slice(90, 200));
  r.check("and the whole stays bounded", text.length < 100 + 300 + 80, String(text.length));

  const started = Date.now();
  const flood = new t.OutputCapture();
  for (let i = 0; i < 200_000; i++) flood.push("x".repeat(40) + "\n");
  const ms = Date.now() - started;
  r.check("eight megabytes of output cost no time", ms < 2_000 && flood.size <= t.OUTPUT_HEAD_CHARS + t.OUTPUT_TAIL_CHARS, `${ms} ms, ${flood.size}`);
}

function words(r, t) {
  r.check("timeouts read as people say them", t.formatTimeout(900) === "15 minuti" && t.formatTimeout(3600) === "1 ora" && t.formatTimeout(45) === "45 secondi");
  r.check("a failure names its exit code", t.outcomePhrase({ status: "failed", exitCode: 2 }) === "non riuscita (codice 2)");
  r.check("repeated skips say how many", t.outcomePhrase({ status: "skipped", exitCode: null, repeats: 4 }) === "saltata (5 volte di fila)");
  r.check(
    "the last line skips the gap marker and the stderr tag",
    t.lastMeaningfulLine("a\n[stderr] Error: boom\n\n") === "Error: boom" && t.lastMeaningfulLine("a\n… 3 KB di output non conservati …\n") === "a"
  );
  r.check("no output, no line", t.lastMeaningfulLine("") === null);
  r.check("every status has a label and a tone", t.TASK_RUN_STATUSES.every((s) => t.STATUS_LABEL[s] && t.STATUS_TONE[s]));
}

/** The exit code is read from run-shell's own message: checked against the real thing. */
async function shellErrors(r, t, repoRoot, load) {
  const { runShell } = await load("services", "builders", "run-shell.ts");
  const windows = process.platform === "win32";
  const sh = windows ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";
  const node = JSON.stringify(process.execPath);
  const dir = mkdtempSync(join(tmpdir(), "tasks-unit-"));
  const exec = async (command) => {
    try {
      await runShell(command, { shell: sh, windows, cwd: dir, env: process.env, timeout: 20_000, killGraceMs: 500, drainMs: 500, onLog: () => {} });
      return null;
    } catch (err) {
      return err;
    }
  };
  try {
    const three = await exec(`${node} -e "process.exit(3)"`);
    r.check("run-shell's exit code is read back", t.exitCodeFromShellError(three?.message ?? "") === 3, three?.message);
    const tricky = await exec(`${node} -e "console.log('exited with code 9'); process.exit(4)"`);
    r.check("from the end of the message, not from the command in it", t.exitCodeFromShellError(tricky?.message ?? "") === 4, tricky?.message);
    r.check("a message without a code has none", t.exitCodeFromShellError("Failed to run \"x\": spawn ENOENT") === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function migration(r, repoRoot) {
  const require = createRequire(join(repoRoot, "package.json"));
  let Kysely, SqliteDialect, SQLite;
  try {
    ({ Kysely, SqliteDialect } = require("kysely"));
    SQLite = require("better-sqlite3");
  } catch (err) {
    r.note(`store checks skipped: ${err.message}`);
    return;
  }

  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
  const dir = join(repoRoot, "lib", "db", "migrations");
  const m001 = await import(pathToFileURL(join(dir, "001-initial.ts")).href);
  const m041 = await import(pathToFileURL(join(dir, "041-project-tasks.ts")).href);

  try {
    await m001.up(db);
    await m041.up(db);
    let again = true;
    try {
      await m041.up(db);
    } catch {
      again = false;
    }
    r.check("migration 041 runs twice over the same store", again);

    const now = new Date().toISOString();
    await db
      .insertInto("projects")
      .values({
        id: "p1", name: "Shop", slug: "shop", source_type: "upload", source_branch: "main", runtime_type: "docker",
        builder_config: "{}", status: "running", auto_deploy: 0, webhook_secret: "s", created_at: now, updated_at: now,
      })
      .execute();
    await db
      .insertInto("project_tasks")
      .values({ id: "t1", project_id: "p1", name: "Cache", command: "true", runs_in: "container", created_at: now, updated_at: now })
      .execute();
    const task = await db.selectFrom("project_tasks").selectAll().where("id", "=", "t1").executeTakeFirst();
    r.check(
      "a task takes its defaults",
      task?.enabled === 1 && task?.timeout_sec === 900 && task?.cron === "" && task?.consecutive_failures === 0,
      JSON.stringify(task)
    );

    const runRow = (id, status) => ({ id, task_id: "t1", project_id: "p1", trigger: "schedule", status, command: "true", started_at: now });
    await db.insertInto("project_task_runs").values(runRow("r1", "succeeded")).execute();
    await db.insertInto("project_task_runs").values(runRow("r2", "running")).execute();
    let refused = false;
    try {
      await db.insertInto("project_task_runs").values(runRow("r3", "running")).execute();
    } catch {
      refused = true;
    }
    r.check("the store refuses a second run in flight", refused);
    await db.insertInto("project_task_runs").values(runRow("r4", "skipped")).execute();
    r.check("finished and skipped runs are not limited", (await db.selectFrom("project_task_runs").select("id").execute()).length === 3);

    await db.deleteFrom("projects").where("id", "=", "p1").execute();
    const left = (await db.selectFrom("project_tasks").select("id").execute()).length + (await db.selectFrom("project_task_runs").select("id").execute()).length;
    r.check("deleting the project takes its tasks and their history", left === 0, String(left));
  } finally {
    await db.destroy();
  }
}

/**
 * The wrapper and the kill script, against a real `sh` and `/proc`: on Linux,
 * and on Windows under Git's `sh`, whose `/proc` has the same `PPid:` lines.
 * Skipped with a note where there is no such shell.
 */
async function containerScripts(r, shell) {
  const marker = shell.pidMarker("0123456789abcdef");
  r.check("a marker line gives the pid", shell.parsePidMarker(`${marker}4242`, marker) === 4242);
  r.check("pid 1 is never ours", shell.parsePidMarker(`${marker}1`, marker) === null);
  r.check("another run's marker is not this one's", shell.parsePidMarker(`${shell.pidMarker("ffff")}4242`, marker) === null);
  r.check("a marker with junk is refused", shell.parsePidMarker(`${marker}12; rm -rf /`, marker) === null);
  const args = shell.containerRunArgs("runpanel-shop", "echo 'ciao' && exit 3", marker, 900);
  r.check(
    "the command reaches the container as an argument, never inside the script",
    args[0] === "exec" && args[1] === "runpanel-shop" && args.at(-1) === "echo 'ciao' && exit 3" && !shell.CONTAINER_WRAPPER.includes("ciao"),
    JSON.stringify(args)
  );
  r.check(
    "the stop runs as the container's own user, never as root",
    shell.containerKillArgs("c", 42, 5).slice(0, 3).join(" ") === "exec c sh" && !shell.containerKillArgs("c", 42, 5).includes("--user")
  );

  let usable = false;
  try {
    usable = execFileSync("sh", ["-c", "read -r k v rest < /proc/$$/status; [ \"$k\" = Name: ] && echo yes"], { timeout: 10_000 }).toString().trim() === "yes";
  } catch {
    usable = false;
  }
  if (!usable) {
    r.note("no sh with /proc here: the wrapper and the kill script were not run");
    return;
  }

  const child = spawn("sh", ["-c", shell.CONTAINER_WRAPPER, "runpanel-task", marker, "600", "sleep 300 & sleep 300 & echo started; wait"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pid = null;
  let firstLine = null;
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (firstLine === null && line) {
        firstLine = line;
        pid = shell.parsePidMarker(line, marker);
      }
    }
  });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 50 && !(pid && stdout.includes("started")); i++) await new Promise((res) => setTimeout(res, 100));

  r.check("the wrapper reports its pid first, on stderr", pid !== null, String(firstLine));
  if (pid === null) {
    child.kill();
    return;
  }

  const descendants = () => {
    const out = execFileSync("sh", ["-c", shell.CONTAINER_KILL_TREE.replace(/\npids=\$\(tree\)[\s\S]*$/, "\ntree"), "probe", String(pid), "0"], { timeout: 30_000 });
    return out.toString().trim().split(/\s+/).filter(Boolean);
  };
  const before = descendants();
  r.check("the tree is found from the root", before.length >= 3, before.join(" "));

  execFileSync("sh", ["-c", shell.CONTAINER_KILL_TREE, "runpanel-kill", String(pid), "3"], { timeout: 60_000 });
  const outcome = await Promise.race([closed, new Promise((res) => setTimeout(() => res("still running"), 10_000))]);
  r.check("the stop ends the command", outcome !== "still running", JSON.stringify(outcome));

  const alive = before.filter((p) => {
    try {
      const state = execFileSync("sh", ["-c", 'while read -r k v rest; do [ "$k" = State: ] && echo "$v"; done < "/proc/$1/status"', "probe", p], {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      return state !== "" && state !== "Z";
    } catch {
      return false;
    }
  });
  r.check("and everything it had started", alive.length === 0, alive.join(" "));
}
