import { getDb } from "@/lib/db";
import { parseContractJson } from "@/lib/deploy-contract";
import { listenPort, type AccessRow } from "@/lib/access-columns";

/**
 * Which apps the uptime check asks, and where.
 *
 * The answer is the health check the project already has: its path, its port,
 * the statuses it expects. A project with the check turned off, or with no port
 * at all — a bot, a worker, a queue consumer — is not asked: there is nothing
 * listening to ask, and every minute of "no answer" would be a lie.
 *
 * The contract is the one the app is running with (its last deploy), so a
 * repository that turned the check off is respected; the path and the port are
 * read from the project's own settings, because a repository can never set
 * them (`PANEL_ONLY_FIELDS`) and an operator who just corrected the path should
 * not have to redeploy for the check to follow.
 */

export type UptimeSkip = "disabled" | "no-port" | "not-running";

export interface UptimeTarget {
  projectId: string;
  name: string;
  port: number;
  path: string;
  expectStatus: number[];
}

export interface UptimePlan {
  target: UptimeTarget | null;
  /** Why there is no target. */
  skip: UptimeSkip | null;
  /** What would be asked, for the card to say — also when it is not. */
  path: string;
  port: number | null;
  expectStatus: number[];
}

export interface PlannableProject extends AccessRow {
  id: string;
  name: string;
  status: string;
  port: number | null;
  builder_config: string;
}

/** Only `running`: a project being deployed or stopped by hand is not expected to answer. */
export function isWatchedStatus(status: string): boolean {
  return status === "running";
}

export async function runningContract(projectId: string): Promise<string | null> {
  const db = await getDb();
  const last = await db
    .selectFrom("deployments")
    .select("resolved_contract")
    .where("project_id", "=", projectId)
    .where("status", "in", ["running", "superseded"])
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return last?.resolved_contract ?? null;
}

export function planFor(project: PlannableProject, resolvedContract: string | null): UptimePlan {
  const current = parseContractJson(project.builder_config).healthcheck;
  const running = resolvedContract ? parseContractJson(resolvedContract).healthcheck : current;

  const path = current.path || "/";
  const port = current.port ?? (project.port ? listenPort(project, project.port) : null);
  const expectStatus = running.expectStatus;
  const base = { path, port, expectStatus };

  if (!running.enabled || !current.enabled) return { ...base, target: null, skip: "disabled" };
  if (!port) return { ...base, target: null, skip: "no-port" };
  if (!isWatchedStatus(project.status)) return { ...base, target: null, skip: "not-running" };
  return { ...base, skip: null, target: { projectId: project.id, name: project.name, port, path, expectStatus } };
}
