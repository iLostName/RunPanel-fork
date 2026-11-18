import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { adoptPanelHttps } from "@/services/proxy/panel";

/**
 * Make the HTTPS name the panel's public address (Impostazioni › Pannello ›
 * Indirizzo pubblico): the webhooks registered from now on, the links in
 * notifications, the address a server joining the cluster is given.
 *
 * Only after checking again, now, that the name answers as this panel with a
 * valid certificate — the owner's browser checked its half before offering it.
 * The panel's port keeps working, and so do the webhooks already on GitHub,
 * until each project's webhook is aligned again.
 */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "system", action: "panel.https.public-url", scope: null, scopeId: null }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;
    const outcome = await adoptPanelHttps();
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json(outcome.value);
  });
}
