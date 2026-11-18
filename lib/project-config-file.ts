/**
 * The project configuration file: what "Esporta configurazione" writes and
 * the wizard's import reads back.
 *
 * It carries what a project runs and how, never its secrets: no variables, no
 * webhook secret, no access passwords, and build-time values only by name
 * (they can be tokens). The contract is the one the panel stores, sparse, not
 * the parsed one: the parsed one has every default filled in, and importing
 * those would pin them over whatever the repository's runpanel.json says. Bind
 * mounts are dropped too: they name folders on one particular server.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export const CONFIG_SCHEMA = "runpanel-project-config/1";

export interface ProjectConfigFile {
  $schema: typeof CONFIG_SCHEMA;
  exportedAt: string;
  name: string;
  source: { type: "github" | "upload"; url: string | null; branch: string };
  runtime: string;
  port: number | null;
  autoDeploy: boolean;
  restartCron: string | null;
  contract: Record<string, unknown>;
  hosts: string[];
}

const RUNTIMES = ["node", "static", "docker", "compose", "custom"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored contract, safe to hand around. */
export function shareableContract(builderConfig: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(builderConfig || "{}");
  } catch {
    return {};
  }
  if (!isObject(raw)) return {};
  const out: Record<string, unknown> = { ...raw };
  if (isObject(out.buildEnv)) out.buildEnv = Object.fromEntries(Object.keys(out.buildEnv).map((key) => [key, ""]));
  if (isObject(out.docker) && "mounts" in out.docker) {
    const docker = { ...out.docker };
    delete docker.mounts;
    out.docker = docker;
  }
  return out;
}

export function buildConfigFile(
  project: {
    name: string;
    source_type: string;
    source_url: string | null;
    source_branch: string;
    runtime_type: string;
    port: number | null;
    auto_deploy: number;
    restart_cron: string;
    builder_config: string;
    hosts?: { hostname: string }[];
  },
  now = new Date()
): ProjectConfigFile {
  const github = project.source_type === "github";
  return {
    $schema: CONFIG_SCHEMA,
    exportedAt: now.toISOString(),
    name: project.name,
    source: { type: github ? "github" : "upload", url: github ? project.source_url : null, branch: project.source_branch },
    runtime: project.runtime_type,
    port: project.port,
    autoDeploy: Boolean(project.auto_deploy),
    restartCron: project.restart_cron || null,
    contract: shareableContract(project.builder_config),
    hosts: (project.hosts ?? []).map((host) => host.hostname),
  };
}

/** A configuration file read back, or the reason it cannot be, in Italian. */
export function readConfigFile(text: string): { ok: true; config: ProjectConfigFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Il file non è un JSON valido" };
  }
  if (!isObject(raw) || raw.$schema !== CONFIG_SCHEMA) {
    return { ok: false, error: "Non è un file di configurazione di RunPanel (manca $schema)" };
  }
  const source = raw.source;
  if (!isObject(source) || (source.type !== "github" && source.type !== "upload")) {
    return { ok: false, error: "Sorgente mancante o non valida" };
  }
  if (typeof raw.runtime !== "string" || !RUNTIMES.includes(raw.runtime)) {
    return { ok: false, error: "Runtime non valido" };
  }
  const port = raw.port;
  if (port !== null && port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return { ok: false, error: "Porta non valida" };
  }
  const url = typeof source.url === "string" ? source.url : null;
  if (source.type === "github" && (!url || !/^(https?:\/\/|git@)/i.test(url))) {
    return { ok: false, error: "Il repository deve avere un indirizzo https:// o git@" };
  }
  return {
    ok: true,
    config: {
      $schema: CONFIG_SCHEMA,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      name: typeof raw.name === "string" ? raw.name.slice(0, 100) : "progetto-importato",
      source: { type: source.type, url, branch: typeof source.branch === "string" && source.branch ? source.branch : "main" },
      runtime: raw.runtime,
      port: typeof port === "number" ? port : null,
      autoDeploy: raw.autoDeploy === true,
      restartCron: typeof raw.restartCron === "string" ? raw.restartCron : null,
      // Through the same sieve: a hand-edited file may carry mounts again.
      contract: isObject(raw.contract) ? shareableContract(JSON.stringify(raw.contract)) : {},
      hosts: Array.isArray(raw.hosts) ? raw.hosts.filter((h): h is string => typeof h === "string") : [],
    },
  };
}
