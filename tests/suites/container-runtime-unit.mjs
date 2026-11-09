import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReporter } from "../harness.mjs";

/**
 * The rules behind the container runtime that do not need a daemon: who a
 * container name belongs to, what a directory listing means, what a stack adds
 * up to, and when the stats stream runs.
 *
 * The directory script is the exception to "pure": it runs for real under every
 * POSIX shell this machine has, because the bugs it replaces were all in how the
 * output of a real command was read. `dash` is the closest thing to busybox ash
 * that needs no container.
 */
export const meta = { name: "container-runtime-unit", needsDocker: false, drivers: [], standalone: true };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll instead of a fixed wait: timers on a loaded machine run late, never early. */
async function until(condition, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
}

/** A `docker stats` that is entirely in the hands of the suite. */
function fakeStats() {
  const fake = {
    spawns: 0,
    stops: 0,
    emit: null,
    exit: null,
    source: {
      available: async () => true,
      stream: (onLine, onExit) => {
        fake.spawns += 1;
        fake.emit = onLine;
        fake.exit = onExit;
        return () => {
          fake.stops += 1;
        };
      },
    },
  };
  return fake;
}

const statsLine = (name) => JSON.stringify({ Name: name, CPUPerc: "1.50%", MemUsage: "1MiB / 2GiB", MemPerc: "0.05%" });

