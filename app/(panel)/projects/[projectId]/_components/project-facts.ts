import { buildConfigFile } from "@/lib/project-config-file";
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

/**
 * Download the project's configuration as JSON: what it runs and how, never
 * its secrets.
 *
 * The variables, the webhook secret and the access passwords stay out: this is
 * a file people attach to an issue or keep next to the repository.
 */
export function exportProjectConfig(project: Project): void {
  // The format, and what it leaves out, is lib/project-config-file.ts.
  const config = buildConfigFile(project);
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.slug}.runpanel.json`;
  link.click();
  URL.revokeObjectURL(url);
}
