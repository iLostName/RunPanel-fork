import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { requireHostIfReaching } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { PROJECT_ACTIONS, satisfies } from "@/lib/authz";
import { getDb, nowIso } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { generateId } from "@/lib/utils";
import { envVarsSchema, envVarsIssueText } from "@/lib/validation";
import { loadOwnVars } from "@/services/env-groups";
import { checkReferences, issuesResponse } from "@/services/env-ref-access";
import { loadSnapshot } from "@/services/project-env";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "env.read");
  if (isDenied(denied)) return denied;
  // Values in clear only for whoever manages the project; everyone else gets
  // the keys with masked values, whatever the query string asks for.
  const reveal =
    request.nextUrl.searchParams.get("reveal") === "true" && satisfies(denied.access, PROJECT_ACTIONS["env.reveal"]);

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select("id")
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }

  const rows = await db
    .selectFrom("env_vars")
    .select(["id", "key", "value"])
    .where("project_id", "=", projectId)
    .orderBy("key")
    .execute();

  const vars = rows.map((row) => ({
    id: row.id,
    key: row.key,
    value: reveal ? decrypt(row.value) : "••••••••",
  }));

  // `?reveal=true` puts decrypted values in this body. Nothing between here and
  // the browser — a proxy, a service worker, the disk cache — should keep a copy.
  return NextResponse.json(vars, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.env", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "env.write");
    if (isDenied(denied)) return denied;
    const noHost = await requireHostIfReaching(denied.principal, projectId, "cambiare le variabili di un progetto che gira sull'host");
    if (noHost) return noHost;
    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = envVarsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: envVarsIssueText(body, parsed.error.issues), details: parsed.error.issues },
        { status: 400 }
      );
    }

    const db = await getDb();
    const project = await db
      .selectFrom("projects")
      .select("id")
      .where("id", "=", projectId)
      .executeTakeFirst();

    if (!project) {
      return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    }

    // References: written right, pointing at something that exists, and only
    // at what this account could read itself — checked for the ones that are
    // new, against the variables as they will be (services/env-ref-access.ts).
    const stored = await loadOwnVars(projectId);
    const snap = await loadSnapshot(projectId);
    snap.own = parsed.data.vars;
    snap.ownUnreadable = [];
    const issues = await checkReferences({
      principal: denied.principal,
      values: parsed.data.vars,
      before: stored.vars.map((v) => v.value),
      snap,
    });
    if (issues.length > 0) {
      const { status, body: out } = issuesResponse(issues);
      return NextResponse.json(out, { status });
    }

    const now = nowIso();
    const rows = parsed.data.vars.map((v) => ({
      id: generateId(),
      project_id: projectId,
      key: v.key,
      value: encrypt(v.value),
      created_at: now,
    }));

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("env_vars").where("project_id", "=", projectId).execute();
      if (rows.length > 0) {
        await trx.insertInto("env_vars").values(rows).execute();
      }
    });

    return NextResponse.json({ success: true, count: rows.length });
  });
}
