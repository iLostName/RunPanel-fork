#!/usr/bin/env node
/**
 * Test runner.
 *
 *   npm test                       everything the machine can run
 *   npm test -- store sessions     only the named suites
 *   npm test -- --no-docker        skip suites that need a Docker daemon
 *   npm test -- --no-pm2           skip suites that need PM2 installed
 *   npm test -- --driver postgres  only the Postgres pass
 *
 * Postgres suites need RUNPANEL_TEST_PG_URL, e.g.
 *   docker run -d --name rp-test-pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=runpanel -e POSTGRES_DB=runpanel_test -p 55432:5432 postgres:18-alpine
 *   RUNPANEL_TEST_PG_URL=postgresql://runpanel:test@127.0.0.1:55432/runpanel_test npm test
 *
 * Each suite gets its own server on its own data directory. Several of them
 * change the admin password or call first-run setup, so sharing an instance
 * made later suites fail for reasons unrelated to the code under test.
 */
import { dockerAvailable, pm2Available, startServer } from "./harness.mjs";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));

// `--driver postgres` takes a value, and that value is not a suite name. It was
// being collected into `requested` all the same, which filters suites by name —
// so the documented invocation matched nothing and ran zero tests while
// reporting success. Any option that takes a value has to be dropped here
// together with it.
const driverIndex = args.indexOf("--driver");
const driverFilter = driverIndex >= 0 ? (args[driverIndex + 1] ?? null) : null;
// `driverIndex + 1` is only a value position when the flag is actually present:
// with no `--driver`, indexOf returns -1 and that expression is 0, which would
// silently swallow the first suite name instead.
const driverValueIndex = driverIndex >= 0 ? driverIndex + 1 : -1;
const requested = args.filter(
  (a, index) => !a.startsWith("--") && index !== driverValueIndex
);

const pgUrl = process.env.RUNPANEL_TEST_PG_URL ?? null;
const hasDocker = !flags.has("--no-docker") && dockerAvailable();
// PM2 is not vendored — the README tells operators to install it globally — so
// its absence is a normal state of a machine, not a broken checkout. Treated
// like Docker: reported, and the suites that need it are skipped rather than
// failed.
const hasPm2 = !flags.has("--no-pm2") && pm2Available();

console.log(`RunPanel test suite`);
console.log(`  docker:   ${hasDocker ? "available" : "skipped"}`);
console.log(`  pm2:      ${hasPm2 ? "available" : "skipped (npm i -g pm2)"}`);
console.log(`  postgres: ${pgUrl ? "configured" : "not configured (set RUNPANEL_TEST_PG_URL)"}`);
console.log("");

const suiteFiles = readdirSync(join(HERE, "suites")).filter((f) => f.endsWith(".mjs")).sort();
const results = [];
const skipped = [];

/*
  A promise rejected with nobody listening, or an `error` event nobody
  handles, ends a Node process — here, the whole run, with every result
  collected so far. Standalone suites share this process, so one stray
  rejection from code under test cost the report of a hundred suites and
  said only which error, not where it came from. It is recorded instead as a
  failure of the suite that was running, with its stack, and the run goes on:
  still red, but readable.
*/
let currentSuite = "(between suites)";
const strays = [];
const recordStray = (kind) => (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  strays.push({ suite: currentSuite, description: `${kind} during the suite`, detail });
  console.log(`    FAIL ${kind} in ${currentSuite}  <- ${detail.split("\n").slice(0, 6).join(" | ")}`);
};
process.on("unhandledRejection", recordStray("unhandled rejection"));
process.on("uncaughtException", recordStray("uncaught exception"));

function withStrays(result) {
  const mine = strays.filter((stray) => stray.suite === currentSuite);
  if (mine.length === 0) return result;
  for (const stray of mine) strays.splice(strays.indexOf(stray), 1);
  return {
    ...result,
    failed: result.failed + mine.length,
    failures: [...result.failures, ...mine.map(({ description, detail }) => ({ description, detail }))],
  };
}

for (const file of suiteFiles) {
  const suite = await import(pathToFileURL(join(HERE, "suites", file)).href);
  const { meta, run } = suite;

  if (requested.length > 0 && !requested.includes(meta.name)) continue;
  currentSuite = meta.name;

  if (meta.needsDocker && !hasDocker) {
    skipped.push(`${meta.name} (needs docker)`);
    continue;
  }

  if (meta.needsPm2 && !hasPm2) {
    skipped.push(`${meta.name} (needs pm2)`);
    continue;
  }

  // Pure suites need no server at all.
  if (meta.standalone) {
    console.log(`▸ ${meta.name}`);
    const result = await run({ repoRoot: REPO_ROOT });
    // A stray from this suite may surface a tick after it returned.
    await new Promise((resolve) => setImmediate(resolve));
    results.push(withStrays(result));
    console.log("");
    continue;
  }

  const drivers = (meta.drivers ?? ["sqlite"]).filter((d) => {
    if (driverFilter && d !== driverFilter) return false;
    if (d === "postgres" && !pgUrl) return false;
    return true;
  });

  if (drivers.length === 0) {
    skipped.push(`${meta.name} (no eligible driver)`);
    continue;
  }

  for (const driver of drivers) {
    console.log(`▸ ${meta.name} [${driver}]`);
    let server;
    try {
      server = await startServer({
        driver,
        databaseUrl: driver === "postgres" ? pgUrl : undefined,
        // A suite that needs the server configured a particular way says so in
        // its own meta, rather than the harness growing a flag per suite. A
        // function is called first, for a suite that stands up a fake of some
        // outside service and has to tell the server where it listens.
        env: typeof meta.env === "function" ? await meta.env() : (meta.env ?? {}),
      });
      const result = await run({ base: server.base, dataDir: server.dataDir, repoRoot: REPO_ROOT });
      results.push({ ...withStrays(result), name: `${result.name} [${driver}]` });
    } catch (err) {
      console.log(`    FAIL suite crashed: ${err instanceof Error ? err.message : err}`);
      results.push({ name: `${meta.name} [${driver}]`, passed: 0, failed: 1, failures: [{ description: "suite crashed", detail: String(err) }] });
    } finally {
      await server?.stop();
    }
    console.log("");
  }
}

// Strays that surfaced after their suite had already been reported.
await new Promise((resolve) => setImmediate(resolve));
if (strays.length > 0) {
  results.push({
    name: "(stray errors)",
    passed: 0,
    failed: strays.length,
    failures: strays.map(({ suite, description, detail }) => ({ description: `${description} (${suite})`, detail })),
  });
}

// --- summary ----------------------------------------------------------------
const totalPassed = results.reduce((n, x) => n + x.passed, 0);
const totalFailed = results.reduce((n, x) => n + x.failed, 0);

console.log("─".repeat(60));
for (const result of results) {
  const mark = result.failed === 0 ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${result.name.padEnd(30)} ${result.passed} passed, ${result.failed} failed`);
}
for (const item of skipped) console.log(`  SKIP  ${item}`);
console.log("─".repeat(60));
console.log(`  ${totalPassed} passed, ${totalFailed} failed`);

if (totalFailed > 0) {
  console.log("");
  for (const result of results.filter((x) => x.failed > 0)) {
    for (const failure of result.failures) {
      console.log(`  ${result.name}: ${failure.description}${failure.detail ? ` — ${failure.detail}` : ""}`);
    }
  }
}

process.exit(totalFailed > 0 ? 1 : 0);
