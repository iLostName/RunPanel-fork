import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { hostDnsReport, proxyProbe } from "@/services/proxy";

type Params = { params: Promise<{ projectId: string; hostId: string }> };

/**
 * Where the address's DNS records lead, asked of public resolvers now, next
 * to what they should hold — this server's public addresses — and the verdict
 * (`lib/dns-check.ts`). With the address come the twins that redirect to it,
 * since each name needs its own record.
 *
 * Read-only, and only ever about names already given to this project, so it
 * cannot be pointed at an arbitrary host. Polled by the dialog while a record
 * is pending; `fresh=1` also looks again for this server's own address.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId, hostId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const subjects = await db
    .selectFrom("project_hosts")
    .innerJoin("domains", "domains.id", "project_hosts.domain_id")
    .select([
      "project_hosts.id",
      "project_hosts.hostname",
      "project_hosts.subdomain",
      "project_hosts.check_token",
      "project_hosts.apply_error",
      "project_hosts.redirect_to",
      "domains.cloudflare",
      "domains.name as domain",
    ])
    .where("project_hosts.project_id", "=", projectId)
    .where((eb) => eb.or([eb("project_hosts.id", "=", hostId), eb("project_hosts.redirect_to", "=", hostId)]))
    .execute();
  const host = subjects.find((subject) => subject.id === hostId);
  if (!host) return NextResponse.json({ error: "Indirizzo non trovato" }, { status: 404 });

  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  const found = await proxyProbe();
  // The address first, then its twins.
  const ordered = [host, ...subjects.filter((subject) => subject.id !== hostId)];
  const reports = await Promise.all(ordered.map((subject) => hostDnsReport(subject, found, fresh)));

  return NextResponse.json({
    proxy: { state: found.state, detail: found.detail },
    names: reports.map((report, index) => ({
      ...report,
      subdomain: ordered[index].subdomain,
      domain: ordered[index].domain,
      cloudflare: ordered[index].cloudflare === 1,
      redirectTo: ordered[index].redirect_to,
    })),
  });
}
