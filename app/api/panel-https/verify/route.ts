import { NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { verifyPanelHttps } from "@/services/proxy/panel";
import { loadPanelHost } from "@/services/proxy/panel-store";

/**
 * The HTTPS name as a browser would see it, asked of nginx on this machine:
 * a certificate valid for the name, the panel's block answering, the panel
 * behind it. Read-only — it changes nothing, so it is not in the log.
 *
 * The other half, whether the internet reaches nginx on 443, the section asks
 * from the owner's browser.
 */
export async function GET() {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  const row = await loadPanelHost();
  if (!row) return NextResponse.json({ error: "Il pannello non ha un indirizzo HTTPS." }, { status: 404 });
  if (row.status !== "active") {
    return NextResponse.json({ error: "L'indirizzo non ha ancora il certificato." }, { status: 409 });
  }
  return NextResponse.json(await verifyPanelHttps(row), { headers: { "Cache-Control": "no-store" } });
}
