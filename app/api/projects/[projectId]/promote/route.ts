import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { promoteSchema } from "@/lib/validation";
import { promote, promotionPreview } from "@/services/promote";

type Params = { params: Promise<{ projectId: string }> };

/**
 * "Promuovi in produzione", asked of the staging project.
 *
 * GET is what the confirmation shows: the commit staging runs, who wrote it
 * and when, the variables production and staging do not share (names only),
 * and how production will take it. POST deploys that commit on production.
 *
 * Deploying is the permission on both ends, and both ends have the same
 * grants — an environment follows its production's (lib/principal.ts) — so
 * checking the staging project is checking production.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "deploy");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const staging = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!staging) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  return NextResponse.json(await promotionPreview(staging), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "deploy");
  if (isDenied(denied)) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = promoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }

  const db = await getDb();
  const staging = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!staging) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  const outcome = await promote(staging, parsed.data.commitSha);
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });

  // Recorded on production, where the change happens, naming where it came from.
  await audit({
    userId: denied.session.user.id,
    category: "deploy",
    action: "project.promote",
    scope: "project",
    scopeId: outcome.production.id,
    detail: `Commit ${outcome.commitSha.slice(0, 7)} da «${staging.name}»`,
    request,
  });

  return NextResponse.json(
    {
      productionId: outcome.production.id,
      commitSha: outcome.commitSha,
      status: outcome.deploy.status === "queued" ? "queued" : "pending",
      deploymentId: outcome.deploy.deploymentId ?? null,
    },
    { status: 202 }
  );
}
