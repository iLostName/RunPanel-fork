import { createReporter } from "../harness.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Scheduled tasks, without a server: the rules that decide what an unattended
 * command does on somebody's real machine.
 *
 *  - when an occurrence is due, late, or missed — across time zones and the
 *    two nights a year the clock jumps — and that the scheduler's own
 *    `planTick`, replayed tick by tick, runs each occurrence exactly once and
 *    never piles up after an outage;
 *  - whether a run may start: never twice at once, not even beside a run a
 *    panel restart lost, never during a deploy, never on a project that
 *    changed under the command;
 *  - the failure streak and what is worth a notification;
 *  - how output is capped, and what the store can hold;
 *  - the store: migration 041 twice over, and the index that refuses a second
 *    run in flight;
 *  - the shell side — the script a command becomes, the host wrapper's
 *    backstop, the container wrapper and its watchdog, the kill script — run
 *    here against a real `sh` and a real process tree when the machine has
 *    one (Linux, or Windows with Git's `sh`, whose `/proc` has the same lines).
 */
export const meta = { name: "tasks-unit", needsDocker: false, drivers: [], standalone: true };

const MIN = 60_000;
const HOUR = 60 * MIN;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({ repoRoot }) {
  const r = createReporter("tasks-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const t = await load("lib", "tasks-rules.ts");
  const cron = await load("lib", "cron.ts");
  const shell = await load("lib", "tasks-shell.ts");

  zones(r, cron);
  plans(r, t, cron);
  ticks(r, t, cron);
  startRules(r, t);
  streaks(r, t);
  output(r, t);
  words(r, t);
  scripts(r, shell);
  await migration(r, repoRoot);
  await realShell(r, shell);

  return r.result();
}

function zones(r, cron) {
  const parse = (expression) => cron.parseCron(expression).spec;
  // The zone decides the instant: 03:00 in Rome is 02:00 UTC in winter, 01:00 in summer.
  const winter = cron.nextAfter(parse("0 3 * * *"), new Date("2026-01-14T12:00:00Z"), "Europe/Rome");
  r.check("03:00 in Rome in January is 02:00 UTC", winter?.toISOString() === "2026-01-15T02:00:00.000Z", winter?.toISOString());
  const summer = cron.nextAfter(parse("0 3 * * *"), new Date("2026-07-14T12:00:00Z"), "Europe/Rome");
  r.check("and in July 01:00 UTC", summer?.toISOString() === "2026-07-15T01:00:00.000Z", summer?.toISOString());
  const ny = cron.nextAfter(parse("0 3 * * *"), new Date("2026-07-14T12:00:00Z"), "America/New_York");
  r.check("a task in its own zone keeps its own clock", ny?.toISOString() === "2026-07-15T07:00:00.000Z", ny?.toISOString());

  // Spring forward: 02:30 does not exist in Rome on 29 March 2026.
  const gap = cron.nextAfter(parse("30 2 * * *"), new Date("2026-03-28T12:00:00Z"), "Europe/Rome");
  r.check("a time inside the spring gap runs at the jump, not never", gap?.toISOString() === "2026-03-29T01:00:00.000Z", gap?.toISOString());
  // Fall back: 02:30 happens twice on 25 October 2026.
  const twice = cron.nextAfter(parse("30 2 * * *"), new Date("2026-10-24T12:00:00Z"), "Europe/Rome");
  r.check("a time that happens twice runs at the first", twice?.toISOString() === "2026-10-25T00:30:00.000Z", twice?.toISOString());
  const after = twice ? cron.nextAfter(parse("30 2 * * *"), twice, "Europe/Rome") : null;
  r.check("and not again an hour later", after?.toISOString() === "2026-10-26T01:30:00.000Z", after?.toISOString());
}

function plans(r, t, cron) {
  r.check("the grace never drops under three ticks", t.lateGraceMs(MIN) === 90_000, String(t.lateGraceMs(MIN)));
  r.check("an hourly task has half an hour", t.lateGraceMs(HOUR) === 30 * MIN, String(t.lateGraceMs(HOUR)));
  r.check("a nightly one at most an hour", t.lateGraceMs(24 * HOUR) === HOUR);
  r.check("an unknown spacing gets the longest grace", t.lateGraceMs(null) === HOUR);

  const nextOf = (expression, zone = "UTC") => {
    const spec = cron.parseCron(expression).spec;
    let calls = 0;
    const next = (ms) => {
      calls++;
      return cron.nextAfter(spec, new Date(ms), zone)?.getTime() ?? null;
    };
    return { next, calls: () => calls };
  };

  const nightly = nextOf("0 3 * * *");
  const due = Date.parse("2026-03-10T03:00:00Z");
  r.check("before its instant it waits", t.planTick(due, due - 1, nightly.next).kind === "wait");
  r.check("garbage waits", t.planTick(Number.NaN, due, nightly.next).kind === "wait");
  const onTime = t.planTick(due, due + 12_000, nightly.next);
  r.check(
    "on time it runs, and moves to the next night",
    onTime.kind === "run" && onTime.scheduledFor === due && onTime.next === Date.parse("2026-03-11T03:00:00Z"),
    JSON.stringify(onTime)
  );
  const minutely = nextOf("* * * * *");
  t.planTick(due, due + 5_000, minutely.next);
  r.check("a run on time costs one look at the schedule", minutely.calls() === 1, String(minutely.calls()));
  const late = t.planTick(due, due + 20 * MIN, nightly.next);
  r.check("twenty minutes late it still runs", late.kind === "run" && late.scheduledFor === due);

  const lost = t.planTick(due, due + 2 * HOUR, nightly.next);
  r.check(
    "two hours late a nightly is missed, with nothing to catch up",
    lost.kind === "missed" && lost.catchUp === null && lost.next === Date.parse("2026-03-11T03:00:00Z"),
    JSON.stringify(lost)
  );

  const hourly = nextOf("0 * * * *");
  const back = t.planTick(Date.parse("2026-03-10T07:00:00Z"), Date.parse("2026-03-10T10:00:30Z"), hourly.next);
  r.check(
    "after a night down, the newest occurrence within its grace runs instead of the oldest",
    back.kind === "missed" && back.catchUp === Date.parse("2026-03-10T10:00:00Z") && back.next === Date.parse("2026-03-10T11:00:00Z"),
    JSON.stringify(back)
  );
}

/**
 * The scheduler's own `planTick`, replayed: a tick every thirty seconds, the
 * claim moving the schedule to what the plan says. What it checks is the
 * composition — that an occurrence is taken once, and an outage costs one
 * missed record and at most one late run, however long it was.
 */
function ticks(r, t, cron) {
  const replay = ({ expression, zone, from, until, down = [] }) => {
    const spec = cron.parseCron(expression).spec;
    const next = (ms) => cron.nextAfter(spec, new Date(ms), zone)?.getTime() ?? null;
    let due = next(Date.parse(from));
    const runs = [];
    const missed = [];
    for (let now = Date.parse(from); now <= Date.parse(until) && due !== null; now += 30_000) {
      if (down.some(([a, b]) => now >= Date.parse(a) && now < Date.parse(b))) continue;
      const plan = t.planTick(due, now, next);
      if (plan.kind === "wait") continue;
      if (plan.kind === "run") runs.push(new Date(plan.scheduledFor).toISOString());
      else {
        missed.push(new Date(due).toISOString());
        if (plan.catchUp !== null) runs.push(new Date(plan.catchUp).toISOString());
      }
      due = plan.next;
    }
    return { runs, missed };
  };

  const autumn = replay({ expression: "30 2 * * *", zone: "Europe/Rome", from: "2026-10-23T12:00:00Z", until: "2026-10-27T12:00:00Z" });
  r.check("across the autumn change a nightly runs once a night", autumn.runs.length === 4 && autumn.missed.length === 0, JSON.stringify(autumn));
  r.check("and on the long night only once", autumn.runs.filter((at) => at.startsWith("2026-10-25")).length === 1, JSON.stringify(autumn.runs));

  const spring = replay({ expression: "30 2 * * *", zone: "Europe/Rome", from: "2026-03-27T12:00:00Z", until: "2026-03-31T12:00:00Z" });
  r.check("across the spring change no night is skipped", spring.runs.length === 4 && spring.missed.length === 0, JSON.stringify(spring));

  const short = replay({
    expression: "0 3 * * *",
    zone: "UTC",
    from: "2026-05-01T00:00:00Z",
    until: "2026-05-02T00:00:00Z",
    down: [["2026-05-01T02:55:00Z", "2026-05-01T03:20:00Z"]],
  });
  r.check("back twenty minutes after 03:00, the nightly runs once, late", short.runs.length === 1 && short.missed.length === 0, JSON.stringify(short));

  const long = replay({
    expression: "*/5 * * * *",
    zone: "UTC",
    from: "2026-05-01T00:00:00Z",
    until: "2026-05-01T12:00:00Z",
    down: [["2026-05-01T01:00:00Z", "2026-05-01T07:00:00Z"]],
  });
  // 00:05–00:55 before; the 07:00 occurrence, which is the instant the panel
  // is back, as the catch-up; then 07:05–12:00.
  r.check(
    "six hours down cost one missed record, not seventy-two runs",
    long.missed.length === 1 && long.runs.length === 11 + 1 + 60 && long.runs.includes("2026-05-01T07:00:00.000Z"),
    `${long.runs.length} runs, ${long.missed.length} missed`
  );

  const night = replay({
    expression: "0 * * * *",
    zone: "UTC",
    from: "2026-05-01T05:00:00Z",
    until: "2026-05-01T12:00:00Z",
    down: [["2026-05-01T07:00:00Z", "2026-05-01T10:00:30Z"]],
  });
  r.check(
    "an hourly task back at 10:00:30 runs 10:00, not 07:00, 08:00 and 09:00",
    JSON.stringify(night.runs) === JSON.stringify(["06:00", "10:00", "11:00", "12:00"].map((h) => `2026-05-01T${h}:00.000Z`)) && night.missed.length === 1,
    JSON.stringify(night)
  );
}

function startRules(r, t) {
  const now = Date.parse("2026-06-01T03:00:00Z");
  const base = {
    alreadyRunning: false,
    orphanUntil: null,
    now,
    lockHolder: null,
    busyMessage: null,
    projectStatus: "running",
    panelClosing: false,
    savedRunsIn: "container",
    currentRunsIn: "container",
    reachesHost: false,
    hostApproved: false,
  };
  const decide = (change) => t.decideStart({ ...base, ...change });

  r.check("a free project runs", decide({}).start === true);
  r.check("never twice at once", decide({ alreadyRunning: true }).code === "running");
  r.check("the run already going wins over any other reason", decide({ alreadyRunning: true, lockHolder: "deploy" }).code === "running");
  r.check("not beside a run a restart may have left going", decide({ orphanUntil: now + 60_000 }).code === "orphan");
  r.check("once its backstop has surely ended it, it runs again", decide({ orphanUntil: now - 1 }).start === true);
  r.check("never during a deploy", decide({ lockHolder: "deploy" }).code === "deploying");
  r.check("a row saying deploying is enough", decide({ projectStatus: "deploying" }).code === "deploying");
  const busy = decide({ lockHolder: "restart", busyMessage: "Il progetto si sta riavviando: aspetta che finisca." });
  r.check("another holder is named in its own words", busy.code === "busy" && busy.reason === "il progetto si sta riavviando", JSON.stringify(busy));
  r.check("a holder without words still says busy", decide({ lockHolder: "restore" }).code === "busy");
  r.check("nothing starts while the panel restarts", decide({ panelClosing: true }).code === "panel-closing");
  r.check("a project that moved to the host waits to be confirmed", decide({ currentRunsIn: "host" }).code === "context-changed");
  r.check(
    "a container that started reaching the host waits for someone allowed there",
    decide({ reachesHost: true, hostApproved: false }).code === "host-review"
  );
  r.check("unless that is who saved it", decide({ reachesHost: true, hostApproved: true }).start === true);
  r.check("docker and compose run in a container", t.runsInFor("docker") === "container" && t.runsInFor("compose") === "container");
  r.check("node, static and custom on the host", ["node", "static", "custom"].every((rt) => t.runsInFor(rt) === "host"));

  const started = "2026-06-01T02:50:00.000Z";
  const deadline = t.orphanDeadline({ status: "interrupted", error: t.INTERRUPTED_MESSAGE, startedAt: started }, 900, 60);
  r.check("an interrupted run is assumed alive until its limit and backstop", deadline === Date.parse(started) + 960_000, String(deadline));
  r.check("a finished one is not", t.orphanDeadline({ status: "succeeded", error: null, startedAt: started }, 900, 60) === null);
  r.check("nor no run at all", t.orphanDeadline(null, 900, 60) === null);
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

  r.check("a NUL never reaches the store", t.storableText("a\u0000b") === "a�b" && t.storableText("ok") === "ok");
  r.check("a Windows exit code is stored as Windows prints it", t.storableInt(3221225477) === -1073741819);
  r.check("anything else out of range is clamped", t.storableInt(9e12) === 2147483647 && t.storableInt(-9e12) === -2147483648);
  r.check("and nothing stays nothing", t.storableInt(null) === null && t.storableInt(2.7) === 2);
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
  r.check("every reason to skip has its words", ["running", "orphan", "host-review", "missed"].every((code) => t.SKIP_REASONS[code]));
}

function scripts(r, shell) {
  r.check("comment-only commands have nothing to run", !shell.hasRunnableLine("# uno\n\n   # due") && shell.hasRunnableLine("# uno\necho"));
  const posix = shell.posixScript("echo uno\r\n# commento\n\necho due # coda");
  r.check(
    "each line is its own group, comments and blank lines gone",
    posix === "{ echo uno\n} || exit $?\n{ echo due # coda\n} || exit $?",
    JSON.stringify(posix)
  );
  r.check(
    "cmd.exe gets the && chain, without its comment lines",
    shell.cmdScript("echo a\r\nREM x\n:: y\n# z\necho b") === "echo a && echo b",
    shell.cmdScript("echo a\r\nREM x\n:: y\n# z\necho b")
  );
  const host = shell.hostRunArgs("/bin/bash", "{ true\n} || exit $?", 960);
  r.check(
    "the host wrapper gets the limit, the shell and the script as arguments",
    host[0] === "-c" && host[1] === shell.HOST_WRAPPER && host.slice(2).join("|") === "runpanel-task|960|/bin/bash|{ true\n} || exit $?",
    JSON.stringify(host)
  );

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
      task?.enabled === 1 && task?.timeout_sec === 900 && task?.cron === "" && task?.consecutive_failures === 0 && task?.host_approved === 0 && task?.schedule_zone === null,
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

/** Run a script with `sh`, collecting what it prints and how it ends. */
function sh(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("sh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const started = Date.now();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, pid: child.pid });
    });
  });
}

