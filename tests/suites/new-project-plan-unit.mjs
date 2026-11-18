import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * What the new project wizard sends at the end, decided without a browser.
 *
 * The PATCH body is the one AppForm sends for the same answers, so a project
 * made by the wizard is indistinguishable from one configured by hand.
 * Standalone: lib/new-project-plan.ts has no imports.
 */
export const meta = { name: "new-project-plan-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("new-project-plan-unit");
  const { launchSteps, configureBody, choicesProblem, suggestProjectName } = await import(pathToFileURL(join(repoRoot, "lib", "new-project-plan.ts")).href);

  const base = {
    source: { kind: "github", url: "https://github.com/me/app.git", branch: "main" },
    runtime: "node",
    presetId: "next-server",
    web: true,
    port: 3000,
    commands: { install: "", build: "", start: "" },
    autoDeploy: true,
    env: [],
    database: null,
    address: null,
  };

  r.check("a GitHub app: create, configure, deploy", JSON.stringify(launchSteps(base)) === JSON.stringify(["create", "configure", "deploy"]));
  const full = { ...base, source: { kind: "zip" }, env: [{ key: "A", value: "1" }], database: "postgresql", address: { domainId: "d1", subdomain: "app" } };
  r.check("everything, in dependency order", JSON.stringify(launchSteps(full)) === JSON.stringify(["create", "configure", "upload", "env", "database", "address", "deploy"]));
  r.check("a worker gets no address step", !launchSteps({ ...full, web: false }).includes("address"));

  const body = configureBody(base);
  r.check("source, branch and runtime", body.sourceType === "github" && body.sourceUrl === "https://github.com/me/app.git" && body.sourceBranch === "main" && body.runtimeType === "node");
  r.check("auto-deploy tries the webhook first", body.autoDeploy === true && body.deployTrigger === "webhook");
  r.check("the port and the preset", body.port === 3000 && body.presetId === "next-server");
  r.check("no contract when nothing was customised", !("builderConfig" in body));

  const custom = configureBody({ ...base, presetId: null, runtime: "custom", commands: { install: " pip install -r requirements.txt ", build: "", start: "python main.py" } });
  r.check("typed commands become the contract, trimmed", JSON.stringify(custom.builderConfig) === JSON.stringify({ version: 1, commands: { install: "pip install -r requirements.txt", start: "python main.py" } }));

  const worker = configureBody({ ...base, web: false, port: 3000 });
  r.check("a worker has its health check off and no port", worker.builderConfig?.healthcheck?.enabled === false && !("port" in worker));

  const zip = configureBody({ ...base, source: { kind: "zip" }, autoDeploy: true });
  r.check("a ZIP sends no source fields and no auto-deploy", !("sourceType" in zip) && !("sourceUrl" in zip) && !("sourceBranch" in zip) && !("autoDeploy" in zip));
  r.check("an empty branch means main", configureBody({ ...base, source: { kind: "github", url: "https://github.com/me/app", branch: " " } }).sourceBranch === "main");

  r.check("no name", choicesProblem(base, " ") !== null);
  r.check("a valid set has no problem", choicesProblem(base, "app") === null);
  r.check("a non-URL repository", /https:\/\//.test(choicesProblem({ ...base, source: { kind: "github", url: "me/app", branch: "" } }, "app") ?? ""));
  r.check("custom runtime without start", choicesProblem({ ...base, runtime: "custom" }, "app") !== null);
  r.check("a port out of range", choicesProblem({ ...base, port: 70000 }, "app") !== null);
  r.check("an address needs a port", choicesProblem({ ...base, port: null, address: { domainId: "d", subdomain: "x" } }, "app") !== null);

  r.check("name from a clone URL", suggestProjectName("https://github.com/me/mio-sito.git") === "mio-sito");
  r.check("name from an SSH URL", suggestProjectName("git@github.com:me/api-server.git") === "api-server");
  r.check("name from a GitHub archive", suggestProjectName("mio-sito-main.zip") === "mio-sito");
  r.check("name from a trailing slash URL", suggestProjectName("https://github.com/me/blog/") === "blog");

  return r.result();
}
