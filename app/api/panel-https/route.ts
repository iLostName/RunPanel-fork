import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { hostnameFor } from "@/lib/proxy-names";
import { panelHostnameSchema } from "@/lib/validation";
import { choosePanelHostname, panelHttpsState, turnOffPanelHttps } from "@/services/proxy/panel";

/**
 * The panel's own name over HTTPS, from Impostazioni › Pannello.
 *
 * Owner only, all of it: the name decides how everyone reaches the panel, and
 * the answer carries the nginx setup commands, with the panel's user and paths.
 *
 *   GET     where it stands: nginx, the name and its certificate, the public
 *           address, the panel's own port on each public IP
 *   PUT     choose the name; its certificate follows once its DNS record leads here
 *   DELETE  turn it off; the public address goes back to what it was
 */
export async function GET(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  return NextResponse.json(await panelHttpsState(fresh), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  return withAudit(request, { category: "system", action: "panel.https.enable", scope: null, scopeId: null }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    // A malformed body is a bad request, not a 500.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = panelHostnameSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    let hostname = parsed.data.hostname ?? null;
    if (parsed.data.domainId !== undefined && parsed.data.subdomain !== undefined) {
      const db = await getDb();
      const domain = await db.selectFrom("domains").select("name").where("id", "=", parsed.data.domainId).executeTakeFirst();
      if (!domain) return NextResponse.json({ error: "Dominio non trovato" }, { status: 404 });
      hostname = hostnameFor(parsed.data.subdomain, domain.name);
      if (!hostname) {
        return NextResponse.json({ error: "L'indirizzo completo supera la lunghezza che il DNS consente." }, { status: 400 });
      }
    }
    if (!hostname) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });

    const outcome = await choosePanelHostname(hostname);
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json(await panelHttpsState(), { status: 201 });
  });
}

export async function DELETE(request: NextRequest) {
  return withAudit(request, { category: "system", action: "panel.https.disable", scope: null, scopeId: null }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;
    const outcome = await turnOffPanelHttps();
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ success: true, ...outcome.value });
  });
}
