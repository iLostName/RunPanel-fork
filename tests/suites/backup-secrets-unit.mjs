import { createReporter } from "../harness.mjs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join, relative, sep } from "node:path";
import fs from "node:fs";
import os from "node:os";

/**
 * What a backup leaves readable, and who may put one back.
 *
 * Three things that look fine from the behaviour of the panel: a password on the
 * docker client's command line works, and `ps` shows it to every local user; a
 * `summary.json` with a token in it reads like a summary; a restore that turns a
 * plain container into a host process reports success.
 *
 * The docker calls themselves need a daemon, so the argv is checked where it is
 * built and the source is held to the shape that keeps it that way.
 */
export const meta = { name: "backup-secrets-unit", needsDocker: false, drivers: [], standalone: true };

const SECRET = `pa"ss\\w$(touch /tmp/x)'rd`;

const target = {
  containerName: "runpanel-svc-db",
  credentials: { user: "app", password: SECRET, database: "app" },
};

/** Calls that still put a value on argv, in files another change has to reach. */
// Only the planner's rare leftovers: a multi-line value under a name the docker
// client reads itself (see lib/docker-env.ts).
const KNOWN_ENV_ON_ARGV = new Set(["services/docker/env-file.ts"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

export async function run({ repoRoot }) {
  const r = createReporter("backup-secrets-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const read = (...parts) => fs.readFileSync(join(repoRoot, ...parts), "utf8");

  const { envFlags, execArgs, mongoShellCall, mongoToolCall, postgresOwnRoleFilter, postgresRestoreCommand } = await load(
    "lib",
    "service-exec.ts"
  );
  const { projectBackupSummary } = await load("lib", "project-redact.ts");
  const { stripRemoteCredentials } = await load("lib", "git-remote.ts");
  const { configRestoreProblem } = await load("lib", "restore-gate.ts");
  const { execToFile, execFromFile } = await load("services", "stream-exec.ts");

  const onArgv = (argv, value) => argv.some((arg) => arg.includes(value));

  // --- names on argv, values in the environment --------------------------------
  {
    const env = { PGPASSWORD: SECRET };
    const args = execArgs(target, env);
    r.check("execArgs names the variable", args.join(" ") === "exec -e PGPASSWORD runpanel-svc-db", args.join(" "));
    r.check("execArgs leaves the value off argv", !onArgv(args, SECRET));
    r.check("no key and no flag when there is nothing to pass", execArgs(target, {}).join(" ") === "exec runpanel-svc-db");
    r.check(
      "an interactive session keeps -i ahead of the container",
      execArgs(target, env, { interactive: true }).join(" ") === "exec -i -e PGPASSWORD runpanel-svc-db"
    );
    r.check("envFlags carries no value either", envFlags(env).join(" ") === "-e PGPASSWORD");
  }

  // --- Mongo, which has no password variable -----------------------------------
  {
    const dump = mongoToolCall(target, ["mongodump", "--archive", "--gzip", "--db", "app"]);
    const full = [...execArgs(target, dump.env), ...dump.argv];
    r.check("mongodump gets no password on the client's argv", !onArgv(full, SECRET));
    r.check("mongodump gets no -p at all", !dump.argv.includes("-p"));
    r.check(
      "mongodump keeps its own arguments",
      ["--archive", "--gzip", "--db", "app", "-u", "--authenticationDatabase"].every((arg) => dump.argv.includes(arg))
    );
    r.check("the password travels in the environment", Object.values(dump.env).join("").includes("password: "));

    const { yamlString } = await load("lib", "service-exec.ts");
    const odd = 'a"b\\c\u0085d\u2028e\u0090f😀g';
    const written = yamlString(odd);
    r.check("a YAML string carries nothing YAML reads as a line break", /^[\x20-\x7e]+$/.test(written), written);
    r.check("and reads back as the same password", JSON.parse(written.replace(/\\U([0-9a-f]{8})/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))) === odd);

    const shell = mongoShellCall(target, "mongosh", { database: "app", script: "db.stats()" });
    r.check("mongosh gets no password on the client's argv", !onArgv([...execArgs(target, shell.env), ...shell.argv], SECRET));
    r.check("the value is in the environment of the docker process", Object.values(shell.env).includes(SECRET));
    r.check("nor on any argv inside the container: mongosh reads it itself", !shell.argv.some((arg) => arg.includes("-p")) && shell.argv.join(" ").includes("process.env."));
    r.check("a user name cannot break out of the script", mongoShellCall({ ...target, credentials: { ...target.credentials, user: 'a"); x("' } }, "mongosh", {}).argv.join(" ").includes(JSON.stringify('a"); x("')));

    const legacy = mongoShellCall(target, "mongo", { database: "app", shell: true });
    r.check("the old client expands it in the container", !onArgv(legacy.argv, SECRET) && legacy.argv.includes("--shell"));

    const anonymous = { ...target, credentials: { user: "", password: "", database: "" } };
    const open = mongoShellCall(anonymous, "mongosh", {});
    r.check("without a user there is no wrapper", open.argv.join(" ") === "mongosh --quiet" && Object.keys(open.env).length === 0);
  }

  // --- build arguments sealed at rest --------------------------------------------------
  {
    const { sealContractJson, openBuildEnv, openContractJson, SEALED_PREFIX } = await load("lib", "build-env-seal.ts");
    const lock = (s) => Buffer.from(s, "utf8").toString("base64");
    const unlock = (s) => Buffer.from(s, "base64").toString("utf8");

    const stored = sealContractJson(JSON.stringify({ version: 1, buildEnv: { TOKEN: SECRET, EMPTY: "" } }), lock);
    r.check("a stored build argument is not in the clear", !stored.includes(SECRET) && stored.includes(SEALED_PREFIX));
    r.check("sealing twice changes nothing", sealContractJson(stored, lock) === stored);
    r.check("a contract with none is left as it is", sealContractJson('{"version":1}', lock) === '{"version":1}');
    r.check("an unreadable column is left as it is", sealContractJson("{", lock) === "{");

    const opened = openBuildEnv(JSON.parse(stored).buildEnv, unlock);
    r.check("a build reads it back", opened.TOKEN === SECRET && opened.EMPTY === "");
    r.check("a repository's own value passes through", openBuildEnv({ A: "plain" }, unlock).A === "plain");
    let named = "";
    try {
      openBuildEnv({ KEY_X: `${SEALED_PREFIX}xx` }, () => {
        throw new Error("bad key");
      });
    } catch (err) {
      named = err.message;
    }
    r.check("another panel's key fails naming the variable", named.includes("KEY_X"));
    r.check(
      "build arguments have a key of their own, per project",
      read("services", "build-env.ts").includes("`build-env:${projectId}`") && read("lib", "crypto.ts").includes("hkdfSync")
    );
    r.check("an export opens it inside the encrypted document", JSON.parse(openContractJson(stored, unlock)).buildEnv.TOKEN === SECRET);

    const route = read("app", "api", "projects", "[projectId]", "route.ts");
    r.check("the settings route seals what it writes", /updates\.builder_config = sealContract\(/.test(route));
    const pipeline = read("services", "deploy-pipeline.ts");
    r.check("a deploy opens them for the build only", pipeline.includes("buildEnv: openBuildEnv(contract.buildEnv, project.id)") && pipeline.includes("selectBuildEnv(readable, envVars)"));
    r.check("the recorded contract stays sealed", pipeline.includes("resolved_contract: JSON.stringify(contract)"));
    r.check("a restore seals again", read("services", "backup", "restore.ts").includes("builder_config: sealContract(payload.project.builder_config, targetId)"));
    r.check("what was stored before is sealed at boot", read("instrumentation.ts").includes("sealStoredBuildEnv()"));
  }

  // --- a project's environment off argv ----------------------------------------------------
  {
    const { planDockerEnv } = await load("lib", "docker-env.ts");
    const plan = planDockerEnv({
      DATABASE_URL: `postgres://u:${SECRET}@db/app`,
      PEM: "a\nb",
      DOCKER_HOST: "x\ny",
      EMPTY: "",
      HASH: "a # b",
      LD_PRELOAD: "/x.so:\n",
      LONG: "x".repeat(70_000),
    });
    r.check("one-line values go in the env file", plan.file.includes(`DATABASE_URL=postgres://u:${SECRET}@db/app\n`) && plan.file.includes("EMPTY=\n"));
    r.check("a line break stays on argv, as before", plan.inline.PEM === "a\nb" && !plan.file.includes("PEM="));
    r.check("so does a line past the client's limit", !plan.file.includes("LONG=") && plan.inline.LONG?.length === 70_000);
    r.check("no name ever reaches the client's own environment", !("byName" in plan));
    r.check("no variables, no file", planDockerEnv({}).file === "");
    for (const file of [["services", "process-drivers", "docker-driver.ts"], ["services", "deploy-steps.ts"], ["services", "builders", "docker-builder.ts"]]) {
      r.check(`${file.at(-1)} gives the client no project names`, !read(...file).includes("clientEnv"));
    }

    for (const file of [["services", "process-drivers", "docker-driver.ts"], ["services", "deploy-steps.ts"]]) {
      const text = read(...file);
      r.check(`${file.at(-1)} keeps values off argv`, text.includes("withDockerEnv(opts.env") && !text.includes('"-e", `${key}=${value}`'));
    }
    const provisioner = read("services", "service-provisioner.ts");
    r.check("redis gets its password by name", !provisioner.includes('"--requirepass", config.credentials.password') && provisioner.includes("REDIS_PASSWORD_VAR"));
  }

  r.check("the data directory is closed to other accounts", /for \(const dir of \[config\.dataDir,/.test(read("lib", "config.ts")));

  const folders = read("app", "api", "folders", "route.ts");
  r.check("a folder grants nothing to whoever creates it", !folders.includes("grantCreator"));
  r.check("only an account that sees everything creates one", folders.indexOf("seesEverything(denied.principal)") < folders.indexOf("insertInto(\"folders\")"));

  // --- restoring a whole Postgres server ------------------------------------------------
  // Run through a real `sed`, as the restore does. The script is what `pg_dumpall
  // --clean --if-exists` writes, and the line after `-- Databases` is table data
  // that happens to look like a statement.
  if (spawnSync("sed", ["--version"]).error === undefined) {
    const script = [
      "\\connect template1",
      "DROP DATABASE IF EXISTS app;",
      "DROP ROLE IF EXISTS other;",
      "DROP ROLE IF EXISTS runpanel;",
      'DROP ROLE IF EXISTS "runpanel";',
      "CREATE ROLE other;",
      "CREATE ROLE runpanel;",
      "ALTER ROLE other WITH NOSUPERUSER PASSWORD 'x';",
      "ALTER ROLE runpanel WITH SUPERUSER PASSWORD 'y';",
      "-- Databases",
      "DROP ROLE IF EXISTS runpanel;",
      "",
    ].join("\n");
    const filtered = spawnSync("sed", ["-e", postgresOwnRoleFilter("runpanel")], {
      input: script,
      encoding: "utf8",
    }).stdout.split("\n");

    r.check("the role being restored as is not dropped", filtered.filter((l) => /^DROP ROLE.*runpanel/.test(l)).length === 1);
    r.check("nor created again", !filtered.includes("CREATE ROLE runpanel;"));
    r.check("nor given the archive's password", !filtered.some((l) => l.startsWith("ALTER ROLE runpanel")));
    r.check(
      "every other role and the databases are left alone",
      ["DROP DATABASE IF EXISTS app;", "DROP ROLE IF EXISTS other;", "CREATE ROLE other;"].every((l) => filtered.includes(l)) &&
        filtered.some((l) => l.startsWith("ALTER ROLE other"))
    );
    r.check("past the marker it is data and stays", filtered.at(-2) === "DROP ROLE IF EXISTS runpanel;", filtered.join("|"));
    r.check(
      "a user name is matched literally",
      spawnSync("sed", ["-e", postgresOwnRoleFilter("a.b")], { input: "CREATE ROLE axb;\n", encoding: "utf8" }).stdout ===
        "CREATE ROLE axb;\n"
    );
    r.check(
      "a quote in a user name is matched as pg_dumpall writes it",
      spawnSync("sed", ["-e", postgresOwnRoleFilter('a"b')], { input: 'DROP ROLE IF EXISTS "a""b";\n', encoding: "utf8" }).stdout === ""
    );
  } else {
    r.note("sed not available: the Postgres filter was not run");
  }

  // A pg_dump has no `-- Databases` line, so the filter would reach its table data.
  r.check("a single database goes straight to psql", postgresRestoreCommand("u", "pg_dump")[0] === "psql");
  r.check("a whole server goes through the filter", postgresRestoreCommand("u", "pg_dumpall")[0] === "sh");
  r.check("and so does an archive that does not say", postgresRestoreCommand("u", undefined)[0] === "sh");

  {
    const restore = fs.readFileSync(join(repoRoot, "services", "backup", "restore.ts"), "utf8");
    const body = restore.slice(restore.indexOf("async function restoreDatabase"), restore.indexOf("async function restoreRedis"));
    const feeds = [...body.matchAll(/dockerFromFile\(\s*\[\s*\.\.\.execArgs\(target, env(.*?)\)/g)];
    r.check("a restore feeds three engines through stdin", feeds.length === 3, String(feeds.length));
    r.check(
      "and each of them attaches it: without -i the dump never arrives",
      feeds.every((match) => match[1].includes("interactive: true"))
    );
  }

  // The wrappers are real shell, so they are run: `sh` stands in for the tool.
  if (spawnSync("sh", ["-c", "exit 0"]).status === 0) {
    const fake = 'for a; do l=$a; done; f=${l#--config=}; cat "$f"; echo "stdin=$(cat)"; echo "$f" >&2; exit 7';
    const { env, argv } = mongoToolCall(target, ["sh", "-c", fake, "tool"]);
    const ran = spawnSync(argv[0], argv.slice(1), {
      input: "archive-bytes",
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    const [yaml, stdin] = ran.stdout.trim().split("\n");
    r.check("the tool reads the password back unchanged", JSON.parse(yaml.replace(/^password: /, "")) === SECRET, ran.stdout);
    r.check("the tool still owns stdin", stdin === "stdin=archive-bytes", stdin);
    r.check("the tool's exit code comes back", ran.status === 7, String(ran.status));

    const leftover = spawnSync("sh", ["-c", 'test -e "$1"', "sh", ran.stderr.trim()]);
    r.check("the config file is gone afterwards", leftover.status !== 0, ran.stderr);

    const scratch = fs.mkdtempSync(join(os.tmpdir(), "rp-mongo-client-"));
    try {
      const printer = join(scratch, "client").split(sep).join("/");
      fs.writeFileSync(printer, '#!/bin/sh\nfor a; do echo "$a"; done\n', { mode: 0o755 });
      const client = mongoShellCall(target, printer, { database: "my db", script: 'print("$HOME")' });
      const printed = spawnSync(client.argv[0], client.argv.slice(1), {
        encoding: "utf8",
        env: { ...process.env, ...client.env },
      });
      const seen = printed.stdout.trim().split("\n");
      r.check("the client gets the password as one argument", seen[0] === "-p" && seen[1] === SECRET, printed.stdout + printed.stderr);
      r.check("the rest of its argv arrives unparsed", seen.includes("my db") && seen.includes('print("$HOME")'), printed.stdout);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    r.note("sh not available: wrappers not executed");
  }

  // --- the environment reaches the child ---------------------------------------
  {
    const scratch = fs.mkdtempSync(join(os.tmpdir(), "rp-backup-secrets-"));
    try {
      const child = ["-e", "process.stdout.write(process.env.RP_PROBE ?? 'unset')"];
      const out = join(scratch, "out");
      await execToFile(process.execPath, child, out, { env: { ...process.env, RP_PROBE: "seen" } });
      r.check("a streamed call hands env to its child", fs.readFileSync(out, "utf8") === "seen", fs.readFileSync(out, "utf8"));

      const input = join(scratch, "in");
      fs.writeFileSync(input, "");
      const fed = await execFromFile(process.execPath, child, input, { env: { ...process.env, RP_PROBE: "seen" } });
      r.check("a call fed from a file hands env to its child", fed.stdoutTail === "seen", fed.stdoutTail);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    const cli = read("services", "docker", "cli.ts");
    r.check(
      "docker() and the streaming helpers merge env over the sanitised base",
      (cli.match(/\.\.\.sanitizedProcessEnv\(\), \.\.\.\(dockerConfigEnv\(\) \?\? \{\}\), \.\.\.\(opts\.env \?\? \{\}\)/g) ?? []).length === 2
    );
  }

  // --- no caller goes back to the old shape ------------------------------------
  {
    const files = sourceFiles(join(repoRoot, "services")).map((file) => ({
      name: relative(repoRoot, file).split(sep).join("/"),
      text: fs.readFileSync(file, "utf8"),
    }));

    const valued = files.filter((f) => /"-e",\s*`[^`]*=\$\{/.test(f.text) && !KNOWN_ENV_ON_ARGV.has(f.name));
    r.check("no `-e KEY=value` outside the known files", valued.length === 0, valued.map((f) => f.name).join(", "));

    const passworded = files.filter((f) => /"-p",\s*(?:password|[\w.]*credentials\.password)/.test(f.text));
    r.check("no `-p <password>` on argv", passworded.length === 0, passworded.map((f) => f.name).join(", "));

    // A literal cannot also be handed to the docker call, so it is always a bug.
    const inline = files.filter((f) => /execArgs\((?:[^(),]|\([^()]*\))+,\s*(?:\{\s*[A-Z]|[^,)]+\?)/.test(f.text));
    r.check("execArgs never takes an inline environment", inline.length === 0, inline.map((f) => f.name).join(", "));

    const forgotten = [];
    for (const file of files) {
      const names = new Set(
        [...file.text.matchAll(/execArgs\((?:[^(),]|\([^()]*\))+,\s*(\w+)[,)]|envFlags\((\w+)\)/g)].map((match) => match[1] ?? match[2])
      );
      for (const name of names) {
        const passed = new RegExp(`\\benv: [^\\n]*\\b${name}\\b|\\.\\.\\.${name} \\}|^\\s*${name},$|\\{ ${name}, `, "m");
        if (!passed.test(file.text)) forgotten.push(`${file.name}: ${name}`);
      }
    }
    r.check("what goes to execArgs also goes to the docker call", forgotten.length === 0, forgotten.join(", "));
  }

  // --- summary.json ------------------------------------------------------------
  {
    const row = {
      id: "p1",
      name: "Sito",
      slug: "sito",
      app_name: null,
      source_type: "github",
      source_url: "https://bot:ghp_token@github.com/acme/sito.git?access_token=qs_token",
      source_branch: "main",
      runtime_type: "docker",
      port: 3000,
      status: "running",
      builder_config: JSON.stringify({
        buildEnv: { NPM_TOKEN: "npm_secret" },
        installCommand: "npm config set _authToken=inline_secret",
      }),
      webhook_secret: "hook_secret",
      github_hook_id: "hook_id",
      created_at: "2026-11-07",
      updated_at: "2026-11-07",
      a_column_added_tomorrow: "future_secret",
    };

    const summary = projectBackupSummary(row, stripRemoteCredentials);
    const text = JSON.stringify(summary);

    for (const secret of ["npm_secret", "inline_secret", "ghp_token", "qs_token", "hook_secret", "future_secret"]) {
      r.check(`the summary leaves out ${secret}`, !text.includes(secret), text);
    }
    r.check("the repository stays readable", summary.source_url === "https://github.com/acme/sito.git", summary.source_url);
    r.check("build variables keep their names", summary.buildEnvKeys.join() === "NPM_TOKEN");
    r.check("what identifies the project survives", summary.slug === "sito" && summary.runtime_type === "docker");
    r.check(
      "a contract that does not parse costs only the names",
      projectBackupSummary({ ...row, builder_config: "{" }, stripRemoteCredentials).buildEnvKeys.length === 0
    );
    r.check("an upload has no url to clean", projectBackupSummary({ ...row, source_url: null }, stripRemoteCredentials).source_url === null);

    const exporter = read("services", "backup", "project-export.ts");
    r.check("the export builds the summary from the allowlist", /project: projectBackupSummary\(project,/.test(exporter));
    r.check("the row is never spread into it", !/project: \{ \.\.\.project/.test(exporter));
  }

  // --- restoring a configuration -----------------------------------------------
  {
    const source = { source_type: "github", source_url: "https://github.com/acme/a.git", source_branch: "main" };
    const none = { host: false, github: false };
    const host = { host: true, github: false };
    const all = { host: true, github: true };

    r.check("putting back the same source needs nothing", configRestoreProblem(none, source, { ...source }) === null);
    r.check(
      "another repository needs host",
      /Accesso all'host/.test(configRestoreProblem(none, source, { ...source, source_url: "https://github.com/acme/b.git" }) ?? "")
    );
    r.check("another branch needs host", /Accesso all'host/.test(configRestoreProblem(none, source, { ...source, source_branch: "dev" }) ?? ""));
    r.check("another source type needs host", /Accesso all'host/.test(configRestoreProblem(none, source, { ...source, source_type: "upload" }) ?? ""));
    r.check(
      "another repository also needs github",
      /GitHub/.test(configRestoreProblem(host, source, { ...source, source_url: "https://github.com/acme/b.git" }) ?? "")
    );
    r.check("another branch does not need github", configRestoreProblem(host, source, { ...source, source_branch: "dev" }) === null);
    r.check("both permissions are enough", configRestoreProblem(all, source, { ...source, source_url: null }) === null);

    const restore = read("services", "backup", "restore.ts");
    const gate = restore.indexOf("await refuseBeyondPermissions(request.principal");
    r.check("the gate runs in the restore", gate !== -1);
    r.check("the gate runs before the safety backup", gate < restore.indexOf("await takeSafetyBackup(planned"));
    r.check("the gate runs before any artifact is applied", gate < restore.indexOf("await restoreArtifact(artifact"));
    r.check("the gate asks requireHostIfReaching with the artifact's config", /requireHostIfReaching\([\s\S]{0,200}builderConfig: project\.builder_config/.test(restore));

    const access = read("lib", "backup-access.ts");
    r.check("a repository takes host before the restore starts", /"project-repo" && !hasPermission\(principal, "host"\)/.test(access));
    r.check("the route hands over who is asking", /principal: denied\.principal/.test(read("app", "api", "backups", "restore", "route.ts")));
  }

  // --- a policy pointed at nothing ---------------------------------------------
  // The list of destinations is looked up whole — each one, none twice, no two
  // in one place — through `destinationListError`, before anything is written.
  {
    const route = read("app", "api", "backups", "policies", "[policyId]", "route.ts");
    const check = route.indexOf("await destinationListError(");
    r.check("PUT looks the destinations up", check !== -1);
    r.check("and does so before writing", check !== -1 && check < route.indexOf('.updateTable("backup_policies")'));
    r.check("an unknown destination is a 404", /listProblem\.notFound \? 404/.test(route));
    const lookup = read("services", "backup", "policy-destinations.ts");
    r.check("the lookup reads the destinations themselves", lookup.includes('.selectFrom("backup_destinations")'));
    r.check("and says when one is not there", /"Destinazione non trovata", notFound: true/.test(read("lib", "backup-copies.ts")));
  }

  return r.result();
}
