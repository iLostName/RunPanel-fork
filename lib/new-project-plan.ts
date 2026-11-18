/**
 * What "Crea e metti online" does, worked out before anything is sent.
 *
 * The new project wizard collects every answer first and creates the project
 * only at the end, so an abandoned wizard leaves nothing behind. The end is a
 * short sequence of calls to the routes that already exist (create, configure,
 * upload, variables, database, address, deploy); this file decides which of
 * them run and with what body, so the order and the bodies can be tested
 * without a browser.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export type WizardRuntime = "node" | "static" | "docker" | "compose" | "custom";
export type WizardDatabase = "postgresql" | "mysql" | "redis" | "mongodb";

export interface NewProjectChoices {
  source: { kind: "github"; url: string; branch: string } | { kind: "zip" };
  runtime: WizardRuntime;
  presetId: string | null;
  /** False for bots and workers: no port, no health check, no address. */
  web: boolean;
  port: number | null;
  commands: { install: string; build: string; start: string };
  /** Only for GitHub, and only when the panel can talk to GitHub. */
  autoDeploy: boolean;
  env: { key: string; value: string }[];
  database: WizardDatabase | null;
  address: { domainId: string; subdomain: string } | null;
}

export type LaunchStep = "create" | "configure" | "upload" | "env" | "database" | "address" | "deploy";

export const LAUNCH_STEP_LABEL: Record<LaunchStep, string> = {
  create: "Creo il progetto",
  configure: "Collego la sorgente",
  upload: "Carico l'archivio",
  env: "Salvo le variabili",
  database: "Creo il database",
  address: "Assegno l'indirizzo",
  deploy: "Avvio il primo deploy",
};

export const DATABASE_LABEL: Record<WizardDatabase, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  redis: "Redis",
  mongodb: "MongoDB",
};

/** Runtimes whose app the panel starts itself and hands a PORT to. */
export function isNativeRuntime(runtime: WizardRuntime): boolean {
  return runtime === "node" || runtime === "static" || runtime === "custom";
}

/** The calls to make, in order. */
export function launchSteps(choices: NewProjectChoices): LaunchStep[] {
  const steps: LaunchStep[] = ["create", "configure"];
  if (choices.source.kind === "zip") steps.push("upload");
  if (choices.env.length > 0) steps.push("env");
  if (choices.database) steps.push("database");
  if (choices.address && choices.web) steps.push("address");
  steps.push("deploy");
  return steps;
}

/** The body of `PATCH /api/projects/:id` that turns an empty project into this one. */
export function configureBody(choices: NewProjectChoices): Record<string, unknown> {
  const body: Record<string, unknown> = { runtimeType: choices.runtime };
  // A new project already is an upload, and the source fields are guarded by
  // the host permission (lib/host-guard.ts): sending an unchanged "upload"
  // would refuse a ZIP to someone allowed to make one.
  if (choices.source.kind === "github") {
    body.sourceType = "github";
    body.sourceUrl = choices.source.url.trim();
    body.sourceBranch = choices.source.branch.trim() || "main";
    if (choices.autoDeploy) {
      body.autoDeploy = true;
      // Tried first; the wizard falls back to polling when the panel cannot
      // be reached from GitHub (the route then answers with a warning).
      body.deployTrigger = "webhook";
    }
  }
  if (choices.web && choices.port !== null) body.port = choices.port;
  if (choices.presetId) body.presetId = choices.presetId;

  const contract: Record<string, unknown> = {};
  const commands: Record<string, string> = {};
  for (const slot of ["install", "build", "start"] as const) {
    const value = choices.commands[slot].trim();
    if (value) commands[slot] = value;
  }
  if (Object.keys(commands).length > 0) contract.commands = commands;
  // A bot or a worker answers no HTTP request: the default check would wait
  // thirty seconds for one and fail a deploy that worked.
  if (!choices.web) contract.healthcheck = { enabled: false };
  if (Object.keys(contract).length > 0) body.builderConfig = { version: 1, ...contract };

  return body;
}

/** The first thing that stops the launch, in Italian, or null. */
export function choicesProblem(choices: NewProjectChoices, name: string): string | null {
  if (!name.trim()) return "Serve un nome per il progetto";
  if (name.trim().length > 100) return "Il nome può avere al massimo 100 caratteri";
  if (choices.source.kind === "github") {
    const url = choices.source.url.trim();
    if (!url) return "Serve l'indirizzo del repository";
    if (!/^(https?:\/\/|git@)/i.test(url)) return "L'indirizzo del repository deve iniziare con https:// o git@";
  }
  if (choices.runtime === "custom" && !choices.commands.start.trim()) {
    return "Con il runtime personalizzato serve il comando di avvio";
  }
  if (choices.web && choices.port !== null && (!Number.isInteger(choices.port) || choices.port < 1 || choices.port > 65535)) {
    return "La porta deve essere un numero tra 1 e 65535";
  }
  if (choices.address && choices.web && choices.port === null) {
    return "Per un indirizzo pubblico l'app deve avere una porta";
  }
  if (choices.address && !choices.address.subdomain.trim() && !choices.address.domainId) {
    return "Scegli il dominio per l'indirizzo";
  }
  if (choices.env.length > 500) return "Al massimo 500 variabili";
  return null;
}

/** A project name from where the code comes from: `utente/mio-sito.git` → `mio-sito`. */
export function suggestProjectName(from: string): string {
  const trimmed = from.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = trimmed.split(/[/\\:]/).pop() ?? "";
  return last
    .replace(/\.(git|zip)$/i, "")
    // GitHub names a downloaded archive after the branch: `mio-sito-main.zip`.
    .replace(/-(main|master)$/i, "")
    .slice(0, 100);
}
