import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { requireHostIfReaching } from "@/lib/host-guard";
import { getDb } from "@/lib/db";
import { previewActionSchema } from "@/lib/validation";
import { approvePreview, deployPreview, previewOf, removePreview, stopPreview } from "@/services/previews";

type Params = { params: Promise<{ projectId: string; previewId: string }> };

/**
 * One preview of a production project: approve a fork's commit, redeploy,
 * stop. Asked of production, whose grants a preview follows anyway.
 *
 * Approving is managing production: it lets a stranger's code run on this
 * server with the previews' variables, so it takes `settings`, and the host
 * permission where production reaches the host. Redeploying and stopping are
 * what `deploy` and `control` allow on any project.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { projectId, previewId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = previewActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Azione non valida", details: parsed.error.issues }, { status: 400 });
  }
  const action = parsed.data;
  const denied = await requireProject(projectId, action.action === "approve" ? "settings" : action.action === "stop" ? "control" : "deploy");
  if (isDenied(denied)) return denied;
  if (action.action === "approve") {
    const noHost = await requireHostIfReaching(denied.principal, projectId, "approvare il codice di un fork su un progetto che gira sull'host");
    if (noHost) return noHost;
  }

  const db = await getDb();
  const production = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  const record = production ? await previewOf(production.id, previewId) : undefined;
  if (!production || !record) return NextResponse.json({ error: "Anteprima non trovata" }, { status: 404 });

  if (action.action === "stop") {
    if (!(await stopPreview(record, "manual"))) return NextResponse.json({ error: "L'anteprima è occupata: riprova tra poco." }, { status: 409 });
  } else {
    const outcome =
      action.action === "approve"
        ? await approvePreview(production, record, action.commitSha)
        : await deployPreview(production, record, record.head_sha, "manual");
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  const who = { userId: denied.session.user.id, scope: "project" as const, scopeId: production.id, request };
  if (action.action === "approve") {
    await audit({ ...who, category: "config", action: "project.preview.approve", detail: `PR #${record.pr_number}, commit ${action.commitSha.slice(0, 7)} di ${record.head_repo ?? "un fork"}` });
  } else if (action.action === "stop") {
    await audit({ ...who, category: "deploy", action: "project.preview.stop", detail: `PR #${record.pr_number}` });
  } else {
    await audit({ ...who, category: "deploy", action: "project.preview.redeploy", detail: `PR #${record.pr_number}` });
  }
  return NextResponse.json({ success: true });
}

/** Remove a preview now, with its containers, folders and addresses. The next push to its pull request makes it again. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const { projectId, previewId } = await params;
  const denied = await requireProject(projectId, "delete");
  if (isDenied(denied)) return denied;
  const record = await previewOf(projectId, previewId);
  if (!record) return NextResponse.json({ error: "Anteprima non trovata" }, { status: 404 });
  const outcome = await removePreview(record);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: 409 });
  await audit({
    userId: denied.session.user.id,
    category: "delete",
    action: "project.preview.delete",
    scope: "project",
    scopeId: projectId,
    detail: `PR #${record.pr_number}`,
    request,
  });
  return NextResponse.json({ success: true });
}
