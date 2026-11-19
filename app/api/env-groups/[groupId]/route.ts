import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { updateEnvGroupSchema } from "@/lib/validation";
import { findCycle, parseValue } from "@/lib/env-refs";
import { groupUsage, loadGroups } from "@/services/env-groups";
import { hostGuardForGroup, readersText, usageFor } from "@/services/env-group-guard";

type Params = { params: Promise<{ groupId: string }> };

/**
 * One group: its variables and who uses it.
 *
 * `?reveal=true` opens the values; anyone who may read the list may read them,
 * since the permission is what reading a group means. The answer is never
 * cached, for the reason the project variables are not.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const denied = await requirePermission("variables");
  if (isDenied(denied)) return denied;
  const { groupId } = await params;
  const reveal = request.nextUrl.searchParams.get("reveal") === "true";

  const groups = await loadGroups();
  const group = groups.find((g) => g.id === groupId);
  if (!group) return NextResponse.json({ error: "Gruppo non trovato" }, { status: 404 });

  const usage = await groupUsage(group, groups);
  return NextResponse.json(
    {
      id: group.id,
      name: group.name,
      description: group.description,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      vars: group.vars.map((v) => ({ key: v.key, value: reveal ? v.value : "••••••••" })),
      unreadable: group.unreadable,
      usage: await usageFor(denied.principal, usage),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "env-group.update", scope: "permission", scopeId: "variables" }, async () => {
    const denied = await requirePermission("variables");
    if (isDenied(denied)) return denied;
    const { groupId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = updateEnvGroupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const db = await getDb();
    const group = await db.selectFrom("env_groups").selectAll().where("id", "=", groupId).executeTakeFirst();
    if (!group) return NextResponse.json({ error: "Gruppo non trovato" }, { status: 404 });

    const { name, description } = parsed.data;
    if (name !== undefined && name !== group.name) {
      if (await db.selectFrom("env_groups").select("id").where("name", "=", name).executeTakeFirst()) {
        return NextResponse.json({ error: `Esiste già un gruppo «${name}» su questo server` }, { status: 409 });
      }
      // A reference finds the group by name: renaming it under one would
      // stop that project's next deploy. Said now, with who to fix — the
      // group itself included, when one of its values reads another.
      const groups = await loadGroups();
      const usage = await groupUsage(group, groups);
      const readers = [...usage.readers.values()].flat();
      const self = groups.find((g) => g.id === groupId);
      if (self?.vars.some((v) => parseValue(v.value).refs.some((ref) => ref.kind === "shared" && ref.group === group.name))) {
        readers.push({ kind: "group", id: group.id, name: group.name });
      }
      if (readers.length > 0) {
        return NextResponse.json(
          {
            error: `Il nome «${group.name}» è usato nei riferimenti ${await readersText(denied.principal, readers)}: cambiali prima, o il prossimo deploy di chi li usa si fermerà.`,
            code: "group_referenced",
          },
          { status: 409 }
        );
      }
      // References waiting for the new name start reading this group: the
      // projects they are in, and any loop they close, are this change's.
      const noHost = await hostGuardForGroup(denied.principal, await groupUsage({ id: "", name }));
      if (noHost) return noHost;
      const renamed = groups.map((g) => (g.id === groupId ? { ...g, name } : g));
      const cycle = findCycle(renamed);
      if (cycle) {
        return NextResponse.json(
          { error: `Con il nome «${name}» alcuni riferimenti farebbero un giro chiuso: ${cycle.join(" → ")}.` },
          { status: 409 }
        );
      }
    }

    const updated = {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      updated_at: nowIso(),
    };
    await db.updateTable("env_groups").set(updated).where("id", "=", groupId).execute();
    return NextResponse.json({ ...group, ...updated });
  });
}

/**
 * Deleting a group detaches it from every project: from their next deploy or
 * restart they no longer receive its variables, which the confirmation says
 * project by project. A group still named by a reference is refused instead —
 * that reference would stop its project's next deploy, or its restart after a
 * reboot, which is worse than being told now.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "delete", action: "env-group.delete", scope: "permission", scopeId: "variables" }, async () => {
    const denied = await requirePermission("variables");
    if (isDenied(denied)) return denied;
    const { groupId } = await params;

    const db = await getDb();
    const group = await db.selectFrom("env_groups").selectAll().where("id", "=", groupId).executeTakeFirst();
    if (!group) return NextResponse.json({ error: "Gruppo non trovato" }, { status: 404 });

    const usage = await groupUsage(group);
    const readers = [...usage.readers.values()].flat();
    if (readers.length > 0) {
      return NextResponse.json(
        {
          error: `«${group.name}» è usato nei riferimenti ${await readersText(denied.principal, readers)}: toglili prima, o il prossimo deploy di chi li usa si fermerà.`,
          code: "group_referenced",
        },
        { status: 409 }
      );
    }

    // The attachments go with it (ON DELETE CASCADE), and so do its variables.
    await db.deleteFrom("env_groups").where("id", "=", groupId).execute();
    return NextResponse.json({ success: true, detached: usage.attached.length });
  });
}
