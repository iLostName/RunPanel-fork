import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The app form edits three commands and must leave the rest of the contract
 * alone.
 *
 * It used to send a contract made of the three commands only, and the PATCH
 * route stores what it is sent, so saving the form on a configured project
 * dropped its health check, container options, mounts and build variables.
 * `lib/contract-commands.ts` is what lays the commands over the stored contract
 * now; this holds it to that.
 */
export const meta = { name: "contract-commands-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("contract-commands-unit");
  const { commandsOf, contractWithCommands } = await import(pathToFileURL(join(repoRoot, "lib", "contract-commands.ts")).href);

  const configured = {
    version: 1,
    commands: { install: "npm ci", start: "node server.js", release: "npm run migrate" },
    healthcheck: { path: "/health", timeoutSec: 60 },
    docker: { mounts: ["/srv/data:/data"], network: "project" },
    runtime: { memory: "512m" },
    buildEnv: { API_KEY: "enc:v1:abc" },
  };

  // --- reading -----------------------------------------------------------------
  const read = commandsOf(configured);
  r.check("the form starts from the stored commands", read.install === "npm ci" && read.start === "node server.js" && read.build === undefined, JSON.stringify(read));
  r.check("a contract with no commands starts blank", JSON.stringify(commandsOf({ version: 1 })) === "{}");
  r.check("a malformed commands block starts blank", JSON.stringify(commandsOf({ commands: "npm start" })) === "{}");

  // --- unchanged ---------------------------------------------------------------
  r.check(
    "unchanged commands send no contract at all",
    contractWithCommands(configured, { install: "npm ci", build: "", start: "node server.js" }, false) === null
  );
  r.check(
    "whitespace around a command is not a change",
    contractWithCommands(configured, { install: " npm ci ", build: "", start: "node server.js\n" }, false) === null
  );

  // --- changed -----------------------------------------------------------------
  const edited = contractWithCommands(configured, { install: "npm ci", build: "npm run build", start: "node server.js" }, false);
  r.check("a new command is sent", edited?.commands?.build === "npm run build", JSON.stringify(edited));
  r.check("the health check survives", JSON.stringify(edited?.healthcheck) === JSON.stringify(configured.healthcheck));
  r.check("container options and mounts survive", JSON.stringify(edited?.docker) === JSON.stringify(configured.docker));
  r.check("limits survive", JSON.stringify(edited?.runtime) === JSON.stringify(configured.runtime));
  r.check("sealed build variables are sent back as they were", edited?.buildEnv?.API_KEY === "enc:v1:abc");
  r.check("a command the form does not show survives", edited?.commands?.release === "npm run migrate");
  r.check("the contract says its version", edited?.version === 1);
  r.check("the stored object is not mutated", configured.commands.build === undefined && !("build" in configured.commands));

  const cleared = contractWithCommands(configured, { install: "", build: "", start: "node server.js" }, false);
  r.check("an emptied field removes its command", cleared && !("install" in cleared.commands), JSON.stringify(cleared));

  const allCleared = contractWithCommands({ version: 1, commands: { start: "x" } }, { install: "", build: "", start: "" }, false);
  r.check("no commands left means no commands block", allCleared && !("commands" in allCleared), JSON.stringify(allCleared));

  // --- presets -----------------------------------------------------------------
  const withPreset = contractWithCommands(configured, { install: "npm ci", build: "", start: "node server.js" }, true);
  r.check("a preset is always sent a contract to sit under", withPreset !== null && withPreset.healthcheck?.path === "/health");

  // --- a fresh project -----------------------------------------------------------
  const fresh = contractWithCommands({}, { install: "", build: "", start: "npm start" }, false);
  r.check("a fresh project gets just what was typed", JSON.stringify(fresh) === JSON.stringify({ version: 1, commands: { start: "npm start" } }), JSON.stringify(fresh));
  r.check("a fresh project with nothing typed sends nothing", contractWithCommands({}, { install: "", build: "", start: "" }, false) === null);

  return r.result();
}
