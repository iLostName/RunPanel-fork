import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { PROJECT_ACTIONS, hasPermission, satisfies } from "@/lib/authz";
import { requireHostFor } from "@/lib/host-guard";
import { getDb, nowIso } from "@/lib/db";
import { githubToken } from "@/lib/github";
import { environmentsBlocker } from "@/lib/environments";
import { previewSettingsSchema } from "@/lib/validation";
import { previewsView, removeAllPreviews } from "@/services/previews";
import { syncAutoDeploy } from "@/services/webhook-manage";

type Params = { params: Promise<{ projectId: string }> };

/**
 * "Anteprime delle pull request" of a production project: the settings, every
 * pull request the panel knows with its preview, what they take from the
 * server, and whether pull request events can reach the panel at all.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;
  const db = await getDb();
  const project = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  const view = await previewsView(project);
  // The domains to name previews under, for the settings only.
  const domains = satisfies(denied.access, PROJECT_ACTIONS.settings)
    ? await db.selectFrom("domains").select(["id", "name"]).orderBy("name", "asc").execute()
    : [];
  return NextResponse.json(
    { ...view, domains: domains.filter((d) => !d.name.endsWith(".sslip.io") && !d.name.endsWith(".nip.io")) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Turn previews on or off, and set their ceiling, idle days, address and
 * commit status.
 *
 * Turned on, the panel makes projects by itself, running the code of other
 * branches: the permissions of creating a staging copy, plus GitHub, whose
 * webhook it rewrites to carry pull request events. It is refused unless
 * those events can arrive — a webhook GitHub accepted, or polling with a
 * token. Turned off, every preview is removed with its containers.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "settings");
  if (isDenied(denied)) return denied;
  for (const [permission, label] of [["projects.create", "Creare progetti"], ["github", "GitHub"]] as const) {
    if (!hasPermission(denied.principal, permission)) {
      return NextResponse.json({ error: `Per le anteprime serve il permesso «${label}»` }, { status: 403 });
    }
  }
  const noHost = requireHostFor(denied.principal, "attivare le anteprime, che eseguono il codice delle pull request");
  if (noHost) return noHost;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = previewSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
  }
  const settings = parsed.data;

  const db = await getDb();
  const project = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst();
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  const blocker = environmentsBlocker(project);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  if (settings.domainId && !(await db.selectFrom("domains").select("id").where("id", "=", settings.domainId).executeTakeFirst())) {
    return NextResponse.json({ error: "Dominio non trovato" }, { status: 404 });
  }
  if (settings.enabled && !(await githubToken())) {
    return NextResponse.json({ error: "Collega GitHub al pannello: le anteprime leggono le pull request con il suo token." }, { status: 409 });
  }

  const before = project.preview_settings;
  await db.updateTable("projects").set({ preview_settings: JSON.stringify(settings), updated_at: nowIso() }).where("id", "=", projectId).execute();
  const saved = await db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirstOrThrow();

  // The webhook follows: pull request events while previews are on.
  const sync = await syncAutoDeploy(saved, request);
  if (settings.enabled && saved.deploy_trigger !== "poll" && (!sync || !sync.ok)) {
    await db.updateTable("projects").set({ preview_settings: before, updated_at: nowIso() }).where("id", "=", projectId).execute();
    await syncAutoDeploy({ ...saved, preview_settings: before }, request);
    return NextResponse.json(
      { error: `Le anteprime restano spente: le pull request non arriverebbero. ${sync?.message ?? "Il webhook non è stato registrato."}`, code: "transport" },
      { status: 409 }
    );
  }

  const removed = settings.enabled ? { removed: 0, failed: [] as string[] } : await removeAllPreviews(projectId);
  await audit({
    userId: denied.session.user.id,
    category: "config",
    action: "project.previews",
    scope: "project",
    scopeId: projectId,
    detail: settings.enabled
      ? `Anteprime attive: al massimo ${settings.maxPreviews}, ferme dopo ${settings.idleDays} giorni`
      : `Anteprime spente${removed.removed > 0 ? `, ${removed.removed} eliminate` : ""}`,
    request,
  });
  return NextResponse.json({ ...(await previewsView(saved)), removed: removed.removed, failed: removed.failed });
}
