import { parseContractJson } from "@/lib/deploy-contract";
import type { Project } from "./types";

/**
 * Whether there is something to deploy.
 *
 * A GitHub project needs its address; an uploaded one needs files on disk,
 * which the first upload creates. Before that, "Deploy" can only fail with
 * "no source", so the page offers "Scegli la sorgente" instead.
 */
export function projectHasSource(project: Project): boolean {
  if (project.source_type === "github") return Boolean(project.source_url);
  return project.deploy_count > 0 || Boolean(project.repo_location?.real);
}

/** Build-time values can be tokens (`NPM_TOKEN`): the names travel, the values do not. */
function withoutBuildValues<T extends { buildEnv: Record<string, string> }>(contract: T): T {
  return { ...contract, buildEnv: Object.fromEntries(Object.keys(contract.buildEnv).map((key) => [key, ""])) };
}

/**
 * Download the project's configuration as JSON: what it runs and how, never
 * its secrets.
 *
 * The variables, the webhook secret and the access passwords stay out: this is
 * a file people attach to an issue or keep next to the repository.
 */
export function exportProjectConfig(project: Project): void {
  const config = {
    $schema: "runpanel-project-config/1",
    exportedAt: new Date().toISOString(),
    name: project.name,
    source: {
      type: project.source_type,
      url: project.source_type === "github" ? project.source_url : null,
      branch: project.source_branch,
    },
    runtime: project.runtime_type,
    port: project.port,
    autoDeploy: Boolean(project.auto_deploy),
    restartCron: project.restart_cron || null,
    contract: withoutBuildValues(parseContractJson(project.builder_config)),
    hosts: (project.hosts ?? []).map((host) => host.hostname),
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.slug}.runpanel.json`;
  link.click();
  URL.revokeObjectURL(url);
}
