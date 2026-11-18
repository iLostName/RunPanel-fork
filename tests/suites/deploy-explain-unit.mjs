import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * A failed deploy explained in one sentence, from what the pipeline writes.
 *
 * The messages below are the pipeline's own (services/deploy-pipeline.ts,
 * services/deploy-steps.ts, services/git-manager.ts) or the tools' usual
 * stderr; a wrong explanation is worse than "look at the log".
 */
export const meta = { name: "deploy-explain-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("deploy-explain-unit");
  const { explainDeployError, deployPhase } = await import(pathToFileURL(join(repoRoot, "lib", "deploy-explain.ts")).href);
  const code = (message, log) => explainDeployError(message, log).code;

  r.check("cancelled", code("Deploy interrotto dall'operatore") === "cancelled");
  r.check("no source on disk", code("No source on disk for this project. Connect a GitHub repository or upload a ZIP, then deploy.") === "no-source");
  const branch = explainDeployError('Il branch "develop" non esiste sul remote.');
  r.check("missing branch names it", branch.code === "branch-missing" && branch.title.includes("develop"));
  r.check("private repo without access, from the log", code("Build failed", "Cloning…\nremote: Repository not found.\nfatal: Authentication failed for 'https://github.com/x/y.git/'") === "repo-access");
  r.check("custom runtime without start", code("Il runtime custom richiede un comando di avvio: impostalo nelle impostazioni del progetto.") === "start-command-missing");
  r.check("missing package.json", code("Build failed", "npm error code ENOENT\nnpm error path /srv/app/package.json\nnpm error enoent Could not read package.json") === "no-package-json");
  r.check("out of memory beats install failure", code("Build failed", "npm error something\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory") === "out-of-memory");
  r.check("docker step failure", code("docker build failed", "#8 ERROR [build 4/6] RUN npm ci\nfailed to solve: process \"/bin/sh -c npm ci\" did not complete successfully") === "docker-build-failed");
  r.check("npm resolution failure", code("Build failed", "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree") === "install-failed");

  const status = explainDeployError("Health check failed after 30s: / responded 502, expected 200");
  r.check("health check with a bad status", status.code === "health-wrong-status" && status.title.includes("502"));
  const port = explainDeployError("Health check failed after 30s: port 3000 not responding on /");
  r.check("health check with no answer names the port", port.code === "health-no-answer" && port.title.includes("3000"));
  r.check("and offers the port and the health check as fixes", port.fixes.includes("port") && port.fixes.includes("healthcheck"));

  r.check("a generic build failure", code("Build failed", "> next build\nType error: x is not assignable\n") === "build-failed");
  r.check("an unknown message falls back to the log", code("qualcosa di nuovo", "") === "unknown");
  r.check("no message at all is still an explanation", explainDeployError(null, null).fixes.includes("logs"));

  r.check("phase: nothing yet", deployPhase("") === "queued");
  r.check("phase: building", deployPhase("=== Deploy started ===\n\n--- Fetching source ---\nok\n\n--- Building ---\nnpm ci") === "build");
  r.check("phase: health check", deployPhase("--- Fetching source ---\n--- Building ---\n--- Starting application ---\n--- Health check ---") === "health");
  r.check("phase: done", deployPhase("--- Health check ---\nok\n\n=== Deploy successful ===") === "done");
  r.check("phase: failed wins", deployPhase("--- Building ---\n\n=== Deploy FAILED: Build failed ===") === "failed");

  return r.result();
}
