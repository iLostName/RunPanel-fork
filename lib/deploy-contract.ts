import { z } from "zod";

/**
 * What RunPanel needs to know to deploy a project.
 *
 * The fields are deliberately RUNTIME-NEUTRAL. Each driver maps them to its own
 * mechanism — `buildEnv` becomes `--build-arg` under Docker and plain build-time
 * environment under PM2; `envFile` is a read-only mount in one case and a file
 * written into the working directory in the other. Nothing here is specific to
 * any one project: a project that needs something RunPanel cannot express means
 * the contract is incomplete, not that the project needs special-casing.
 *
 * A repository can ship its own `runpanel.json` with the same shape, so a
 * project can declare how it wants to be deployed without RunPanel knowing
 * anything about it in advance.
 */

const shellCommand = z.string().max(4000);

export const restartPolicies = ["no", "on-failure", "unless-stopped", "always"] as const;
export const networkModes = ["project", "bridge", "host"] as const;
export const packageManagers = ["auto", "npm", "bun", "pnpm", "yarn"] as const;

/**
 * Prefixes whose values a frontend build inlines into the client bundle. They
 * have to be present at BUILD time — supplying them only at runtime silently
 * ships the wrong value, or fails the build outright when the Dockerfile
 * asserts on them.
 */
export const DEFAULT_BUILD_ENV_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "PUBLIC_", "REACT_APP_"];

export const deployContractSchema = z.object({
  version: z.literal(1).default(1),

  commands: z
    .object({
      install: shellCommand.optional(),
      build: shellCommand.optional(),
      start: shellCommand.optional(),
      /**
       * Runs once per deploy, after the build and before the app starts —
       * migrations, schema push, cache warm. Its failure fails the deploy.
       */
      release: shellCommand.optional(),
    })
    .default({}),

  packageManager: z.enum(packageManagers).default("auto"),

  /** Values passed to the build, in addition to those matched by the prefixes. */
  buildEnv: z.record(z.string(), z.string()).default({}),
  buildEnvPrefixes: z.array(z.string()).default(DEFAULT_BUILD_ENV_PREFIXES),

  envFile: z
    .object({
      /**
       * Materialise the project's environment as a real file.
       *
       * Some apps read a .env themselves rather than trusting the process
       * environment. Docker's own `--env-file` is not a substitute: it does not
       * strip quotes, so a quoted value arrives with the quotes attached.
       */
      enabled: z.boolean().default(false),
      /** Where the app expects it. Inside the container for Docker runtimes. */
      path: z.string().default("/app/.env"),
    })
    .default({ enabled: false, path: "/app/.env" }),

  docker: z
    .object({
      /** Template mode: use a prebuilt image instead of building. */
      image: z.string().optional(),
      dockerfile: z.string().optional(),
      context: z.string().default("."),
      target: z.string().optional(),
      network: z.enum(networkModes).default("project"),
      /** Useful with `network: host`, to stop the app binding every interface. */
      hostname: z.string().optional(),
      capAdd: z.array(z.string()).default([]),
      extraHosts: z.array(z.string()).default([]),
      /** Extra volume mounts, `source:target[:ro]`. */
      mounts: z.array(z.string()).default([]),
    })
    .default({ context: ".", network: "project", capAdd: [], extraHosts: [], mounts: [] }),

  runtime: z
    .object({
      restartPolicy: z.enum(restartPolicies).default("unless-stopped"),
      /** Docker memory limit, e.g. "2g". */
      memory: z.string().optional(),
      /** Docker CPU limit, e.g. "1.5". */
      cpus: z.string().optional(),
      /** /dev/shm size. The 64MB default kills browser-style workloads. */
      shmSize: z.string().optional(),
      /**
       * Refuse to start a second instance. For apps holding state in process
       * memory, where two live copies is not slower but wrong.
       */
      singleInstance: z.boolean().default(false),
    })
    .default({ restartPolicy: "unless-stopped", singleInstance: false }),

  build: z
    .object({
      /** e.g. "--max-old-space-size=4096" for a build that OOMs. */
      nodeOptions: z.string().optional(),
      timeoutSec: z.number().int().min(30).max(7200).default(900),
    })
    .default({ timeoutSec: 900 }),

  healthcheck: z
    .object({
      enabled: z.boolean().default(true),
      path: z.string().default("/"),
      /** Defaults to the project's port. */
      port: z.number().int().min(1).max(65535).optional(),
      /** Empty means "any HTTP response counts" — the port is what matters. */
      expectStatus: z.array(z.number().int()).default([]),
      /** Grace before probing at all. Slow boots need this or they look dead. */
      startPeriodSec: z.number().int().min(0).max(600).default(3),
      /** Total budget after the start period. */
      timeoutSec: z.number().int().min(5).max(900).default(30),
      intervalSec: z.number().int().min(1).max(30).default(2),
    })
    .default({
      enabled: true,
      path: "/",
      expectStatus: [],
      startPeriodSec: 3,
      timeoutSec: 30,
      intervalSec: 2,
    }),

  /**
   * When a new version never passes the health check, put the last one that
   * did back online.
   *
   * `enabled`, on by default: Docker, where every deploy is its own image and
   * the previous one is still on disk.
   *
   * `native`, off by default and the operator's to turn on: a native runtime
   * on Linux, from git, then builds every deploy in a folder of its own and
   * keeps the previous one (lib/releases.ts). It changes where the build
   * happens and where the app runs from, on servers with live projects, so it
   * is asked for project by project rather than arriving with an update. Both
   * have to be on; off again, the project builds in its folder as it always
   * did, with nothing to move back. Compose rebuilds the stack from the
   * checkout and has no way back yet. The cases are `rollbackPlan`'s.
   */
  rollback: z
    .object({ enabled: z.boolean().default(true), native: z.boolean().default(false) })
    .default({ enabled: true, native: false }),
});

