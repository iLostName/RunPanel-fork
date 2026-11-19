import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Pure checks on the contract parser — no server involved.
 *
 * Backward compatibility is worth testing rather than assuming: existing
 * projects store the pre-contract four-field shape, and the schema strips keys
 * it does not recognise, so a missing normalisation step silently empties a
 * project's configuration.
 */
export const meta = { name: "contract-unit", needsDocker: false, drivers: [], standalone: true };

/**
 * The real presets, from a temporary copy with the one `@/` import pointed at
 * the file on disk: the strip-only loader cannot follow the alias, and a table
 * retyped here would go on passing after the presets changed.
 */
async function loadPresets(repoRoot) {
  const contractUrl = pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href;
  const source = readFileSync(join(repoRoot, "services", "deploy-presets", "index.ts"), "utf8");
  const dir = mkdtempSync(join(tmpdir(), "runpanel-presets-"));
  try {
    const file = join(dir, "index.ts");
    writeFileSync(file, source.replace('"@/lib/deploy-contract"', JSON.stringify(contractUrl)));
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("contract-unit");

  const module = await import(
    pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href
  );
  const {
    parseContract,
    parseContractJson,
    resolveContract,
    resolveContractJson,
    selectBuildEnv,
    preflight,
    stripPanelOnlyFields,
    normalizeContractInput,
    isContractInput,
    deployContractSchema,
  } = module;

  // --- legacy shape --------------------------------------------------------
  const legacy = parseContract({
    installCmd: "npm ci",
    buildCmd: "npm run build",
    startCmd: "npm start",
    packageManager: "npm",
    dockerImage: "nginx:1.27",
  });
  r.check("legacy install command migrated", legacy.commands.install === "npm ci", legacy.commands.install);
  r.check("legacy build command migrated", legacy.commands.build === "npm run build", legacy.commands.build);
  r.check("legacy start command migrated", legacy.commands.start === "npm start", legacy.commands.start);
  r.check("legacy package manager kept", legacy.packageManager === "npm", legacy.packageManager);
  r.check("legacy docker image kept", legacy.docker.image === "nginx:1.27", legacy.docker.image);
  r.check("legacy config still receives defaults", legacy.healthcheck.enabled === true);
  r.check("automatic rollback is on unless switched off", legacy.rollback.enabled === true);
  r.check("version folders for native projects are off unless asked for", legacy.rollback.native === false);
  r.check("an empty contract gets the same two defaults", parseContractJson("{}").rollback.enabled === true && parseContractJson("{}").rollback.native === false);
  {
    const kept = parseContract({ startCmd: "npm start", rollback: { native: true } });
    r.check("a row of the old shape keeps the native opt-in", kept.rollback.native === true && kept.rollback.enabled === true, JSON.stringify(kept.rollback));
    r.check("and its commands beside it", kept.commands.start === "npm start");
    r.check(
      "the old shape carries the return switched off too",
      normalizeContractInput({ installCmd: "npm ci", rollback: { enabled: false } }).rollback?.enabled === false
    );
    const odd = parseContract({ startCmd: "npm start", rollback: { native: "yes" } });
    r.check("a broken switch in an old row is dropped, not the row", odd.commands.start === "npm start" && odd.rollback.native === false);
    const repo = stripPanelOnlyFields({ rollback: { enabled: false, native: true } });
    r.check("a repository cannot opt a project into version folders", repo.rejected.includes("rollback.native") && repo.contract.rollback?.native === undefined);
    r.check("but can still turn the return off, as before", resolveContract({}, repo.contract).rollback.enabled === false && resolveContract({}, repo.contract).rollback.native === false);
    r.check("the operator's opt-in is a valid contract", deployContractSchema.safeParse({ rollback: { native: true } }).success && isContractInput({ rollback: { native: true } }));
  }
  {
    // Deploys without downtime: off unless the operator asks, and never from the repository.
    const plain = parseContractJson("{}");
    r.check("deploys without downtime are off by default, with a 15 s drain", plain.zeroDowntime.enabled === false && plain.zeroDowntime.drainSec === 15);
    const repo = stripPanelOnlyFields({ zeroDowntime: { enabled: true, drainSec: 120 }, healthcheck: { timeoutSec: 60 } });
    r.check(
      "a repository can switch on neither the feature nor its drain",
      repo.rejected.includes("zeroDowntime.enabled") && repo.rejected.includes("zeroDowntime.drainSec"),
      repo.rejected.join()
    );
    const merged = resolveContract({}, repo.contract);
    r.check("so a pushed runpanel.json leaves it off", merged.zeroDowntime.enabled === false && merged.zeroDowntime.drainSec === 15);
    r.check("while the rest of its contract still applies", merged.healthcheck.timeoutSec === 60);
    const panel = resolveContract({ zeroDowntime: { enabled: true, drainSec: 30 } }, repo.contract);
    r.check("the panel's switch is what counts", panel.zeroDowntime.enabled === true && panel.zeroDowntime.drainSec === 30);
    r.check("a drain past nginx's 300 s is refused", !deployContractSchema.safeParse({ zeroDowntime: { drainSec: 301 } }).success);
    r.check("the operator's opt-in is a valid contract input", isContractInput({ zeroDowntime: { enabled: true } }));
    const old = parseContract({ startCmd: "npm start", zeroDowntime: { enabled: true } });
    r.check("a row of the old shape keeps the opt-in", old.zeroDowntime.enabled === true && old.commands.start === "npm start");
  }

  const templated = parseContract({ dockerTemplate: "nginx", dockerFields: { rootDir: "/srv" }, dockerImage: "nginx:1.27" });
  r.check("a legacy template row keeps its image", templated.docker.image === "nginx:1.27", templated.docker.image);
  r.check(
    "a legacy key decides the shape, so current keys beside it stay ignored as they always were",
    parseContract({ startCmd: "npm start", commands: { start: "other" } }).commands.start === "npm start"
  );
  r.check("legacy input with a bad value is read as empty", parseContract({ installCmd: 5 }).commands.install === undefined);
  r.check("packageManager alone survives in either reading", parseContract({ packageManager: "bun" }).packageManager === "bun");

  // --- no `version` is the current shape ------------------------------------
  // `version` is optional, and neither the presets nor most repositories set it.
  const versionless = parseContract({
    commands: { start: "node server.js" },
    build: { timeoutSec: 1800 },
    healthcheck: { path: "/health" },
  });
  r.check("a contract without version keeps its commands", versionless.commands.start === "node server.js");
  r.check("a contract without version keeps its build settings", versionless.build.timeoutSec === 1800);
  r.check("a contract without version keeps its healthcheck", versionless.healthcheck.path === "/health");
  r.check(
    "a version-less contract equals the same contract with version 1",
    JSON.stringify(versionless) ===
      JSON.stringify(parseContract({ version: 1, commands: { start: "node server.js" }, build: { timeoutSec: 1800 }, healthcheck: { path: "/health" } }))
  );
  r.check("an empty contract still yields defaults", JSON.stringify(parseContract({})) === JSON.stringify(parseContract(null)));
  r.check("a version-less contract that fails the schema yields defaults", parseContract({ build: "npm run build" }).build.timeoutSec === 900);

  // What the deploy does: preset, then runpanel.json, then the panel's column.
  const deployLayers = (presetContract, repoRaw, panelJson) => {
    const repo = repoRaw === null ? null : stripPanelOnlyFields(repoRaw).contract;
    let base = {};
    for (const layer of [presetContract, repo].filter(Boolean)) base = resolveContract(layer, base);
    return resolveContractJson(panelJson, base);
  };

  const { getPreset, DEPLOY_PRESETS } = await loadPresets(repoRoot);
  const python = deployLayers(getPreset("python").contract, null, "{}");
  r.check("the python preset reaches the deploy with its start command", python.commands.start?.includes("uvicorn"), python.commands.start);
  r.check("the python preset reaches the deploy with its install command", python.commands.install?.includes("pip install"), python.commands.install);
  r.check("the python preset reaches the deploy with its healthcheck", python.healthcheck.timeoutSec === 45, String(python.healthcheck.timeoutSec));

  const next = deployLayers(getPreset("next-server").contract, null, "{}");
  r.check("the next preset keeps its build timeout", next.build.timeoutSec === 1800, String(next.build.timeoutSec));
  r.check("the next preset keeps its heap", next.build.nodeOptions === "--max-old-space-size=4096", next.build.nodeOptions);
  r.check("the next preset keeps its build env prefixes", next.buildEnvPrefixes.join() === "NEXT_PUBLIC_");

  for (const preset of DEPLOY_PRESETS) {
    r.check(`preset ${preset.id} passes the schema`, deployContractSchema.safeParse(normalizeContractInput(preset.contract)).success);
  }

  const layered = deployLayers(
    getPreset("python").contract,
    { commands: { start: "venv/bin/gunicorn app:app" }, healthcheck: { timeoutSec: 60 } },
    JSON.stringify({ version: 1, healthcheck: { timeoutSec: 120 } })
  );
  r.check("a version-less runpanel.json wins over the preset", layered.commands.start === "venv/bin/gunicorn app:app", layered.commands.start);
  r.check("the preset fills what runpanel.json left out", layered.commands.install?.includes("pip install"), layered.commands.install);
  r.check("the panel still wins over runpanel.json", layered.healthcheck.timeoutSec === 120, String(layered.healthcheck.timeoutSec));

  const untrusted = deployLayers(null, { commands: { start: "x" }, docker: { network: "host", capAdd: ["SYS_ADMIN"] } }, "{}");
  r.check("a version-less runpanel.json is applied", untrusted.commands.start === "x");
  r.check("a version-less runpanel.json still cannot set panel-only fields", untrusted.docker.network === "project" && untrusted.docker.capAdd.length === 0);

  // --- what PATCH refuses ---------------------------------------------------
  const refusedByParse = (raw) => !deployContractSchema.safeParse(normalizeContractInput(raw)).success;
  r.check("version 2 is not legacy: the schema refuses it", refusedByParse({ version: 2, commands: { start: "x" } }));
  r.check("a string version is not legacy: the schema refuses it", refusedByParse({ version: "1", commands: { start: "x" } }));
  r.check("an unknown version with a legacy key is not translated", refusedByParse({ version: 2, startCmd: "x" }));
  for (const [what, raw, expected] of [
    ["null", null, false],
    ["an array", [], false],
    ["a string", "x", false],
    ["only unknown keys", { comands: { start: "x" } }, false],
    ["legacy keys with bad values", { installCmd: 5 }, false],
    ["an empty object", {}, true],
    ["the current shape", { version: 1, commands: {} }, true],
    ["the current shape without version", { commands: { start: "x" } }, true],
    ["the legacy shape", { installCmd: "npm ci" }, true],
    ["a stored template row", { version: 1, dockerTemplate: "nginx", dockerFields: {} }, true],
    ["legacy keys that say nothing", { installCmd: "" }, false],
    ["a template with nothing else", { dockerTemplate: "nginx" }, false],
  ]) {
    r.check(`isContractInput: ${what}`, isContractInput(raw) === expected);
  }

  // --- resilience ----------------------------------------------------------
  r.check("empty config yields defaults", parseContractJson("").healthcheck.path === "/");
  r.check("invalid JSON yields defaults", parseContractJson("{not json").runtime.restartPolicy === "unless-stopped");
  r.check("null yields defaults", parseContract(null).build.timeoutSec === 900);

  // --- build env selection -------------------------------------------------
  const contract = parseContract({ version: 1, buildEnv: { EXPLICIT: "yes" } });
  const selected = selectBuildEnv(contract, {
    NEXT_PUBLIC_BASE_URL: "https://x",
    VITE_KEY: "v",
    SECRET: "nope",
    EXPLICIT: "overridden",
  });
  r.check("NEXT_PUBLIC_* is forwarded to the build", selected.NEXT_PUBLIC_BASE_URL === "https://x");
  r.check("VITE_* is forwarded to the build", selected.VITE_KEY === "v");
  r.check("a non-prefixed runtime secret is NOT sent to the build",
    !("SECRET" in selected), JSON.stringify(selected));
  r.check("an explicit buildEnv entry wins", selected.EXPLICIT === "yes", selected.EXPLICIT);

  // --- repo contract merge -------------------------------------------------
  // Merged RAW, before defaults: once a default has been applied there is no
  // way to tell "the operator chose 3" from "nobody set it", and the repository
  // could never contribute a value to any field that has one.
  const merged = resolveContract(
    { version: 1, healthcheck: { path: "/panel-wins" } },
    { version: 1, healthcheck: { path: "/repo-says", startPeriodSec: 42 }, commands: { release: "npx prisma db push" } }
  );
  r.check("the panel's setting beats the repository's",
    merged.healthcheck.path === "/panel-wins", merged.healthcheck.path);
  r.check("the repository fills in what the panel left unset",
    merged.healthcheck.startPeriodSec === 42, String(merged.healthcheck.startPeriodSec));
  r.check("the repository can contribute a release command",
    merged.commands.release === "npx prisma db push", merged.commands.release);

  // --- prototype keys in runpanel.json --------------------------------------
  // JSON.parse keeps "__proto__" as an own key. The pipeline passes the repo
  // layer as the override side, where an unguarded merge would assign it and
  // let the schema read panel-only docker fields from the prototype.
  const { safeJsonReviver } = module;
  const protoPayload = '{"version":1,"__proto__":{"docker":{"image":"alpine","network":"host","capAdd":["ALL"],"mounts":["/srv/data:/d"]}}}';
  const stripped = stripPanelOnlyFields(JSON.parse(protoPayload));
  r.check("__proto__ is rejected by the strip", stripped.rejected.includes("__proto__"), stripped.rejected.join(","));
  const protoMerged = resolveContract(JSON.parse(protoPayload), {});
  r.check("__proto__ cannot smuggle docker.network through the merge",
    protoMerged.docker.network !== "host", protoMerged.docker.network);
  r.check("__proto__ cannot smuggle docker.mounts through the merge",
    protoMerged.docker.mounts.length === 0, JSON.stringify(protoMerged.docker.mounts));
  const revived = JSON.parse(protoPayload, safeJsonReviver);
  r.check("the reviver drops __proto__", !Object.hasOwn(revived, "__proto__"));

  // --- preflight -----------------------------------------------------------
  const emptyArg = preflight(
    parseContract({ version: 1, buildEnv: { NEXT_PUBLIC_BASE_URL: "" } }),
    { runtimeType: "docker", envVars: {} }
  );
  r.check("an empty build arg is flagged before the build starts",
    emptyArg.some((i) => i.field === "buildEnv.NEXT_PUBLIC_BASE_URL"), JSON.stringify(emptyArg));

  const nativeIssues = preflight(
    parseContract({ version: 1, docker: { network: "host" } }),
    { runtimeType: "node", envVars: {} }
  );
  r.check("a container-only option is flagged on a native runtime",
    nativeIssues.some((i) => i.field === "docker.network"), JSON.stringify(nativeIssues));

  // --- what a detected preset may contribute --------------------------------------------
  {
    const { detectedPresetLayer } = await import(
      pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href
    );
    const preset = {
      commands: { install: "pip install -r requirements.txt", start: "uvicorn main:app" },
      healthcheck: { timeoutSec: 45 },
    };
    const none = { panel: {}, repo: null };

    r.check("an empty custom project takes the preset's commands", detectedPresetLayer(preset, "custom", none).commands?.start === "uvicorn main:app");
    r.check(
      "a runtime that detects its own commands keeps them",
      detectedPresetLayer(preset, "node", none).commands === undefined &&
        detectedPresetLayer(preset, "static", none).commands === undefined
    );
    r.check("and still takes the preset's settings", detectedPresetLayer(preset, "node", none).healthcheck?.timeoutSec === 45);
    r.check(
      "a command the operator set keeps the preset's out of the pairing",
      detectedPresetLayer(preset, "custom", { panel: { version: 1, commands: { start: "./run" } }, repo: null }).commands === undefined
    );
    r.check(
      "so does one from the repository",
      detectedPresetLayer(preset, "custom", { panel: {}, repo: { commands: { build: "make" } } }).commands === undefined
    );
    r.check(
      "a legacy column counts as configured too",
      detectedPresetLayer(preset, "custom", { panel: { startCmd: "./run" }, repo: null }).commands === undefined
    );
    r.check(
      "empty command fields are not a decision",
      detectedPresetLayer(preset, "custom", { panel: { version: 1, commands: { start: "" } }, repo: null }).commands?.start === "uvicorn main:app"
    );
    r.check(
      "and do not cover the command below them",
      resolveContract({ version: 1, commands: { start: "" } }, preset).commands.start === "uvicorn main:app"
    );
    r.check(
      "a release command alone leaves the preset's other commands",
      detectedPresetLayer(preset, "custom", { panel: { version: 1, commands: { release: "migrate" } }, repo: null }).commands?.start === "uvicorn main:app"
    );
    r.check(
      "but an emptied release still turns off the repository's",
      resolveContract({ version: 1, commands: { release: "" } }, { commands: { release: "migrate" } }).commands.release === ""
    );
  }

  // --- a repository cannot hand the panel something to decrypt ---------------------------
  {
    const { stripPanelOnlyFields } = await import(pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href);
    const out = stripPanelOnlyFields({ buildEnv: { A: "plain", B: "enc:v1:abc" } });
    r.check("a sealed value from a repository is dropped", out.contract.buildEnv.A === "plain" && !("B" in out.contract.buildEnv));
    r.check("and said so", out.rejected.includes("buildEnv.B"), out.rejected.join());
  }

  // --- replacing the mounts of a stored contract ---------------------------------------
  {
    const { withContractMounts } = await import(
      pathToFileURL(join(repoRoot, "lib", "deploy-contract.ts")).href
    );
    const sparse = JSON.stringify({ version: 1, commands: { start: "node a.js" }, docker: { network: "host" } });
    const written = JSON.parse(withContractMounts(sparse, ["/a:/b"]));

    r.check("the mounts are replaced", written.docker.mounts.join() === "/a:/b");
    r.check("the rest of the contract stays", written.commands.start === "node a.js" && written.docker.network === "host");
    r.check(
      "no default is written back as if the operator had set it",
      written.healthcheck === undefined && written.runtime === undefined,
      JSON.stringify(written)
    );
    r.check("an empty column gets a valid contract", JSON.parse(withContractMounts(null, [])).version === 1);
    r.check("an unreadable column does not throw", JSON.parse(withContractMounts("{nope", [])).version === 1);
  }

  return r.result();
}
