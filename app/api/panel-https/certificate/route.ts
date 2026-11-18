import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { isIssuing, issuePanelCertificate, panelHostView, proxyProbe } from "@/services/proxy";
import { loadPanelHost } from "@/services/proxy/panel-store";

/**
 * Ask for the panel's certificate now, without waiting for the next look at
 * its DNS: after fixing what the last attempt reported, or once the section
 * sees the record turn right. Answers at once; the section follows `status`.
 */
export async function POST(request: NextRequest) {
  return withAudit(request, { category: "system", action: "panel.https.certificate", scope: null, scopeId: null }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const row = await loadPanelHost();
    if (!row) return NextResponse.json({ error: "Il pannello non ha un indirizzo HTTPS." }, { status: 404 });
    const found = await proxyProbe(true);
    if (found.state !== "ready") return NextResponse.json({ error: found.detail }, { status: 409 });
    if (!isIssuing(row.id)) issuePanelCertificate();

    return NextResponse.json({ panelHost: panelHostView({ ...row, status: "issuing" }) }, { status: 202 });
  });
}
