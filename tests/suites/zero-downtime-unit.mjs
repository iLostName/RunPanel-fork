import { createReporter } from "../harness.mjs";
import { simulatedDocker } from "../simulated-docker.mjs";
import { loadTs } from "../ts-modules.mjs";

/**
 * Deploys without downtime, without Docker and without nginx.
 *
 * What is pinned here: the port a deploy gets, where the feature can work,
 * what each failure undoes (never the version online), which container stays
 * after a deploy cut short at every step, the whole sequence against a
 * simulated daemon, and the nginx block the switch writes — valid, and
 * different from the one before in the upstream and nothing else.
 *
 * Not exercised: a real daemon (the publish on 127.0.0.1, `docker rename`
 * keeping the network alias in step), a real `nginx -t` and reload through
 * the systemd path units, and a real request in flight across the switch.
 */
export const meta = { name: "zero-downtime-unit", needsDocker: false, drivers: [], standalone: true };

const SLUG = "shop";
const LIVE = "runpanel-shop";
const NEXT = "runpanel-shop_next";
const OLD = "runpanel-shop_old";

export async function run({ repoRoot }) {
  const r = createReporter("zero-downtime-unit");
  const zd = await loadTs(repoRoot, "lib", "zero-downtime.ts");
  const ops = await loadTs(repoRoot, "services", "docker", "zero-downtime.ts");
  const labels = await loadTs(repoRoot, "services", "docker", "labels.ts");
  const render = await loadTs(repoRoot, "services", "proxy", "render.ts");
  const access = await loadTs(repoRoot, "lib", "access-columns.ts");

  // --- ports ---------------------------------------------------------------------
  const { pickLivePort, LIVE_PORT_FIRST, LIVE_PORT_LAST } = zd;
  r.check("the range is below Linux's ephemeral ports and above the usual app ports", LIVE_PORT_FIRST > 9999 && LIVE_PORT_LAST < 32768);
  r.check("the first port of the range when nothing is taken", pickLivePort(new Set()) === LIVE_PORT_FIRST);
  r.check("a claimed port is skipped", pickLivePort(new Set([21000, 21001])) === 21002);
  r.check("the scan starts after the port the project is on now", pickLivePort(new Set([21005]), 21005) === 21006);
  r.check("and wraps around at the end of the range", pickLivePort(new Set([21999]), 21999) === 21000);
  r.check("a port outside the range as the current one starts from the top", pickLivePort(new Set(), 3000) === 21000);
  const full = new Set();
  for (let port = LIVE_PORT_FIRST; port <= LIVE_PORT_LAST; port++) full.add(port);
  r.check("no port when every one is taken", pickLivePort(full) === null);
  full.delete(21500);
  r.check("the only free one when it is the last", pickLivePort(full, 21700) === 21500);
  // The panel's port, another project's port, a service's: whatever is claimed.
  let leaked = 0;
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 300; round++) {
    const used = new Set();
    for (let i = 0; i < 40; i++) used.add(LIVE_PORT_FIRST + Math.floor(random() * 1000));
    const after = random() < 0.5 ? null : LIVE_PORT_FIRST + Math.floor(random() * 1000);
    const port = pickLivePort(used, after);
    if (port === null || used.has(port) || port < LIVE_PORT_FIRST || port > LIVE_PORT_LAST) leaked++;
  }
  r.check("never a claimed port, never outside the range (300 random cases)", leaked === 0, `${leaked} bad picks`);

  const used = (await loadTs(repoRoot, "lib", "ports.ts")).portsInUse([{ port: 3000, live_port: 21003 }, { port: 5432 }]);
  r.check("a project's live port counts as in use for the forms", used.has(21003) && used.has(3000));

  // --- where it can work -------------------------------------------------------------
  const base = {
    runtimeType: "docker",
    network: "project",
    healthcheck: { enabled: true, port: null },
    port: 3000,
    restricted: false,
    singleInstance: false,
    servedHosts: 1,
    proxyReady: true,
  };
  const blockers = (patch) => zd.zeroDowntimeBlockers({ ...base, ...patch });
  r.check("Docker, a port, the health check, an address and nginx: available", blockers({}).length === 0, blockers({}).join());
  r.check("compose is refused for its runtime alone", blockers({ runtimeType: "compose" }).join() === "runtime");
  r.check("native runtimes too", blockers({ runtimeType: "node" }).join() === "runtime");
  r.check("no health check, no switch", blockers({ healthcheck: { enabled: false } }).includes("healthcheck"));
  r.check("no port, nothing for nginx to reach", blockers({ port: null }).includes("port"));
  r.check("a health check on another port would ask the wrong container", blockers({ healthcheck: { enabled: true, port: 9000 } }).includes("healthcheck-port"));
  r.check("a health check on the app's own port is fine", blockers({ healthcheck: { enabled: true, port: 3000 } }).length === 0);
  r.check("host network: two containers cannot share the port", blockers({ network: "host" }).includes("network"));
  r.check("bridge network works", blockers({ network: "bridge" }).length === 0);
  r.check("an app that must run once is refused", blockers({ singleInstance: true }).includes("single-instance"));
  r.check("the panel's IP gate points at one listener", blockers({ restricted: true }).includes("restricted"));
  r.check("without an address nginx serves, the app is reached on its port", blockers({ servedHosts: 0 }).join() === "address");
  r.check("nginx not ready on this server", blockers({ proxyReady: false }).join() === "proxy");
  r.check(
    "every reason has its sentence",
    ["runtime", "healthcheck", "port", "healthcheck-port", "network", "single-instance", "restricted", "address", "proxy"].every(
      (key) => typeof zd.ZERO_DOWNTIME_BLOCKERS[key] === "string" && zd.ZERO_DOWNTIME_BLOCKERS[key].length > 20
    )
  );

  // --- the steps of a deploy: what a failure undoes --------------------------------------
  for (const phase of ["candidate", "health", "switch"]) {
    const outcome = zd.failureOutcome(phase);
    r.check(`a failure at "${phase}" removes the new container and fails the deploy`, outcome.removeCandidate && outcome.failed);
  }
  const stuck = zd.failureOutcome("switch", true);
  r.check("a switch nginx took but the store did not keeps the new container", !stuck.removeCandidate && stuck.failed);
  for (const phase of ["committed", "promoted", "drained"]) {
    const outcome = zd.failureOutcome(phase);
    r.check(`after "${phase}" nothing is undone and the deploy stays done`, !outcome.removeCandidate && !outcome.failed);
  }
  r.check("the version online is never touched, at any step", zd.RELEASE_PHASES.every((phase) => zd.failureOutcome(phase).touchLive === false));

  // --- one live container: the boot after a deploy cut short ---------------------------
  const names = ops.zdNames(SLUG);
  r.check("the three names", names.live === LIVE && names.next === NEXT && names.old === OLD);
  r.check("the deploy-only names cannot be another project's live name", !/^runpanel-[a-z0-9][a-z0-9-]*$/.test(NEXT) && !/^runpanel-[a-z0-9][a-z0-9-]*$/.test(OLD));

  const c = (name, deployment, livePort, state = "running") => ({ name, state, deployment, livePort });
  /** Carry out a plan on a list of containers, as `settle` does on a daemon. */
  const carryOut = (plan, containers) => {
    let list = containers.map((x) => ({ ...x }));
    for (const name of plan.remove) list = list.filter((x) => x.name !== name);
    for (const step of plan.renames) {
      if (list.some((x) => x.name === step.to)) throw new Error(`rename onto a taken name: ${step.to}`);
      const found = list.find((x) => x.name === step.from);
      if (!found) throw new Error(`rename of a missing container: ${step.from}`);
      found.name = step.to;
    }
    if (plan.retire) list = list.filter((x) => x.name !== plan.retire);
    return list;
  };
  const crash = (label, containers, liveDeployment, expect) => {
    const plan = zd.planSettle(names, containers, liveDeployment, { drain: false });
    const after = carryOut(plan, containers);
    const one = after.length === 1 && after[0].name === LIVE;
    r.check(
      `${label}: exactly one container, under the live name, of ${expect.deployment}`,
      one && after[0].deployment === expect.deployment,
      JSON.stringify(after)
    );
    r.check(`${label}: nginx is sent to ${expect.livePort}`, plan.livePort === expect.livePort, String(plan.livePort));
  };
  crash("nothing interrupted", [c(LIVE, "D1", 21000)], "D1", { deployment: "D1", livePort: 21000 });
  crash("cut short while the new one was checked", [c(LIVE, "D1", 21000), c(NEXT, "D2", 21001)], "D1", { deployment: "D1", livePort: 21000 });
  crash("cut short while it was starting (created, never run)", [c(LIVE, "D1", 21000), c(NEXT, "D2", 21001, "created")], "D1", {
    deployment: "D1",
    livePort: 21000,
  });
  crash("cut short during the nginx switch, before the commit", [c(LIVE, "D1", null), c(NEXT, "D2", 21001)], "D1", { deployment: "D1", livePort: null });
  crash("cut short after the commit, before the renames", [c(LIVE, "D1", 21000), c(NEXT, "D2", 21001)], "D2", { deployment: "D2", livePort: 21001 });
  crash("cut short between the two renames", [c(OLD, "D1", 21000), c(NEXT, "D2", 21001)], "D2", { deployment: "D2", livePort: 21001 });
  crash("cut short during the drain", [c(LIVE, "D2", 21001), c(OLD, "D1", 21000)], "D2", { deployment: "D2", livePort: 21001 });
  crash("a host reboot brought every container back", [c(LIVE, "D2", 21001), c(OLD, "D1", 21000), c(NEXT, "D3", 21002)], "D2", {
    deployment: "D2",
    livePort: 21001,
  });
  crash("a live container from before the labels, and a leftover candidate", [c(LIVE, null, null), c(NEXT, "D2", 21001)], "D1", {
    deployment: null,
    livePort: null,
  });
  crash("the old one removed by hand: the candidate is all that runs", [c(NEXT, "D2", 21001)], "D1", { deployment: "D2", livePort: 21001 });
  const empty = zd.planSettle(names, [], "D1", { drain: false });
  r.check("no container at all: nothing to do, the store's port stays", empty.keep === null && empty.livePort === undefined && empty.remove.length === 0);
  const strangers = zd.planSettle(names, [c("runpanel-shop-api", "X", null), c(LIVE, "D1", null)], "D1", { drain: false });
  r.check("another project's container is never in the plan", !strangers.remove.includes("runpanel-shop-api"));

  // The deploy's own path: the old one is renamed aside and drained, never removed first.
  const success = zd.planSettle(names, [c(LIVE, "D1", 21000), c(NEXT, "D2", 21001)], "D2", { drain: true });
  r.check(
    "after the commit: old aside, new under the live name, old drained",
    success.remove.length === 0 &&
      JSON.stringify(success.renames) === JSON.stringify([{ from: LIVE, to: OLD }, { from: NEXT, to: LIVE }]) &&
      success.retire === OLD,
    JSON.stringify(success)
  );
  const withLeftover = zd.planSettle(names, [c(LIVE, "D1", 21000), c(NEXT, "D2", 21001), c(OLD, "D0", 20999, "exited")], "D2", {
    drain: true,
  });
  r.check(
    "a leftover under the old name goes first, so the rename has the name free",
    withLeftover.remove.join() === OLD && withLeftover.retire === OLD && carryOut(withLeftover, [c(LIVE, "D1", 21000), c(NEXT, "D2", 21001), c(OLD, "D0", 20999, "exited")]).length === 1
  );
  const stopped = zd.planSettle(names, [c(LIVE, "D1", 21000, "exited"), c(NEXT, "D2", 21001)], "D2", { drain: true });
  r.check("a stopped old version has nothing to drain", stopped.retire === null && stopped.remove.join() === LIVE);

  // --- the sequence, against a simulated daemon ------------------------------------------
  const appLabels = (deployment, livePort) => {
    const pairs = labels.labelArgs({ project: SLUG, kind: "app", deployment, livePort }).filter((arg) => arg !== "--label");
    return Object.fromEntries(pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  };

  /**
   * One deploy of `shop`, D1 online on 21000, D2 coming in on 21001. Every
   * step the rest of the panel owns is a stand-in that records itself.
   */
  async function deploy(opts = {}) {
    const sim = simulatedDocker({
      containers: [
        { id: "live", name: LIVE, state: "running", labels: appLabels("D1", 21000) },
        { id: "neighbour", name: "runpanel-shop-api", state: "running", labels: { ...appLabels("Z9"), "runpanel.project": "shop-api" } },
        ...(opts.extra ?? []),
      ],
      hooks: opts.hooks ?? {},
    });
    const events = [];
    const lines = [];
    const liveAt = (moment) => events.push(`${moment}:${sim.container(LIVE)?.labels["runpanel.deployment"] ?? "-"}/${sim.container(LIVE)?.state ?? "-"}`);
    const deps = {
      cli: {
        run: async (args) => {
          events.push(`docker ${args.slice(0, 2).join(" ")} ${args.at(-1)}`);
          return sim.cli.run(args);
        },
      },
      slug: SLUG,
      log: (line) => lines.push(line),
      checkpoint: () => {
        if (opts.cancelAt && events.includes(opts.cancelAt)) throw new Error("Deploy interrotto dall'operatore");
      },
      startCandidate: async (port) => {
        await sim.cli.run(["create", "--name", NEXT, ...labels.labelArgs({ project: SLUG, kind: "app", deployment: "D2", livePort: port }), "-p", `127.0.0.1:${port}:3000`, "runpanel/shop:d2"]);
        await sim.cli.run(["start", NEXT]);
        events.push(`candidate:${port}`);
      },
      afterStart: async () => events.push("post-start"),
      waitHealthy: async (port) => {
        liveAt("health");
        events.push(`health:${port}`);
        return opts.unhealthy ? { healthy: false, reason: "port 3000 not responding on /" } : { healthy: true };
      },
      candidateLogs: async () => ["Error: listen EADDRINUSE"],
      beforeSwitch: async () => events.push("post-deploy"),
      switchUpstream: async (port, commit) => {
        liveAt("switch");
        events.push(`switch:${port}`);
        if (opts.nginx === "refused") return { ok: false, message: "nginx ha rifiutato il passaggio alla nuova versione: [emerg] …" };
        if (opts.nginx === "stuck") return { ok: false, stuck: true, message: "non tornato indietro" };
        await commit();
        return { ok: true, message: "nginx ora manda le richieste alla nuova versione" };
      },
      commit: async (port) => events.push(`commit:${port}`),
      drain: async () => {
        liveAt("drain");
        events.push(`drain:${sim.container(OLD)?.state ?? "-"}`);
      },
      promoted: () => events.push("promoted"),
    };
    let error = null;
    let phase = null;
    try {
      phase = await ops.releaseWithoutDowntime(deps, { deploymentId: "D2", port: 21001, healthTimeoutSec: 30 });
    } catch (err) {
      error = err;
    }
    const touchedLive = sim.calls.filter(({ args }) => ["stop", "rm", "rename", "restart", "kill"].includes(args[0]) && args.includes(LIVE));
    return { sim, events, lines, error, phase, touchedLive };
  }

  {
    const run = await deploy();
    const order = (a, b) => run.events.indexOf(a) !== -1 && run.events.indexOf(a) < run.events.indexOf(b);
    r.check("a deploy that works reaches the end", run.error === null && run.phase === "drained", run.error?.message);
    r.check("the new container starts on its own port beside the live one", run.events.includes("candidate:21001") && run.events.includes("health:D1/running"));
    r.check("the live one still serves, untouched, when nginx moves", run.events.includes("switch:D1/running"));
    r.check("the post-deploy commands run once the new one answers, before nginx moves", order("health:21001", "post-deploy") && order("post-deploy", "switch:21001"));
    r.check("the deploy is committed by the switch", order("switch:21001", "commit:21001"));
    r.check("nothing touched the old container before the commit", run.touchedLive.length === 0 || run.events.indexOf("commit:21001") < run.events.findIndex((e) => e.startsWith(`docker rename ${LIVE}`)));
    r.check("the new one takes the live name before the drain", order("commit:21001", "promoted") && order("promoted", "drain:D2/running"));
    r.check("the old one drains while still running, under the old name", run.events.includes("drain:running"));
    r.check("then it is stopped with a grace period, and removed", order("drain:running", `docker stop -t ${OLD}`) && order(`docker stop -t ${OLD}`, `docker rm -f ${OLD}`));
    const left = run.sim.state.containers.filter((x) => x.labels["runpanel.project"] === SLUG).map((x) => `${x.name}:${x.labels["runpanel.deployment"]}:${x.labels["runpanel.live-port"]}`);
    r.check("one container is left, the new one, under the live name, on its port", left.join() === `${LIVE}:D2:21001`, left.join());
    r.check("the published port is loopback only", run.sim.container(LIVE).publish.join() === "127.0.0.1:21001:3000");
    r.check("a neighbour whose name starts the same is never touched", run.sim.container("runpanel-shop-api")?.state === "running");
  }

  {
    const run = await deploy({ unhealthy: true });
    r.check("a new version that never answers fails the deploy", run.error?.name === "ReleaseFailure" && run.error.health === true);
    r.check("with the message an ordinary deploy would have", run.error?.message === "Health check failed after 30s: port 3000 not responding on /", run.error?.message);
    r.check("its logs are in the deploy log", run.lines.includes("Error: listen EADDRINUSE"));
    r.check("it is removed", !run.sim.container(NEXT));
    r.check("the old one is never touched", run.touchedLive.length === 0 && run.sim.container(LIVE)?.state === "running" && run.sim.container(LIVE).labels["runpanel.deployment"] === "D1");
    r.check("nginx is never asked, nothing is committed", !run.events.some((e) => e.startsWith("switch:") || e.startsWith("commit:")));
  }

  {
    const run = await deploy({ nginx: "refused" });
    r.check("nginx refusing the switch fails the deploy, with nginx's words", run.error?.message.includes("nginx ha rifiutato"));
    r.check("the new container is removed", !run.sim.container(NEXT));
    r.check("the old one serves on, untouched, nothing committed", run.touchedLive.length === 0 && !run.events.some((e) => e.startsWith("commit:")));
  }

  {
    const run = await deploy({ nginx: "stuck" });
    r.check("a switch nginx kept but the store lost leaves the new container up", run.error !== null && run.sim.container(NEXT)?.state === "running");
    r.check("and still never touches the old one", run.touchedLive.length === 0);
  }

  {
    const run = await deploy({ cancelAt: "post-deploy" });
    r.check("a deploy stopped before the switch removes the new container", run.error !== null && !run.sim.container(NEXT));
    r.check("leaving the rest to the pipeline's stop, not to the sequence", run.touchedLive.length === 0);
  }

  {
    // A rename the daemon refuses after the commit: the deploy stays done, and
    // the next boot settles the containers.
    let refused = false;
    const run = await deploy({
      hooks: {
        rename: (args) => {
          if (!refused && args[2] === LIVE) {
            refused = true;
            throw new Error("Error response from daemon: simulated rename failure");
          }
        },
      },
    });
    r.check("a failure after the commit does not fail the deploy", run.error === null && run.phase === "committed");
    r.check("it is said in the log", run.lines.some((line) => line.startsWith("ATTENZIONE: riordino dei container")));
    const plan = await ops.normalize(run.sim.cli, SLUG, "D2");
    const left = run.sim.state.containers.filter((x) => x.labels["runpanel.project"] === SLUG);
    r.check(
      "and the boot settles to the committed one under the live name",
      left.length === 1 && left[0].name === LIVE && left[0].labels["runpanel.deployment"] === "D2" && plan.livePort === 21001,
      JSON.stringify(left.map((x) => x.name))
    );
  }

  {
    // Somebody else's container under the candidate name is not the panel's to remove.
    const foreign = { id: "x", name: NEXT, state: "running", labels: { "runpanel.managed": "true", "runpanel.kind": "service", "runpanel.service": "pg" } };
    const sim = simulatedDocker({ containers: [{ id: "live", name: LIVE, state: "running", labels: appLabels("D1", null) }, foreign] });
    const listed = await ops.listAppContainers(sim.cli, SLUG);
    r.check("a container under a deploy-only name with foreign labels is not listed", listed.length === 1 && listed[0].name === LIVE);
    await ops.normalize(sim.cli, SLUG, "D1");
    r.check("and normalize leaves it alone", sim.container(NEXT)?.state === "running");
    const unlabelled = simulatedDocker({ containers: [{ id: "old", name: LIVE, state: "running", labels: {} }] });
    r.check("a live container from before the labels is the project's", (await ops.listAppContainers(unlabelled.cli, SLUG)).length === 1);
  }

  // --- the nginx block of the switch --------------------------------------------------------
  const site = (patch = {}) => ({
    hostname: "shop.esempio.it",
    upstreamPort: 3000,
    allow: null,
    certificate: null,
    checkToken: "abcdefghijklmnopqrstuv",
    ipv6: true,
    http2: "directive",
    cloudflare: false,
    auth: null,
    redirect: null,
    ...patch,
  });
  /** What `nginx -t` would at least ask of the text: balanced blocks, every directive ended. */
  const structureProblems = (text) => {
    const problems = [];
    let depth = 0;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (depth < 0) problems.push(`unbalanced: ${line}`);
      if (!/[;{}]$/.test(line)) problems.push(`not ended: ${line}`);
    }
    if (depth !== 0) problems.push(`depth ${depth} at the end`);
    return problems;
  };
  const changedLines = (a, b) => {
    const left = a.split("\n");
    const right = b.split("\n");
    if (left.length !== right.length) return null;
    return left.flatMap((line, i) => (line === right[i] ? [] : [[line, right[i]]]));
  };
  const variants = [
    ["served over HTTP while waiting for a certificate", site()],
    ["served over HTTPS", site({ certificate: { fullchain: `${render.LETSENCRYPT_DIR}/live/shop.esempio.it/fullchain.pem`, privkey: `${render.LETSENCRYPT_DIR}/live/shop.esempio.it/privkey.pem` } })],
    ["behind an allow list, a password and Cloudflare", site({ allow: ["203.0.113.0/24"], cloudflare: true, auth: { user: "ospite", hash: `$6$saltsalt$${"a".repeat(86)}` } })],
  ];
  for (const [label, input] of variants) {
    const before = render.renderSite(input);
    const after = render.retargetUpstream(before, 21004);
    const diff = after === null ? null : changedLines(before, after);
    r.check(`${label}: the switch changes exactly one line`, diff !== null && diff.length === 1, JSON.stringify(diff));
    r.check(
      `${label}: and that line is the upstream`,
      diff?.[0]?.[0].trim() === "proxy_pass http://127.0.0.1:3000;" && diff?.[0]?.[1].trim() === "proxy_pass http://127.0.0.1:21004;"
    );
    r.check(`${label}: the block is what the store renders for the new port`, after === render.renderSite({ ...input, upstreamPort: 21004 }));
    r.check(`${label}: the switched block is well formed`, structureProblems(after ?? "").length === 0, structureProblems(after ?? "").join("; "));
    r.check(`${label}: switching back gives the original byte for byte`, render.retargetUpstream(after, 3000) === before);
  }
  const twin = render.renderSite(site({ hostname: "www.shop.esempio.it", redirect: { hostname: "shop.esempio.it", https: true } }));
  r.check("a twin that only redirects has no upstream to move", render.retargetUpstream(twin, 21004) === null);
  let refusedPort = false;
  try {
    render.retargetUpstream(render.renderSite(site()), 70000);
  } catch {
    refusedPort = true;
  }
  r.check("a port that is not one is refused", refusedPort);
  const moved = { access_mode: "open", access_allow: null, access_port: null, live_port: 21004 };
  r.check("the store's upstream is the live port when there is one", access.upstreamPort(moved, 3000) === 21004);
  r.check("and the project's port otherwise", access.upstreamPort({ ...moved, live_port: null }, 3000) === 3000);
  r.check(
    "a restricted project without one goes to its gate's loopback port, as before",
    access.upstreamPort({ access_mode: "restricted", access_allow: "[]", access_port: 49731, live_port: null }, 3000) === 49731
  );

  return r.result();
}
