import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { generateId } from "@/lib/utils";
import { createEnvGroupSchema, envVarsIssueText } from "@/lib/validation";
import { groupUsage, loadGroups, loadUsageContext } from "@/services/env-groups";
import { checkReferences, issuesResponse } from "@/services/env-ref-access";
import { loadSnapshot } from "@/services/project-env";
import { hostGuardForGroup } from "@/services/env-group-guard";

/**
 * The shared variable groups of this server.
 *
 * Reading the list needs the Variabili condivise permission, like everything
 * about groups: the names alone say which services the panel holds secrets
 * for. A project's own Variables tab shows the groups it has to anyone who may
 * read the project, without their values.
 */
export async function GET() {
  const denied = await requirePermission("variables");
  if (isDenied(denied)) return denied;

  const groups = await loadGroups();
  // The projects and their variables read once, not once per group.
  const context = await loadUsageContext();
  const usage = await Promise.all(groups.map((group) => groupUsage(group, groups, context)));
  return NextResponse.json(
    groups.map((group, i) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      keys: [...group.vars.map((v) => v.key), ...group.unreadable].sort(),
      projectCount: usage[i].attached.length + usage[i].referencing.length,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    })),
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  return withAudit(request, { category: "config", action: "env-group.create", scope: "permission", scopeId: "variables" }, async () => {
    const denied = await requirePermission("variables");
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = createEnvGroupSchema.safeParse(body);
    if (!parsed.success) {
      const onVars = parsed.error.issues[0]?.path[0] === "vars";
      return NextResponse.json(
        { error: onVars ? envVarsIssueText(body, parsed.error.issues) : (parsed.error.issues[0]?.message ?? "Dati non validi"), details: parsed.error.issues },
        { status: 400 }
      );
    }
    const { name, description = null, vars = [] } = parsed.data;

    const db = await getDb();
    if (await db.selectFrom("env_groups").select("id").where("name", "=", name).executeTakeFirst()) {
      return NextResponse.json({ error: `Esiste già un gruppo «${name}» su questo server` }, { status: 409 });
    }

    // References already waiting for this name start resolving the moment it
    // exists: whatever this group holds then reaches those projects.
    const waiting = await groupUsage({ id: "", name });
    if (vars.length > 0) {
      const noHost = await hostGuardForGroup(denied.principal, waiting);
      if (noHost) return noHost;

      const id = generateId();
      const snap = await loadSnapshot("");
      snap.groups = [...snap.groups, { id, name, description, createdAt: "", updatedAt: "", vars, unreadable: [] }];
      const issues = await checkReferences({ principal: denied.principal, values: vars, before: [], snap, groupName: name });
      if (issues.length > 0) {
        const { status, body: out } = issuesResponse(issues);
        return NextResponse.json(out, { status });
      }
      return NextResponse.json(await insertGroup(id, name, description, vars, denied.session.user.id), { status: 201 });
    }

    return NextResponse.json(await insertGroup(generateId(), name, description, [], denied.session.user.id), { status: 201 });
  });
}

async function insertGroup(
  id: string,
  name: string,
  description: string | null,
  vars: { key: string; value: string }[],
  userId: string
): Promise<{ id: string; name: string; description: string | null; count: number }> {
  const db = await getDb();
  const now = nowIso();
  await db.transaction().execute(async (trx) => {
    await trx.insertInto("env_groups").values({ id, name, description, created_by: userId, created_at: now, updated_at: now }).execute();
    if (vars.length > 0) {
      await trx
        .insertInto("env_group_vars")
        .values(vars.map((v) => ({ id: generateId(), group_id: id, key: v.key, value: encrypt(v.value), created_at: now })))
        .execute();
    }
  });
  return { id, name, description, count: vars.length };
}