export type DeployContract = z.infer<typeof deployContractSchema>;

/**
 * The shape older projects stored in `builder_config`. Accepted so an existing
 * project keeps deploying after the upgrade without being touched.
 */
const legacySchema = z.object({
  installCmd: z.string().optional(),
  buildCmd: z.string().optional(),
  startCmd: z.string().optional(),
  packageManager: z.enum(packageManagers).optional(),
  dockerImage: z.string().optional(),
  dockerTemplate: z.string().optional(),
  dockerFields: z.record(z.string(), z.string()).optional(),
  /**
   * The one current-shape key a row of the old shape keeps: whether the
   * project goes back to its previous version, and for a native one whether it
   * builds in folders per version, is a choice the operator made and must not
   * fall off because the commands were saved the old way. A value that is not
   * one is dropped rather than failing the row: the commands beside it matter more.
   */
  rollback: z.object({ enabled: z.boolean().optional(), native: z.boolean().optional() }).optional().catch(undefined),
});

/**
 * Keys only the old shape ever had. `packageManager` is in both shapes, so it
 * says nothing either way.
 */
const LEGACY_ONLY_KEYS = [
  "installCmd",
  "buildCmd",
  "startCmd",
  "dockerImage",
  "dockerTemplate",
  "dockerFields",
] as const;

type RawObject = Record<string, unknown>;

/** Keys that reach an object's prototype chain when assigned or read. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** JSON.parse reviver that drops prototype-reaching keys at every level. */
export function safeJsonReviver(key: string, value: unknown): unknown {
  return UNSAFE_KEYS.has(key) ? undefined : value;
}

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Legacy means a legacy key and no `version`, which that shape never had.
 *
 * `version` is optional in the current shape, and the presets and a
 * `runpanel.json` usually leave it out. Reading "no version" as "legacy" ran them
 * through `legacySchema`, which strips what it does not know: a detected preset
 * and a whole repository contract came back as `{}` with no error. An unknown
 * `version` is not legacy either: it stays as it is and the schema refuses it.
 */
function isLegacyShape(raw: RawObject): boolean {
  return !Object.hasOwn(raw, "version") && LEGACY_ONLY_KEYS.some((key) => Object.hasOwn(raw, key));
}

/**
 * Translate the old four-field shape into the current one, WITHOUT applying
 * defaults. Keeping it partial is what lets a repository contract fill in
 * everything the panel did not explicitly set.
 */
export function normalizeContractInput(raw: unknown): RawObject {
  return normalizeRaw(raw);
}

/**
 * Whether a body sent for `builder_config` can be read as a contract at all.
 *
 * `false` is what the route must refuse: everything here would otherwise parse
 * as an empty contract and overwrite the stored one with defaults, answering
 * 200. Fields of the current shape are not judged here, because the schema does
 * that with a better message. A key nothing knows (`comands`) is only a problem
 * when it is all there is: stored rows may carry `dockerTemplate` next to a
 * `version`, and `contractPatch` in the settings form sends them back.
 */
export function isContractInput(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  if (isLegacyShape(raw)) return legacySchema.safeParse(raw).success && Object.keys(normalizeRaw(raw)).length > 0;

  const keys = Object.keys(raw);
  return keys.length === 0 || keys.some((key) => Object.hasOwn(deployContractSchema.shape, key));
}

