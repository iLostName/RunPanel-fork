import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { hasPermission } from "@/lib/authz";
import { instantHostSchema } from "@/lib/validation";
import { hostView } from "@/services/proxy";
import { addInstantHost, instantOffer } from "@/services/proxy/instant";

type Params = { params: Promise<{ projectId: string }> };

/**
 * An instant address for the project — `app.203-0-113-7.sslip.io`, no domain
 * and no DNS record needed — served over HTTP only: see `services/proxy/instant.ts`.
 *
 * The same permissions as any new address: the project's settings, and the
 * host permission, since it writes into the nginx that serves the machine.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "settings");
  if (isDenied(denied)) return denied;
  return NextResponse.json(await instantOffer(projectId, hasPermission(denied.principal, "host")));
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.instant", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    if (!hasPermission(denied.principal, "host")) {
      return NextResponse.json({ error: "Per aggiungere un indirizzo serve il permesso Accesso all'host" }, { status: 403 });
    }

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = instantHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const outcome = await addInstantHost(projectId, parsed.data.label);
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ host: hostView(outcome.host) }, { status: 201 });
  });
}
