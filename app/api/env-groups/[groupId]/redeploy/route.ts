import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { PROJECT_ACTIONS, projectAccess, satisfies } from "@/lib/authz";
import { projectRefs } from "@/lib/principal";
import { getDb } from "@/lib/db";
import { enqueueDeploy } from "@/services/deploy-queue";
import { groupUsage } from "@/services/env-groups";

type Params = { params: Promise<{ groupId: string }> };

/** States in which a project is serving, or trying to: a redeploy brings it the change. */
const LIVE = new Set(["running", "error", "deploying"]);

/**
 * "Ridistribuisci i progetti interessati": a deploy for every project the group
 * reaches, so a change to it does not wait for each one's next deploy.
 *
 * Only projects that are up, or were meant to be: one somebody stopped stays
 * stopped — a bulk action must not start what was turned off on purpose — and
 * one never deployed has nothing to redeploy. Each needs the right to deploy
 * it; the others are listed, the ones this account cannot see only counted.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "deploy", action: "env-group.redeploy", scope: "permission", scopeId: "variables" }, async () => {
    const denied = await requirePermission("variables");
    if (isDenied(denied)) return denied;
    const { groupId } = await params;

    const db = await getDb();
    const group = await db.selectFrom("env_groups").select(["id", "name"]).where("id", "=", groupId).executeTakeFirst();
    if (!group) return NextResponse.json({ error: "Gruppo non trovato" }, { status: 404 });

    const usage = await groupUsage(group);
    const refs = await projectRefs();
    const deployed = new Set(
      (
        await db
          .selectFrom("deployments")
          .select("project_id")
          .where("status", "in", ["running", "superseded"])
          .groupBy("project_id")
          .execute()
      ).map((row) => row.project_id)
    );

    const started: { id: string; name: string; status: "started" | "queued" }[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    let hidden = 0;

    for (const project of [...usage.attached.map((a) => a.project), ...usage.referencing]) {
      const ref = refs.get(project.id);
      const access = ref ? projectAccess(denied.principal, ref) : null;
      if (!access || access.level === null) {
        hidden++;
        continue;
      }
      if (!satisfies(access, PROJECT_ACTIONS.deploy)) {
        skipped.push({ id: project.id, name: project.name, reason: "non hai il permesso di fare il deploy" });
        continue;
      }
      if (!deployed.has(project.id)) {
        skipped.push({ id: project.id, name: project.name, reason: "non è mai stato distribuito" });
        continue;
      }
      if (!LIVE.has(project.status)) {
        skipped.push({ id: project.id, name: project.name, reason: "è fermo: resta fermo" });
        continue;
      }
      const result = await enqueueDeploy(project.id, { mode: "deploy", trigger: "manual", commitSha: null, commitMessage: null });
      if (result.status === "started" || result.status === "queued") {
        started.push({ id: project.id, name: project.name, status: result.status });
      } else {
        skipped.push({
          id: project.id,
          name: project.name,
          reason: result.status === "unavailable" ? "il pannello si sta riavviando" : "non esiste più",
        });
      }
    }

    return NextResponse.json({ started, skipped, hidden });
  });
}