export async function run({ repoRoot }) {
  const r = createReporter("container-runtime-unit");
  const load = (...path) => import(pathToFileURL(join(repoRoot, ...path)).href);

  const { isReservedSlug } = await load("lib", "project-slug.ts");
  const { foreignOwner, parseContainerList, parseLabelsJson, labelArgs, appContainerName, serviceContainerName } =
    await load("services", "docker", "labels.ts");
  const { LIST_DIRECTORY_SCRIPT, LIST_DIRECTORY_NOT_FOUND, parseDirectoryListing } =
    await load("lib", "container-listing.ts");
  const { appProcessInfo, parseContainerFacts, stackProcessInfo, sumContainerUsage } =
    await load("lib", "docker-snapshot.ts");
  const { StatsCollector } = await load("lib", "stats-collector.ts");
  const { spaceShortfall } = await load("lib", "mount-space.ts");

  // --- slugs a new project cannot take --------------------------------------
  for (const slug of ["svc", "svc-postgres", "svc-app-db", "net", "net-shop", "mountseed", "mountseed-abc"]) {
    r.check(`"${slug}" is reserved`, isReservedSlug(slug));
  }
  for (const slug of ["shop", "svcs", "network", "my-svc", "shop-web-1", "project-1762473600000"]) {
    r.check(`"${slug}" is free`, !isReservedSlug(slug));
  }
  r.check(
    "every service container falls in a reserved slug",
    isReservedSlug(serviceContainerName("db").replace(/^runpanel-/, "")) &&
      isReservedSlug(serviceContainerName("db", "app").replace(/^runpanel-/, ""))
  );

  // --- who a container name belongs to ---------------------------------------
  /** The labels a real `docker create` stamps, read back as a map. */
  const stamped = (labels) => {
    const args = labelArgs(labels).filter((arg) => arg !== "--label");
    return Object.fromEntries(args.map((pair) => pair.split("=")));
  };
  const compose = { "com.docker.compose.project": "runpanel-shop", "com.docker.compose.service": "web" };

  r.check(
    "the app of the project is its own",
    foreignOwner("shop", stamped({ project: "shop", kind: "app", deployment: "d1" }), false) === null
  );
  r.check(
    "a standalone service is not the app of a project of the same name",
    /postgres/.test(foreignOwner("svc-postgres", stamped({ kind: "service", service: "postgres" }), true) ?? "")
  );
  r.check(
    "a service attached to a project is not either",
    /db/.test(foreignOwner("svc-app-db", stamped({ project: "app", kind: "service", service: "db" }), true) ?? "")
  );
  r.check(
    "nor is one attached to the project asking",
    foreignOwner("app", stamped({ project: "app", kind: "service", service: "db" }), false) !== null
  );
  r.check(
    "a compose container is not the app of a project named like it",
    /runpanel-shop/.test(foreignOwner("shop-web-1", compose, false) ?? "")
  );
  r.check(
    "the app of another project is not this one",
    /other/.test(foreignOwner("shop", stamped({ project: "other", kind: "app" }), false) ?? "")
  );
  r.check("a container from before the labels stays the app of its project", foreignOwner("shop", {}, false) === null);
  r.check("but not under a reserved name, where it can be a service", foreignOwner("svc-pg", {}, true) !== null);
  r.check(
    "a label from the image cannot make the app look foreign",
    foreignOwner("shop", { ...stamped({ project: "shop", kind: "app" }), ...compose }, false) === null
  );
  r.check("no labels reads as an empty map", Object.keys(parseLabelsJson("null\n")).length === 0);
  r.check("labels read back from json", parseLabelsJson('{"a":"b"}').a === "b");
  r.check("a project container is the name the routes use", appContainerName("shop") === "runpanel-shop");

  // --- whether a seed fits ------------------------------------------------------
  {
    const seed = (place, disk, neededKb, freeKb) => ({ place, disk, neededKb, freeKb });
    const scratch = (disk, freeKb) => ({ place: "/tmp", disk, freeKb });

    r.check("what fits is let through", spaceShortfall([seed("/a", "1", 100, 500)], scratch("2", 500)) === null);
    r.check("what does not is refused", spaceShortfall([seed("/a", "1", 100, 100)], null)?.place === "/a");
    r.check(
      "two on one disk share its space, even read at different moments",
      spaceShortfall([seed("/a", "1", 60, 100), seed("/b", "1", 60, 99)], null)?.neededKb === 120
    );
    r.check(
      "two on different disks do not",
      spaceShortfall([seed("/a", "1", 60, 100), seed("/b", "2", 60, 100)], null) === null
    );
    r.check("the archive has to fit in tmp too", spaceShortfall([seed("/a", "1", 100, 500)], scratch("2", 100))?.place === "/tmp");
    r.check(
      "and costs twice on the same disk",
      spaceShortfall([seed("/a", "1", 100, 150)], scratch("1", 150))?.neededKb === 200
    );
    r.check("an unknown tmp is not a refusal", spaceShortfall([seed("/a", "1", 100, 500)], null) === null);
  }

  // --- the wiring -------------------------------------------------------------
  // Everything below needs a daemon to run for real, so these only keep the
  // calls in place: the rule each one applies is checked above.
  {
    const source = (...path) => fs.readFileSync(join(repoRoot, ...path), "utf8");
    const driver = source("services", "process-drivers", "docker-driver.ts");
    const start = driver.slice(driver.indexOf("async start("));
    const projectDir = ["app", "api", "projects", "[projectId]"];
    const terminal = source(...projectDir, "terminal", "route.ts");
    const content = source(...projectDir, "files", "content", "route.ts");
    const client = source("app", "(panel)", "projects", "[projectId]", "_components", "TerminalTab.tsx");

    r.check(
      "a deploy checks the container before removing it",
      start.indexOf("assertOwnAppContainer(slug)") !== -1 &&
        start.indexOf("assertOwnAppContainer(slug)") < start.indexOf('"rm", "-f"')
    );
    r.check("the ownership filter is anchored", driver.includes("name=^/?${name}$"));
    r.check("the terminal checks before exec", terminal.indexOf("assertOwnAppContainer") < terminal.indexOf('"exec"'));
    r.check("the terminal uses the shared name", !terminal.includes("`runpanel-${"));
    r.check("the file routes use the shared name", !content.includes("`runpanel-${"));
    r.check("both file verbs check the container", content.split("await assertOwnAppContainer").length === 3);
    r.check("only an explicit start opens a shell", /if \(action === "start"\) \{/.test(terminal) && !terminal.includes("!sessions.has(sessionKey)"));
    r.check("the client starts with an explicit action", client.includes('action: "start"'));
    r.check("the client closes the session on dead", /status === "dead"[\s\S]{0,200}onActiveChange\(false\)/.test(client));
    r.check("new projects are checked", source("app", "api", "projects", "route.ts").includes("isReservedSlug(slug)"));

    const compose = source("services", "process-drivers", "compose-driver.ts");
    for (const [name, text] of [["docker", driver], ["compose", compose]]) {
      r.check(`the ${name} driver only looks at the stats`, text.includes("containerStats.peek") && !text.includes("containerStats.get") && !text.includes("ensureStarted"));
    }
    r.check("a look at a project is what asks for them", source(...projectDir, "status", "route.ts").includes("containerStats.ensureStarted()"));
    r.check("compose matches real names, not a prefix", !compose.includes("startsWith"));
    r.check("the monitor asks once for everything", source("app", "api", "monitor", "route.ts").includes("dockerSnapshot"));
    r.check("the pm2 log is read from its tail", source("services", "process-drivers", "pm2-driver.ts").includes("tailLogLines"));
    r.check("restoring on another service checks the login", source("services", "backup", "restore.ts").includes("canSignIn(target, engine)"));
    r.check("the restart policy is only set on our own container", /assertOwnAppContainer[\s\S]{0,120}setRestartPolicy\(/.test(source("app", "api", "autostart", "fix", "route.ts")));
  }

  // --- the listing of the host ----------------------------------------------
  {
    const rows = parseContainerList(
      [
        "runpanel-shop-web-1|running|com.docker.compose.project=runpanel-shop,com.docker.compose.oneoff=False",
        "runpanel-shop-web-run-ab12|exited|com.docker.compose.project=runpanel-shop,com.docker.compose.oneoff=True",
        "runpanel-api,alias|paused|runpanel.managed=true,runpanel.project=api,runpanel.kind=app",
        "nobody|created|",
        "",
      ].join("\n")
    );
    r.check("every container is a row", rows.length === 4, String(rows.length));
    r.check("the stack is read from its label", rows[0].composeProject === "runpanel-shop");
    r.check("a compose run is told apart", !rows[0].oneOff && rows[1].oneOff);
    r.check("all the names of a container are kept", rows[2].names.join() === "runpanel-api,alias");
    r.check("labels come through", rows[2].labels["runpanel.kind"] === "app");
    r.check("a container with no labels is still a row", rows[3].state === "created" && rows[3].composeProject === "");
  }

  // --- facts and process info ------------------------------------------------
  {
    const now = Date.parse("2026-11-07T12:00:10.000Z");
    const id = "a".repeat(64);
    const facts = parseContainerFacts(
      [
        `/runpanel-up|true|2026-11-07T12:00:00.000Z|4242|${id}`,
        `/runpanel-down|false|2026-11-07T11:00:00.000Z|0|${id}`,
      ].join("\n"),
      now
    );
    const up = facts.get("runpanel-up");
    r.check("the leading slash is gone", facts.has("runpanel-up"));
    r.check("uptime comes from the start", up.uptime === 10, String(up.uptime));
    r.check("the id is shortened like the driver does", up.containerId.length === 12);
    r.check("a stopped container has no uptime", facts.get("runpanel-down").uptime === undefined);

    const usage = { cpu: 1.5, memory: 2048 };
    const info = appProcessInfo(up, usage);
    r.check(
      "a running app has the fields of the driver",
      info.running && info.pid === 4242 && info.uptime === 10 && info.cpu === 1.5 && info.memory === 2048
    );
    r.check("a stopped app keeps its id", !appProcessInfo(facts.get("runpanel-down"), null).running);
    r.check("no container is not running", appProcessInfo(undefined, null).running === false);
  }

  // --- what a stack adds up to ------------------------------------------------
  {
    const usage = new Map([
      ["runpanel-shop-web-1", { cpu: 1.25, memory: 100 }],
      ["custom-name", { cpu: 2, memory: 50 }],
      // Both start with `runpanel-shop`, and neither belongs to the stack.
      ["runpanel-shop-api", { cpu: 40, memory: 9000 }],
      ["runpanel-shop2-web-1", { cpu: 40, memory: 9000 }],
    ]);
    const read = (name) => usage.get(name) ?? null;

    const sum = sumContainerUsage(["runpanel-shop-web-1", "custom-name"], read);
    r.check("a stack sums its own containers, container_name included", sum.memory === 150, JSON.stringify(sum));
    r.check("and nothing that only shares the prefix", sum.cpu === 3.3, JSON.stringify(sum));
    r.check("no readings means no figure, not zero", sumContainerUsage(["gone"], read).cpu === undefined);

    const stack = (...states) => states.map((state, i) => ({ names: [`c${i}`], state }));
    r.check("a stack with nothing is down", !stackProcessInfo([], read).running);
    r.check("a stack is up when all of it is", stackProcessInfo(stack("running", "running"), read).running);
    r.check("one dead container is a stack down", !stackProcessInfo(stack("running", "exited"), read).running);
    r.check("a paused one is not, a backup does that", stackProcessInfo(stack("running", "paused"), read).running);
  }

  // --- parsing a directory -----------------------------------------------------
  {
    const output = ["f\tb.txt", "d\ta dir", "f\ta  b", "o\tbroken", "d\tbin", "=", "12\n7\n"].join("\0");
    const entries = parseDirectoryListing(output);
    r.check("directories come first", entries[0].name === "a dir" && entries[1].name === "bin");
    r.check("a double space survives", entries.some((e) => e.name === "a  b" && e.type === "file"));
    r.check("sizes follow their files", entries.find((e) => e.name === "b.txt").size === 12);
    r.check("and in order", entries.find((e) => e.name === "a  b").size === 7);
    r.check("something unknown is a file with no size", entries.find((e) => e.name === "broken").size === 0);

    const newline = parseDirectoryListing(["f\tone\ntwo", "=", "3\n"].join("\0"));
    r.check("a newline in a name is part of the name", newline[0]?.name === "one\ntwo");

    const missing = parseDirectoryListing(["f\ta", "f\tb", "=", "3\n"].join("\0"));
    r.check("a short list of sizes is dropped, not misassigned", missing.every((e) => e.size === 0));
    r.check("an empty directory is an empty list", parseDirectoryListing("=\0").length === 0);
  }

  // --- the script itself, on real shells ---------------------------------------
  {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "rp-listing-"));
    const write = (name, content) => fs.writeFileSync(join(dir, name), content);
    write("a  b", "12345");
    write(".hidden", "1");
    write("-dash", "22");
    write("..dots", "333");
    fs.mkdirSync(join(dir, "folder"));
    write("$(touch pwned)", "x");

    // A junction needs no privilege on Windows, so the directory cases run there
    // too. A link to a file does, and is skipped where it cannot be made.
    const dirLink = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(join(dir, "folder"), join(dir, "to-dir"), dirLink);
    fs.symlinkSync(join(dir, "nowhere"), join(dir, "broken"), dirLink);

    let fileLink = false;
    try {
      fs.symlinkSync(join(dir, "a  b"), join(dir, "to-file"), "file");
      fileLink = true;
    } catch {
      r.note("links to files not available here: that check is skipped");
    }

    const shells = ["sh", "dash"].filter((shell) => spawnSync(shell, ["-c", "exit 0"]).status === 0);
    r.check("at least one POSIX shell to run the script with", shells.length > 0);

    for (const shell of shells) {
      const list = (path) =>
        spawnSync(shell, ["-c", LIST_DIRECTORY_SCRIPT, "sh", path], { encoding: "utf8" });
      const result = list(dir);
      const entries = parseDirectoryListing(result.stdout);
      const named = (name) => entries.find((e) => e.name === name);

      r.check(`${shell}: the script succeeds`, result.status === 0, String(result.status));
      r.check(`${shell}: a double space survives`, named("a  b")?.size === 5, JSON.stringify(named("a  b")));
      r.check(`${shell}: hidden files are listed`, named(".hidden")?.size === 1);
      r.check(`${shell}: so are names like ..dots`, named("..dots")?.size === 3);
      r.check(`${shell}: a leading dash is only a name`, named("-dash")?.size === 2);
      r.check(`${shell}: a directory is a directory`, named("folder")?.type === "dir");
      r.check(`${shell}: . and .. are not entries`, !named(".") && !named(".."));
      r.check(`${shell}: a name is never executed`, !fs.existsSync(join(dir, "pwned")) && !!named("$(touch pwned)"));

      r.check(`${shell}: a link to a directory can be opened`, named("to-dir")?.type === "dir");
      r.check(`${shell}: a broken link is still listed`, named("broken")?.type === "file");
      if (fileLink) {
        r.check(`${shell}: a link to a file has the size of the file`, named("to-file")?.size === 5);
      }

      r.check(
        `${shell}: a path that is not there has its own exit code`,
        list(join(dir, "missing")).status === LIST_DIRECTORY_NOT_FOUND
      );
      r.check(
        `${shell}: a path with quotes is only a path`,
        list(`${dir}/x"; touch pwned; "`).status === LIST_DIRECTORY_NOT_FOUND && !fs.existsSync(join(dir, "pwned"))
      );

      const empty = join(dir, "folder");
      r.check(`${shell}: an empty directory lists nothing`, parseDirectoryListing(list(empty).stdout).length === 0);

      // Past one batch of `stat`: the sizes are paired by position.
      const many = join(dir, "many");
      fs.mkdirSync(many, { recursive: true });
      for (let i = 0; i < 450; i++) fs.writeFileSync(join(many, `f${i}`), "ab");
      const listed = parseDirectoryListing(list(many).stdout);
      r.check(`${shell}: sizes survive several batches`, listed.length === 450 && listed.every((e) => e.size === 2), String(listed.length));
    }

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- the stats stream runs only while someone reads ---------------------------
  {
    const fake = fakeStats();
    const stats = new StatsCollector(fake.source, { idleStopMs: 80, restartDelayMs: 10 });

    await stats.ensureStarted();
    r.check("the first read starts the stream", fake.spawns === 1 && stats.streaming);

    await stats.ensureStarted();
    r.check("further reads share it", fake.spawns === 1);

    fake.emit(statsLine("runpanel-shop"));
    fake.emit(JSON.stringify({ Name: "--" }));
    r.check("a line reaches the cache", stats.get("runpanel-shop")?.memory === 1024 ** 2);
    r.check("a placeholder row does not", stats.get("--") === null);

    // Reads keep it alive past the idle limit.
    const reading = Date.now() + 200;
    while (Date.now() < reading) {
      stats.get("runpanel-shop");
      await sleep(10);
    }
    r.check("a stream with readers keeps running", fake.stops === 0 && stats.streaming);

    r.check("with no readers it stops", await until(() => fake.stops === 1));
    r.check("and the process is gone", !stats.streaming);

    const spawnsBefore = fake.spawns;
    await sleep(120);
    r.check("and it stays stopped", fake.spawns === spawnsBefore);

    r.check("the cache went with it", stats.all().length === 0);
    r.check("the next read brings it back", await until(() => fake.spawns === spawnsBefore + 1));
    stats.shutdown();
  }

  // The background sweep asks every driver, for ever. That is not a reader.
  {
    const fake = fakeStats();
    const stats = new StatsCollector(fake.source, { idleStopMs: 60, restartDelayMs: 10 });

    await stats.ensureStarted();
    fake.emit(statsLine("runpanel-shop"));
    r.check("a look sees what was collected", stats.peek("runpanel-shop")?.memory === 1024 ** 2);

    const looking = Date.now() + 200;
    while (Date.now() < looking && stats.streaming) {
      stats.peek("runpanel-shop");
      await sleep(10);
    }
    r.check("a look does not keep the stream open", !stats.streaming);

    const spawnsBefore = fake.spawns;
    stats.peek("runpanel-shop");
    await sleep(30);
    r.check("nor does it start one", fake.spawns === spawnsBefore && !stats.streaming);
    stats.shutdown();
  }

  {
    const fake = fakeStats();
    const stats = new StatsCollector(fake.source, { idleStopMs: 200, restartDelayMs: 10 });

    await stats.ensureStarted();
    fake.exit();
    r.check("a stream that dies with readers comes back", await until(() => fake.spawns === 2));
    stats.shutdown();
  }

  {
    const fake = fakeStats();
    const stats = new StatsCollector(fake.source, { idleStopMs: 40, restartDelayMs: 5 });

    await stats.ensureStarted();
    await sleep(60);
    const spawns = fake.spawns;
    // Between the last read and the idle check the process can die on its own.
    fake.exit();
    await sleep(60);
    r.check("a stream that dies with no readers does not", fake.spawns === spawns, String(fake.spawns));
    stats.shutdown();
  }

  {
    const fake = fakeStats();
    fake.source.available = async () => false;
    const stats = new StatsCollector(fake.source, { idleStopMs: 40, restartDelayMs: 5 });

    await stats.ensureStarted();
    r.check("no daemon means no stream, and no error", fake.spawns === 0 && !stats.streaming);
    stats.shutdown();
  }

  return r.result();
}
