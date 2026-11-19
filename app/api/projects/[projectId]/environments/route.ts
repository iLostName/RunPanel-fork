import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { PROJECT_ACTIONS, SERVICE_ACTIONS, hasPermission, satisfies, serviceAccess } from "@/lib/authz";
import { requireHostFor } from "@/lib/host-guard";
import { getDb } from "@/lib/db";
import { serviceRefs } from "@/lib/principal";
import { environmentKindOf, stagingBranchProblem } from "@/lib/environments";
import { createEnvironmentSchema } from "@/lib/validation";
import { createStaging, familyOf, stagingOffer } from "@/services/environments";

type Params = { params: Promise<{ projectId: string }> };

/**
 * A project's family: production, its staging and its previews, for the
 * switch at the top of the project page — asked of any member.
 *
 * `?offer=staging` adds what creating a staging copy would do (the branch,
 * the address, production's databases), for the dialog that creates it: it
 * asks GitHub for the branches, so only when the dialog opens.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const project = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  const kind = environmentKindOf(project) ?? "production";
  const wantsOffer = request.nextUrl.searchParams.get("offer") === "staging";
  const offer =
    wantsOffer && kind === "production" && satisfies(denied.access, PROJECT_ACTIONS.settings)
      ? await stagingOffer(project, hasPermission(denied.principal, "host"))
      : null;

  return NextResponse.json({ kind, family: await familyOf(project), offer });
}

/**
 * Create production's staging copy, in one step.
 *
 * The permissions of "Duplica", for the same reason — it is a new project
 * running production's code: managing production, creating projects, and the
 * host permission (another branch is other code). Whoever passes manages the
 * copy through production's grants; nothing is granted on the copy itself.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "settings");
  if (isDenied(denied)) return denied;
  if (!hasPermission(denied.principal, "projects.create")) {
    return NextResponse.json({ error: "Per creare uno staging serve il permesso «Creare progetti»" }, { status: 403 });
  }
  const noHost = requireHostFor(denied.principal, "creare uno staging, che esegue il codice di un altro branch");
  if (noHost) return noHost;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = createEnvironmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }
  const { branch, address = null, databaseIds = [] } = parsed.data;

  const db = await getDb();
  const production = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!production) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  const branchProblem = stagingBranchProblem(branch, production.source_branch);
  if (branchProblem) {
    return NextResponse.json({ error: branchProblem, details: [{ path: ["branch"], message: branchProblem }] }, { status: 400 });
  }

  // Reading production's database from staging is reading its credentials:
  // the same right a reference written by hand needs.
  if (databaseIds.length > 0) {
    const refs = await serviceRefs();
    const refused = databaseIds.filter((id) => {
      const ref = refs.get(id);
      return !ref || !satisfies(serviceAccess(denied.principal, ref), SERVICE_ACTIONS.credentials);
    });
    if (refused.length > 0) {
      return NextResponse.json({ error: "Per usare un database di produzione serve il permesso di vederne le credenziali" }, { status: 403 });
    }
  }

  const outcome = await createStaging({ production, branch, address, databaseIds, request });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });

  await audit({
    userId: denied.session.user.id,
    category: "config",
    action: "project.environment.create",
    scope: "project",
    scopeId: production.id,
    detail: `Staging «${outcome.staging.name}» sul branch ${branch}${databaseIds.length > 0 ? `, con ${databaseIds.length} database di produzione` : ""}`,
    request,
  });
  return NextResponse.json({ ...outcome.staging, warnings: outcome.warnings }, { status: 201 });
}