function normalizeRaw(raw: unknown): RawObject {
  if (!isPlainObject(raw)) return {};
  if (!isLegacyShape(raw)) return raw;

  const parsed = legacySchema.safeParse(raw);
  if (!parsed.success) return {};

  const legacy = parsed.data;
  const out: RawObject = {};

  const commands: RawObject = {};
  if (legacy.installCmd) commands.install = legacy.installCmd;
  if (legacy.buildCmd) commands.build = legacy.buildCmd;
  if (legacy.startCmd) commands.start = legacy.startCmd;
  if (Object.keys(commands).length > 0) out.commands = commands;

  if (legacy.packageManager) out.packageManager = legacy.packageManager;
  if (legacy.dockerImage) out.docker = { image: legacy.dockerImage };
  if (legacy.rollback && Object.keys(legacy.rollback).length > 0) out.rollback = legacy.rollback;

  return out;
}

/**
 * Recursive merge where `override` wins. Arrays are replaced rather than
 * concatenated — a caller who sets `capAdd: []` means "none", not "keep
 * whatever was there".
 */
function deepMerge(base: RawObject, override: RawObject): RawObject {
  const out: RawObject = { ...base };

  for (const [key, value] of Object.entries(override)) {
    // JSON.parse keeps "__proto__" as an own key; assigning it here would run
    // the setter and hand the repository the merged object's prototype, which
    // the schema then reads panel-only fields from.
    if (value === undefined || UNSAFE_KEYS.has(key)) continue;
    const existing = Object.hasOwn(out, key) ? out[key] : undefined;
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return out;
}

/**
 * Parse whatever is stored for a project into a complete contract.
 * Never throws: an unreadable config yields defaults rather than an
 * undeployable project.
 */
export function parseContract(raw: unknown): DeployContract {
  const result = deployContractSchema.safeParse(normalizeRaw(raw));
  return result.success ? result.data : deployContractSchema.parse({});
}

export function parseContractJson(json: string | null | undefined): DeployContract {
  if (!json) return deployContractSchema.parse({});
  try {
    return parseContract(JSON.parse(json));
  } catch {
    return deployContractSchema.parse({});
  }
}

/**
 * Fields a repository is never allowed to set for itself.
 *
 * Most of the contract says how to build and run the app, which is the
 * repository's own business — deploying it already means running its code.
 * These say what the app may reach *outside* its container, which is the
 * operator's: a bind mount of `/` or of the Docker socket, an added capability,
 * or `network: host` hands over the whole machine, and `envFile.path` decides
 * where the project's decrypted secrets get written. Choosing a Docker runtime
 * is a choice for isolation, and the repository must not be able to revoke it.
 *
 * `docker.context`, `docker.dockerfile` and `docker.target` are on the list for
 * exactly that last reason, and they were missing from it. They become the
 * final argument and the `-f` of `docker build`, which runs with the checkout
 * as its working directory — so `"context": "../.."` makes the build context
 * the panel's own data directory, where `.secret` and `runpanel.db` live. A
 * Dockerfile that then `COPY`s them, in a repository that already owns its own
 * Dockerfile, walks off with the master key and the whole encrypted store.
 *
 * `healthcheck.port` joins them because the probe is a request the panel makes
 * on the operator's network on the repository's instruction: left settable it
 * turns every deploy into a loopback port scan.
 *
 * `rollback.native` because it decides where a native app is built and run
 * from on the host, and whether the project folder's build output is removed:
 * an opt-in a pushed commit could switch on by itself would not be one.
 *
 * A project starts life with `builder_config` of `"{}"`, so without this every
 * one of these fields would come from the repository until an operator happened
 * to set it by hand.
 */
const PANEL_ONLY_FIELDS: readonly (readonly [string, string])[] = [
  ["docker", "mounts"],
  ["docker", "capAdd"],
  ["docker", "network"],
  ["docker", "extraHosts"],
  ["docker", "context"],
  ["docker", "dockerfile"],
  ["docker", "target"],
  ["envFile", "path"],
  ["healthcheck", "port"],
  ["healthcheck", "path"],
  ["rollback", "native"],
];

export interface StrippedContract {
  /** The contract with every panel-only field removed. */
  contract: RawObject;
  /** Dotted names of the fields that were present and dropped, for the log. */
  rejected: string[];
}

/**
 * Drop the fields a repository may not set, before its contract is merged.
 *
 * Done here rather than after the merge because once the layers are combined
 * there is nothing left to say which side a value came from. Returns copies:
 * `normalizeRaw` hands back the caller's own object when it is already in the
 * current shape, so mutating in place would edit the parsed `runpanel.json`.
 */
export function stripPanelOnlyFields(repoRaw: unknown): StrippedContract {
  if (!isPlainObject(repoRaw)) return { contract: {}, rejected: [] };

  const contract: RawObject = { ...repoRaw };
  const rejected: string[] = [];

  for (const key of UNSAFE_KEYS) {
    if (!Object.hasOwn(contract, key)) continue;
    delete contract[key];
    rejected.push(key);
  }

  /*
    A sealed build argument is the panel's to open, never a repository's: one
    copied from somewhere else would be decrypted into the build and printed by
    it. `enc:v1:` is `SEALED_PREFIX` in lib/build-env-seal.ts, written out here
    because this file imports nothing but zod.
  */
  if (isPlainObject(contract.buildEnv)) {
    const kept: RawObject = {};
    for (const [key, value] of Object.entries(contract.buildEnv)) {
      if (typeof value === "string" && value.startsWith("enc:v1:")) rejected.push(`buildEnv.${key}`);
      else kept[key] = value;
    }
    contract.buildEnv = kept;
  }

  for (const [parent, child] of PANEL_ONLY_FIELDS) {
    const branch = Object.hasOwn(contract, parent) ? contract[parent] : undefined;
    if (!isPlainObject(branch) || !Object.hasOwn(branch, child)) continue;

    const remaining = { ...branch };
    delete remaining[child];
    contract[parent] = remaining;
    rejected.push(`${parent}.${child}`);
  }

  return { contract, rejected };
}

/**
 * Combine a repository's own `runpanel.json` with the panel's settings.
 *
 * Both sides are merged RAW, before defaults are filled in. That distinction is
 * the whole feature: once a schema default has been applied there is no way to
 * tell "the operator chose 3" from "nobody set it and 3 is the default", so a
 * repository value could never win on any field that has a default — which is
 * nearly all of them.
 *
 * Where both sides set the same field the panel wins: the operator can see the
 * target machine, the repository cannot. For the fields in `PANEL_ONLY_FIELDS`
 * that is not enough, because the panel usually sets nothing at all — the
 * repository side must be stripped with `stripPanelOnlyFields` before it gets
 * here.
 */
export function resolveContract(panelRaw: unknown, repoRaw: unknown): DeployContract {
  const panel = withoutEmptyCommands(normalizeRaw(panelRaw));
  if (!isPlainObject(repoRaw)) return parseContract(panel);

  const merged = deepMerge(normalizeRaw(repoRaw), panel);
  const result = deployContractSchema.safeParse(merged);
  return result.success ? result.data : parseContract(panel);
}

/**
 * A field left empty in the settings form is no answer, not the answer "nothing":
 * it would otherwise cover the repository's command with an empty one.
 *
 * Except `release`, the one command a project does fine without: there, emptying
 * the field is how an operator turns off the repository's migration.
 */
function withoutEmptyCommands(raw: RawObject): RawObject {
  if (!isPlainObject(raw.commands)) return raw;
  return {
    ...raw,
    commands: Object.fromEntries(
      Object.entries(raw.commands).filter(([key, value]) => key === "release" || value !== "")
    ),
  };
}

/** Same, taking the panel side as the JSON string stored on the project. */
export function resolveContractJson(panelJson: string | null | undefined, repoRaw: unknown): DeployContract {
  let panelRaw: unknown = {};
  try {
    panelRaw = panelJson ? JSON.parse(panelJson) : {};
  } catch {
    panelRaw = {};
  }
  return resolveContract(panelRaw, repoRaw);
}

/**
 * Split a project's environment into what the build needs and what the running
 * process needs. Build args are additionally reported so the deploy log can
 * name them without printing the values.
 */
/** Runtimes whose builder works out install, build and start from the repository. */
const SELF_DETECTING_RUNTIMES: ReadonlySet<string> = new Set(["node", "static"]);

function hasCommands(raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  const { commands } = normalizeContractInput(raw);
  // Not `release`: it says what to run after a build, not how to build or start,
  // so on its own it leaves a preset's answer to those standing.
  return isPlainObject(commands) && Object.entries(commands).some(([key, value]) => key !== "release" && Boolean(value));
}

/**
 * What a preset found by looking at the repository may contribute to a deploy.
 *
 * A guess, so it only fills what nobody decided. Its settings (timeouts, the
 * health check, build-time prefixes) always apply; its commands are another
 * matter. On a runtime whose builder detects them they would replace a better
 * answer: `npm run build` on a pnpm repository, or a build with no install
 * before it on a static site. Anywhere else they count only when neither the
 * operator nor the repository gave any, because a preset's install command
 * alongside somebody else's start command is a pairing nobody chose.
 */
export function detectedPresetLayer(
  contract: object,
  runtimeType: string,
  configured: { panel: unknown; repo: unknown }
): object {
  const keepCommands =
    !SELF_DETECTING_RUNTIMES.has(runtimeType) &&
    !hasCommands(configured.panel) &&
    !hasCommands(configured.repo);
  if (keepCommands) return contract;

  const settings: RawObject = { ...contract };
  delete settings.commands;
  return settings;
}

/**
 * A stored contract with its mounts replaced and nothing else touched.
 *
 * Not the parsed contract: that one has every default filled in, and
 * `builder_config` is sparse on purpose. Written back whole, those defaults
 * would become the operator's own settings and outrank the repository's
 * `runpanel.json` on every deploy after this one.
 */
export function withContractMounts(json: string | null | undefined, mounts: string[]): string {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(json ?? "{}", safeJsonReviver);
  } catch {
    /* unreadable reads as empty, as it does for `parseContractJson` */
  }
  const contract = normalizeContractInput(parsed);
  const docker = isPlainObject(contract.docker) ? contract.docker : {};
  return JSON.stringify({ ...contract, version: 1, docker: { ...docker, mounts } });
}

