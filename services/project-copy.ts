import crypto from "crypto";
import { getDb, nowIso } from "@/lib/db";
import type { DeployTrigger, EnvironmentKind, ProjectsTable } from "@/lib/db/schema";
import { firstFreePort, portsInUse } from "@/lib/ports";
import { generateId } from "@/lib/utils";
import { allocateLoopbackPort } from "./access-gate";
import { restartScheduleColumns } from "./restart-scheduler";

/**
 * A new project row made from another one: same code and same way of building
 * it, its own everything else.
 *
 * Shared by "Duplica" and by the environments (services/environments.ts), so
 * there is one list of what a copy never shares with its source:
 * - bind mounts — two containers writing into one host folder;
 * - the port — the first free one from the source's;
 * - the webhook secret, the hook id, the commit the poller saw, any pin;
 * - addresses, databases and variables are rows of their own, which the
 *   callers copy or not.
 */

/** The deploy contract without its bind mounts. An unreadable one is copied as it is, like the original keeps it. */
export function withoutMounts(builderConfig: string): string {
  try {
    const contract = JSON.parse(builderConfig || "{}") as { docker?: { mounts?: unknown } };
    if (contract.docker && "mounts" in contract.docker) {
      delete contract.docker.mounts;
      return JSON.stringify(contract);
    }
  } catch {
    /* kept as it is */
  }
  return builderConfig;
}

/** The first port at or above `wanted` that nothing on this panel publishes. */
export async function freePortFrom(wanted: number | null): Promise<number | null> {
  if (!wanted) return null;
  const db = await getDb();
  const [projectPorts, servicePorts] = await Promise.all([
    db.selectFrom("projects").select(["port", "access_port", "live_port"]).execute(),
    db.selectFrom("services").select(["port", "access_port"]).execute(),
  ]);
  return firstFreePort(wanted, portsInUse([...projectPorts, ...servicePorts]));
}

export interface CopyRowInput {
  source: ProjectsTable;
  name: string;
  slug: string;
  /** Another branch than the source's, for a staging copy. */
  sourceBranch?: string;
  /** Set for an environment: whose, and which kind. */
  environment?: { of: string; kind: EnvironmentKind };
  /**
   * The source's settings as well, for an environment that is meant to behave
   * like its production: who may reach the port (with a loopback port of its
   * own), the start at boot, the scheduled restart, and how auto-deploy hears
   * about a push. A plain copy starts with none of them.
   */
  settings?: boolean;
  /**
   * Who may reach the port only, for a preview: it runs production's code and
   * must not be more open than production, but starts at no boot and
   * restarts on no schedule — it comes and goes with its pull request.
   */
  access?: boolean;
  autoDeploy?: boolean;
  deployTrigger?: DeployTrigger | null;
  /** A commit to hold the copy at, for a preview: its pull request's head. */
  pinnedSha?: string | null;
}

/** Insert the copy and read it back. */
export async function insertProjectCopy(input: CopyRowInput): Promise<ProjectsTable> {
  const { source } = input;
  const db = await getDb();
  const id = generateId();
  const now = nowIso();
  const copyAccess = input.settings === true || input.access === true;
  const restricted = copyAccess && source.access_mode === "restricted";

  await db
    .insertInto("projects")
    .values({
      id,
      name: input.name,
      slug: input.slug,
      app_name: null,
      source_type: source.source_type,
      source_url: source.source_url,
      source_branch: input.sourceBranch ?? source.source_branch,
      runtime_type: source.runtime_type,
      builder_config: withoutMounts(source.builder_config),
      port: await freePortFrom(source.port),
      status: "stopped",
      auto_deploy: input.autoDeploy ? 1 : 0,
      deploy_trigger: input.deployTrigger ?? null,
      webhook_secret: crypto.randomBytes(20).toString("hex"),
      pinned_sha: input.pinnedSha ?? null,
      pinned_at: input.pinnedSha ? now : null,
      folder_id: source.folder_id,
      backup_settings: source.backup_settings,
      environment_of: input.environment?.of ?? null,
      environment: input.environment?.kind ?? null,
      ...(copyAccess
        ? {
            access_mode: source.access_mode,
            access_allow: source.access_allow,
            // Allocated now and kept, as the settings do: the first deploy
            // brings the gate up on it (services/deploy-pipeline.ts).
            access_port: restricted ? await allocateLoopbackPort() : null,
          }
        : {}),
      ...(input.settings
        ? {
            autostart: source.autostart,
            autostart_order: source.autostart_order,
            autostart_delay_s: source.autostart_delay_s,
            autostart_wait_healthy: source.autostart_wait_healthy,
            ...(await restartScheduleColumns(source.restart_cron ?? "").catch(() => ({ restart_cron: "", restart_next_at: null }))),
          }
        : {}),
      created_at: now,
      updated_at: now,
    })
    .execute();

  return db.selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}
