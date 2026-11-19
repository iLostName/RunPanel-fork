import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostIfReaching } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { SERVICE_ACTIONS, hasPermission, projectAccess, satisfies, serviceAccess } from "@/lib/authz";
import { projectRefs, serviceRefs } from "@/lib/principal";
import { getDb, nowIso } from "@/lib/db";
import { refText, resolveEffective, mergeLayers } from "@/lib/env-refs";
import { projectEnvGroupsSchema } from "@/lib/validation";
import { attachedGroupIds, loadGroups } from "@/services/env-groups";
import { findProject, findService, loadSnapshot, lookupFor } from "@/services/project-env";

type Params = { params: Promise<{ projectId: string }> };

/** The groups a project receives, first to last, with their variable names (never their values). */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "env.read");
  if (isDenied(denied)) return denied;

  const [ids, groups] = await Promise.all([attachedGroupIds(projectId), loadGroups()]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  return NextResponse.json(
    ids
      .map((id, position) => {
        const group = byId.get(id);
        return group
          ? { id, name: group.name, description: group.description, position, keys: [...group.vars.map((v) => v.key), ...group.unreadable].sort() }
          : null;
      })
      .filter(Boolean)
  );
}

/**
 * Set which groups a project receives and in which order: the whole list.
 *
 * Attaching a group is reading it — the app receives its values, and whoever
 * manages the project can have the app print them — so a group that was not
 * attached before needs the Variabili condivise permission, and every database
 * and project its values point at must be readable by whoever attaches it.
 * Taking a group off, or moving one, needs only what changing the project's
 * own variables needs: nothing new reaches the app that the project did not
 * already have.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.env-groups", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "env.write");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, "cambiare le variabili di un progetto che gira sull'host");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = projectEnvGroupsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }
    const { groupIds } = parsed.data;

    const [current, groups] = await Promise.all([attachedGroupIds(projectId), loadGroups()]);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const missing = groupIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return NextResponse.json({ error: "Uno dei gruppi non esiste più su questo server: ricarica la pagina" }, { status: 404 });
    }

    const added = groupIds.filter((id) => !current.includes(id));
    if (added.length > 0) {
      if (!hasPermission(denied.principal, "variables")) {
        return NextResponse.json(
          { error: "Per collegare un gruppo serve il permesso «Variabili condivise»: chi lo collega ne legge i valori", code: "variables_required" },
          { status: 403 }
        );
      }

      // What the added groups point at, for the same reason a reference typed
      // into the project is checked: through the app it becomes readable.
      const snap = await loadSnapshot(projectId);
      const lookup = lookupFor(snap, "host");
      const [projects, services] = await Promise.all([projectRefs(), serviceRefs()]);
      for (const id of added) {
        const group = byId.get(id)!;
        const layer = { id: group.id, name: group.name, vars: group.vars };
        for (const v of resolveEffective(mergeLayers([layer], []), lookup).vars) {
          for (const ref of v.refs) {
            if (ref.kind === "db") {
              const found = findService(snap, ref);
              if ("problem" in found) continue;
              const target = services.get(found.service.id);
              if (!target || !satisfies(serviceAccess(denied.principal, target), SERVICE_ACTIONS.credentials)) {
                return NextResponse.json(
                  { error: `Il gruppo «${group.name}» usa ${refText(ref)}: per collegarlo devi poter vedere le credenziali di quel database` },
                  { status: 403 }
                );
              }
            } else if (ref.kind === "project") {
              const found = findProject(snap, ref);
              if ("problem" in found) continue;
              const target = projects.get(found.project.id);
              if (!target || projectAccess(denied.principal, target).level === null) {
                return NextResponse.json(
                  { error: `Il gruppo «${group.name}» usa ${refText(ref)}, che non porta a niente: correggilo prima di collegarlo` },
                  { status: 403 }
                );
              }
            }
          }
        }
      }
    }

    const db = await getDb();
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("project_env_groups").where("project_id", "=", projectId).execute();
      if (groupIds.length > 0) {
        await trx
          .insertInto("project_env_groups")
          .values(groupIds.map((groupId, position) => ({ project_id: projectId, group_id: groupId, position, created_at: now })))
          .execute();
      }
    });

    return NextResponse.json({ success: true, groupIds });
  });
}
