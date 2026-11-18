import fs from "fs";
import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { parseContractJson } from "@/lib/deploy-contract";
import type { ProjectTasksTable, ProjectsTable } from "@/lib/db/schema";
import { SKIP_REASONS, type SkipCode } from "@/lib/tasks-rules";
import { composeContext, composePs } from "../docker/compose";
import { appContainerName } from "../docker/labels";
import { getRepoPath } from "../git-manager";
import { projectWorkDir } from "../project-releases";
import { assertOwnAppContainer, ForeignContainerError } from "../process-drivers/docker-driver";
import { processManager } from "../process-manager";
import { injectLinkedServiceEnv } from "../service-injection";

/**
 * Where a task's command runs, worked out at the moment it is about to.
 *
 *  - **Docker**: in the app's own container, with `docker exec` — the same
 *    environment, files and network the app has, because they are the app's.
 *  - **Compose**: in the container of the service the task names.
 *  - **Native** (node, static, custom): on the host, in the folder of the
 *    version that runs, with the variables a restart gives the app — the
 *    project's own and the connection strings of its linked services.
 *
 * A container that is not running is a skip, not a failure: the command did
 * not get to run, and an app stopped on purpose is not the task's fault.
 */

export type ExecTarget =
  | { kind: "container"; container: string; where: string }
  | { kind: "host"; cwd: string; env: Record<string, string>; where: string };

export type TargetResult = { ok: true; target: ExecTarget } | { ok: false; code: SkipCode; reason: string };

const skip = (code: SkipCode, reason = SKIP_REASONS[code]): TargetResult => ({ ok: false, code, reason });

export async function resolveTarget(
  project: ProjectsTable,
  task: Pick<ProjectTasksTable, "service">
): Promise<TargetResult> {
  if (project.runtime_type === "docker") return dockerTarget(project);
  if (project.runtime_type === "compose") return composeTarget(project, task.service);
  return hostTarget(project);
}

async function dockerTarget(project: ProjectsTable): Promise<TargetResult> {
  try {
    // A slug that clashes with a service's container would otherwise get the
    // command run inside that database, with its password in the environment.
    if (!(await assertOwnAppContainer(project.slug))) {
      return skip("not-running", "il container dell'app non esiste ancora: fai prima un deploy");
    }
  } catch (err) {
    if (err instanceof ForeignContainerError) return skip("not-running", err.message);
    return skip("not-running", "Docker non risponde");
  }

  const info = await processManager.status(project.slug, "docker").catch(() => ({ running: false }));
  if (!info.running) return skip("not-running");

  const container = appContainerName(project.slug);
  return { ok: true, target: { kind: "container", container, where: `nel container ${container}` } };
}

async function composeTarget(project: ProjectsTable, service: string | null): Promise<TargetResult> {
  if (!service) {
    return skip("context-changed", "manca il servizio dello stack in cui far girare il comando: apri l'attività e sceglilo");
  }
  const ctx = composeContext(project.slug, getRepoPath(project.slug));
  if (!ctx) return skip("no-directory", "il progetto non ha ancora un file compose sul server: fai prima un deploy");

  // Listed under the stack's own project name, so a container found here is
  // the stack's and nobody else's.
  const found = (await composePs(ctx)).find((entry) => entry.name === service);
  if (!found?.container || found.state !== "running") {
    return skip("not-running", `il servizio «${service}» dello stack non è in esecuzione`);
  }
  return { ok: true, target: { kind: "container", container: found.container, where: `nel servizio ${service} (${found.container})` } };
}

async function hostTarget(project: ProjectsTable): Promise<TargetResult> {
  // The version the app runs from — its release folder when it has one, where
  // its node_modules are and its data is linked in — not the project folder,
  // which a deploy that failed may already have moved to another commit.
  const cwd = projectWorkDir(project.slug);
  if (!fs.existsSync(cwd)) return skip("no-directory");
  return { ok: true, target: { kind: "host", cwd, env: await taskEnv(project), where: `sull'host, in ${cwd}` } };
}

/**
 * The environment a native task runs with: what a restart gives the app.
 *
 * The contract of the last deploy that worked, for the reason
 * `project-restart.ts` gives — `builder_config` alone misses what the
 * repository and the preset contributed, the network among them, and that
 * decides which address a linked database is reached at.
 */
async function taskEnv(project: ProjectsTable): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.selectFrom("env_vars").select(["key", "value"]).where("project_id", "=", project.id).execute();

  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      env[row.key] = decrypt(row.value);
    } catch {
      // One unreadable value is not a reason to run nothing; the app has the
      // same problem and the variables page shows it.
    }
  }

  const lastDeploy = await db
    .selectFrom("deployments")
    .select("resolved_contract")
    .where("project_id", "=", project.id)
    .where("status", "in", ["running", "superseded"])
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const contract = lastDeploy?.resolved_contract
    ? parseContractJson(lastDeploy.resolved_contract)
    : parseContractJson(project.builder_config);

  await injectLinkedServiceEnv(project, contract.docker.network, env);

  // The two `buildStartOpts` sets on every start, with the same precedence.
  const port = project.port ?? 3000;
  if (port > 0) env.PORT = String(port);
  if (!env.NODE_ENV) env.NODE_ENV = "production";
  return env;
}

/** The services of a Compose stack, for the editor: empty while the stack is down. */
export async function composeServiceNames(project: Pick<ProjectsTable, "slug">): Promise<string[]> {
  const ctx = composeContext(project.slug, getRepoPath(project.slug));
  if (!ctx) return [];
  const services = await composePs(ctx).catch(() => []);
  return [...new Set(services.map((entry) => entry.name))].sort((a, b) => a.localeCompare(b));
}
