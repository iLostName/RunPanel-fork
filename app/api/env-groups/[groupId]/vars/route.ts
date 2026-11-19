import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb, nowIso } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { generateId } from "@/lib/utils";
import { findCycle, parseValue } from "@/lib/env-refs";
import { envVarsIssueText, envVarsSchema } from "@/lib/validation";
import { groupUsage, loadGroups } from "@/services/env-groups";
import { checkReferences, issuesResponse } from "@/services/env-ref-access";
import { hostGuardForGroup, readersText, usageFor } from "@/services/env-group-guard";
import { loadSnapshot } from "@/services/project-env";

type Params = { params: Promise<{ groupId: string }> };

/**
 * Replace every variable of a group, as the project variables are replaced.
 *
 * Refused, before anything is written:
 * - a reference written wrong, to something missing, to something the writer
 *   could not read, or one that closes a loop;
 * - removing a name another group or a project still reads by reference;
 * - without "Accesso all'host", any change reaching a project that runs on
 *   the host.
 * Projects pick the change up at their next deploy or restart; the answer
 * says how many that is, for the page to offer redeploying them.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "env-group.vars", scope: "permission", scopeId: "variables" }, async () => {
    const denied = await requirePermission("variables");
    if (isDenied(denied)) return denied;
    const { groupId } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = envVarsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: envVarsIssueText(body, parsed.error.issues), details: parsed.error.issues }, { status: 400 });
    }
    const vars = parsed.data.vars;

    const groups = await loadGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) return NextResponse.json({ error: "Gruppo non trovato" }, { status: 404 });

    const before = new Map(group.vars.map((v) => [v.key, v.value]));
    const after = new Map(vars.map((v) => [v.key, v.value]));
    const changed =
      group.unreadable.length > 0 ||
      before.size !== after.size ||
      [...after].some(([key, value]) => before.get(key) !== value);

    const usage = await groupUsage(group, groups);
    if (changed) {
      const noHost = await hostGuardForGroup(denied.principal, usage);
      if (noHost) return noHost;
    }

    // A name somebody reads by reference cannot go: their deploy would stop on it.
    for (const key of [...before.keys(), ...group.unreadable]) {
      if (after.has(key)) continue;
      const readers = usage.readers.get(key) ?? [];
      if (readers.length > 0) {
        return NextResponse.json(
          {
            error: `${key} è usata nei riferimenti ${await readersText(denied.principal, readers)}: toglila prima da lì, o il prossimo deploy di chi la usa si fermerà.`,
            code: "var_referenced",
          },
          { status: 409 }
        );
      }
    }

    // Checked against the group as it will be, so a reference to a name added
    // in this same save resolves, and one to a name removed in it does not.
    const snap = await loadSnapshot("");
    snap.groups = snap.groups.map((g) => (g.id === group.id ? { ...g, vars, unreadable: [] } : g));
    const readsItself = (value: string) => parseValue(value).refs.some((ref) => ref.kind === "shared" && ref.group === group.name);
    const issues = await checkReferences({
      principal: denied.principal,
      values: vars,
      before: group.vars.map((v) => v.value),
      snap,
      groupName: group.name,
      alwaysResolve: readsItself,
    });

    // A loop through another group is only visible with every group in view.
    if (issues.length === 0) {
      const cycle = findCycle(snap.groups);
      const mine = cycle?.find((node) => node.startsWith(`${group.name}.`));
      if (cycle && mine) {
        const key = mine.slice(group.name.length + 1);
        const index = vars.findIndex((v) => v.key === key);
        issues.push({
          index: Math.max(0, index),
          key,
          forbidden: false,
          message: `La variabile ${key} del gruppo «${group.name}» chiude un riferimento circolare: ${cycle.join(" → ")}.`,
        });
      }
    }
    if (issues.length > 0) {
      const { status, body: out } = issuesResponse(issues);
      return NextResponse.json(out, { status });
    }

    const db = await getDb();
    const now = nowIso();
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("env_group_vars").where("group_id", "=", groupId).execute();
      if (vars.length > 0) {
        await trx
          .insertInto("env_group_vars")
          .values(vars.map((v) => ({ id: generateId(), group_id: groupId, key: v.key, value: encrypt(v.value), created_at: now })))
          .execute();
      }
      await trx.updateTable("env_groups").set({ updated_at: now }).where("id", "=", groupId).execute();
    });

    const view = await usageFor(denied.principal, usage);
    return NextResponse.json({
      success: true,
      count: vars.length,
      changed,
      affected: view.attached.length + view.referencing.length + view.hidden,
    });
  });
}
