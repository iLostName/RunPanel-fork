import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { panelDnsReport } from "@/services/proxy/panel";

/**
 * Where the panel's HTTPS name leads, asked of public resolvers now, next to
 * what its record should hold — the same check, and the same answer, as a
 * project's address (`lib/dns-check.ts`). Polled by the settings section while
 * the record is not right; `fresh=1` also looks again for this server's own
 * public address.
 *
 * Only ever about the panel's own name, so it cannot be pointed at an arbitrary host.
 */
export async function GET(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  const report = await panelDnsReport(request.nextUrl.searchParams.get("fresh") === "1");
  if (!report) return NextResponse.json({ error: "Il pannello non ha un indirizzo HTTPS." }, { status: 404 });
  return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
}