function isAlive(pid) {
  try {
    const state = execFileSync("sh", ["-c", 'while read -r k v rest; do [ "$k" = State: ] && echo "$v"; done < "/proc/$1/status"', "probe", String(pid)], {
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return state !== "" && state !== "Z";
  } catch {
    return false;
  }
}

function descendants(shell, root) {
  const lister = shell.CONTAINER_KILL_TREE.replace(/\npids=\$\(tree\)[\s\S]*$/, "\ntree");
  return execFileSync("sh", ["-c", lister, "probe", String(root), "0"], { timeout: 30_000 }).toString().trim().split(/\s+/).filter(Boolean);
}

async function realShell(r, shell) {
  let usable = false;
  try {
    usable = execFileSync("sh", ["-c", "read -r k v rest < /proc/$$/status; [ \"$k\" = Name: ] && echo yes"], { timeout: 10_000 }).toString().trim() === "yes";
  } catch {
    usable = false;
  }
  if (!usable) {
    r.note("no sh with /proc here: the scripts were not run against real processes");
    return;
  }

  // --- the script a command becomes --------------------------------------------
  const script = shell.posixScript("echo uno\n# echo mai\ncd /\npwd # dove\nsleep 0 &\nfalse\necho mai");
  const ran = await sh(["-c", script]);
  r.check(
    "a comment line no longer swallows the lines after it",
    ran.stdout.split("\n").filter(Boolean).join("|") === "uno|/",
    JSON.stringify(ran)
  );
  r.check("the first failing line stops the rest with its code", ran.code === 1, JSON.stringify(ran));

  // --- the host wrapper's backstop -------------------------------------------
  const backstop = await sh(shell.hostRunArgs("sh", "sleep 30 & sleep 30; wait", 2), { timeoutMs: 40_000 });
  r.check("with the panel gone, the host backstop ends the run at its limit", backstop.ms < 15_000, JSON.stringify(backstop));

  // --- the container wrapper ----------------------------------------------------
  const marker = shell.pidMarker("0123456789abcdef");
  const quick = await sh(["-c", shell.CONTAINER_WRAPPER, "runpanel-task", marker, "600", shell.posixScript("echo presto")]);
  r.check("a short command ends at once, the watchdog holding none of its pipes", quick.ms < 5_000 && quick.stdout.trim() === "presto", JSON.stringify(quick));
  r.check("its first stderr line is the pid", shell.parsePidMarker(quick.stderr.split("\n")[0] ?? "", marker) !== null, quick.stderr);

  const watched = await sh(["-c", shell.CONTAINER_WRAPPER, "runpanel-task", marker, "3", "sleep 60 & sleep 60 & wait"], { timeoutMs: 60_000 });
  r.check("with the panel gone, the watchdog ends the whole tree at its limit", watched.ms < 20_000, JSON.stringify(watched));

  // --- the panel's stop ---------------------------------------------------------
  const child = spawn("sh", ["-c", shell.CONTAINER_WRAPPER, "runpanel-task", marker, "600", "sleep 300 & sleep 300 & echo started; wait"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pid = null;
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) if (pid === null) pid = shell.parsePidMarker(line, marker);
  });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 50 && !(pid && stdout.includes("started")); i++) await sleep(100);
  r.check("the wrapper reports its pid", pid !== null);
  if (pid === null) {
    child.kill();
    return;
  }
  const before = descendants(shell, pid);
  r.check("the tree is found from the root, watchdog included", before.length >= 4, before.join(" "));

  execFileSync("sh", ["-c", shell.CONTAINER_KILL_TREE, "runpanel-kill", String(pid), "3"], { timeout: 60_000 });
  const outcome = await Promise.race([closed, sleep(10_000).then(() => "still running")]);
  r.check("the stop ends the command", outcome !== "still running", JSON.stringify(outcome));
  const alive = before.filter(isAlive);
  r.check("and everything it had started, the watchdog too", alive.length === 0, alive.join(" "));
}