export function selectBuildEnv(
  contract: DeployContract,
  envVars: Record<string, string>
): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    if (contract.buildEnvPrefixes.some((prefix) => key.startsWith(prefix))) {
      selected[key] = value;
    }
  }

  // Explicit entries win over prefix matching.
  return { ...selected, ...contract.buildEnv };
}

export interface PreflightIssue {
  field: string;
  message: string;
}

/**
 * A relative path that does not climb out of the directory it is resolved in.
 *
 * Deliberately textual and deliberately strict: it runs in `preflight`, which
 * `lib/` keeps free of `fs`, and it is a first line rather than the last one —
 * `docker-builder` resolves the same values against the real checkout with
 * `resolveInside` before it uses them.
 */
export function escapesCheckout(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return true;
  if (/^[A-Za-z]:/.test(trimmed)) return true;
  return trimmed.split(/[/\\]/).some((part) => part === "..");
}

/**
 * Catch what can be known before a build starts.
 *
 * A ten-minute image build that fails on a missing build arg is a bad way to
 * find out the value was never set.
 */
export function preflight(
  contract: DeployContract,
  ctx: { runtimeType: string; envVars: Record<string, string>; repoDir?: string }
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const isDocker = ctx.runtimeType === "docker";

  for (const [key, value] of Object.entries(contract.buildEnv)) {
    if (value === "") {
      issues.push({
        field: `buildEnv.${key}`,
        message: `Build arg "${key}" è dichiarato ma vuoto. Molti build falliscono o compilano il valore sbagliato.`,
      });
    }
  }

  if (!isDocker) {
    if (contract.docker.network === "host") {
      issues.push({
        field: "docker.network",
        message: "network: host vale solo per i runtime Docker; verrà ignorato.",
      });
    }
    if (contract.runtime.shmSize || contract.runtime.cpus) {
      issues.push({
        field: "runtime",
        message: "I limiti di CPU e shm si applicano solo ai container; verranno ignorati.",
      });
    }
  }

  if (contract.envFile.enabled && !contract.envFile.path.trim()) {
    issues.push({ field: "envFile.path", message: "Il percorso del file .env è vuoto." });
  }

  /*
    The build context and the Dockerfile are resolved against the checkout, so a
    value that climbs out of it hands `docker build` a directory the project has
    no business reading. Said here as well as refused at the builder, because
    preflight is where an operator finds out before the build runs.
  */
  for (const [field, value] of [
    ["docker.context", contract.docker.context],
    ["docker.dockerfile", contract.docker.dockerfile],
  ] as const) {
    if (!value) continue;
    if (escapesCheckout(value)) {
      issues.push({
        field,
        message: `${value} esce dalla cartella del progetto: deve essere un percorso relativo al checkout.`,
      });
    }
  }

  if (contract.healthcheck.enabled && !contract.healthcheck.path.startsWith("/")) {
    issues.push({
      field: "healthcheck.path",
      message: `Il path dell'healthcheck deve iniziare con "/" (attuale: "${contract.healthcheck.path}").`,
    });
  }

  return issues;
}
