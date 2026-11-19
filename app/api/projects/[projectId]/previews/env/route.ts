import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { PROJECT_ACTIONS, satisfies } from "@/lib/authz";
import { requireHostIfReaching } from "@/lib/host-guard";
import { getDb, nowIso } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { generateId } from "@/lib/utils";
import { envVarsIssueText, envVarsSchema } from "@/lib/validation";
import { loadPreviewVars } from "@/services/env-groups";
import { checkReferences, issuesResponse } from "@/services/env-ref-access";
import { loadSnapshot } from "@/services/project-env";

type Params = { params: Promise<{ projectId: string }> };

const MASK = "••••••••";

/**
 * "Variabili delle anteprime": what every preview of this project receives
 * over what it inherits from staging or production, and under what a preview
 * sets itself — a test API key, a banner saying "anteprima". The same rules
 * as the project's own variables: the same permissions to read and write,
 * the same checks on references.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "env.read");
  if (isDenied(denied)) return denied;
  const reveal = request.nextUrl.searchParams.get("reveal") === "true" && satisfies(denied.access, PROJECT_ACTIONS["env.reveal"]);
  const { vars, unreadable } = await loadPreviewVars(projectId);
  return NextResponse.json(
    { vars: vars.map((v) => ({ key: v.key, value: reveal ? v.value : MASK })), unreadable },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PUT(request: NextRequest, { params }: Params) {
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
  const parsed = envVarsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: envVarsIssueText(body, parsed.error.issues), details: parsed.error.issues }, { status: 400 });
  }

  const db = await getDb();
  if (!(await db.selectFrom("projects").select("id").where("id", "=", projectId).executeTakeFirst())) {
    return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  }
  const stored = await loadPreviewVars(projectId);
  const issues = await checkReferences({
    principal: denied.principal,
    values: parsed.data.vars,
    before: stored.vars.map((v) => v.value),
    snap: await loadSnapshot(projectId),
  });
  if (issues.length > 0) {
    const { status, body: out } = issuesResponse(issues);
    return NextResponse.json(out, { status });
  }

  const now = nowIso();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("preview_env_vars").where("project_id", "=", projectId).execute();
    if (parsed.data.vars.length > 0) {
      await trx
        .insertInto("preview_env_vars")
        .values(parsed.data.vars.map((v) => ({ id: generateId(), project_id: projectId, key: v.key, value: encrypt(v.value), created_at: now })))
        .execute();
    }
  });
  await audit({
    userId: denied.session.user.id,
    category: "config",
    action: "project.previews.env",
    scope: "project",
    scopeId: projectId,
    detail: parsed.data.vars.map((v) => v.key).join(", ").slice(0, 400) || "nessuna",
    request,
  });
  return NextResponse.json({ success: true, count: parsed.data.vars.length });
}
