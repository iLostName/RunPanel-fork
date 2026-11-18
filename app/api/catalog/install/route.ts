import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { requireHostFor } from "@/lib/host-guard";
import { withAudit } from "@/lib/audit";
import { catalogInstallSchema } from "@/lib/validation";
import { CatalogInstallError, installCatalogApp } from "@/services/catalog/install";

/**
 * Install an app of the catalogue: a project, its compose file, its variables
 * and its address in one go, then its first deploy. See
 * `services/catalog/install.ts` for the order and what is undone on failure.
 *
 * Guarded like creating a project, plus the host permission: a Compose project
 * is one of the shapes that reach the machine (`needsHost` in lib/authz.ts), and
 * it stays editable after the install like any other. The address needs that
 * permission on its own too, so one check covers both.
 *
 * The answer is the one place the generated passwords leave the server in
 * clear, which is why it is never cached and why nothing about them reaches the
 * activity log: the record names the project, not what it holds.
 */
export async function POST(request: NextRequest) {
  let createdId: string | null = null;

  return withAudit(request, { category: "config", action: "catalog.install", scope: "project", scopeId: async () => createdId }, async () => {
    const denied = await requirePermission("projects.create");
    if (isDenied(denied)) return denied;
    const noHost = requireHostFor(denied.principal, "installare un'app del catalogo");
    if (noHost) return noHost;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = catalogInstallSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json(
        { error: issue?.message || "Dati non validi", field: issue?.path.join(".") || null, details: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const result = await installCatalogApp(parsed.data, {
        userId: denied.session.user.id,
        requestHost: request.headers.get("host"),
      });
      createdId = result.project.id;
      return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (err instanceof CatalogInstallError) {
        return NextResponse.json({ error: err.message, ...err.extra }, { status: err.status });
      }
      // The message only: a stack or a driver error can carry what was being inserted.
      console.error("[catalog] Install failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Installazione non riuscita: non è stato creato nulla." }, { status: 500 });
    }
  });
}
