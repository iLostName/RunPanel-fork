import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { PROJECT_ACTIONS, hasPermission, satisfies } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { hostnameFor, wwwTwin } from "@/lib/proxy-names";
import { PANEL_PUBLIC_URL_SETTING } from "@/lib/panel-url";
import { listenPort, readAccess } from "@/lib/access-columns";
import { createHostSchema } from "@/lib/validation";
import {
  addressProblem,
  claimedPorts,
  hostView,
  newHostRow,
  proxyProbe,
  serveNewHosts,
  upstreamConflict,
} from "@/services/proxy";

type Params = { params: Promise<{ projectId: string }> };

/** The project's addresses, plus what the section needs to offer a new one. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const [project, hosts, domains, proxy, panelUrl] = await Promise.all([
    db.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst(),
    db.selectFrom("project_hosts").selectAll().where("project_id", "=", projectId).orderBy("hostname", "asc").execute(),
    db.selectFrom("domains").select(["id", "name", "cloudflare"]).orderBy("name", "asc").execute(),
    proxyProbe(),
    getSetting(PANEL_PUBLIC_URL_SETTING),
  ]);
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
  const canManageDomains = hasPermission(denied.principal, "host");

  return NextResponse.json({
    hosts: hosts.map(hostView),
    domains: domains.map((domain) => ({ id: domain.id, name: domain.name, cloudflare: domain.cloudflare === 1 })),
    // What it takes to set nginx up — the commands carry the panel's user and
    // paths — only for who may run that setup, as on the Domains page.
    proxy: canManageDomains
      ? {
          state: proxy.state,
          detail: proxy.detail,
          root: proxy.root,
          reload: proxy.reload,
          commands: proxy.commands,
        }
      : { state: proxy.state, detail: proxy.detail },
    hasPort: project.port !== null,
    restricted: readAccess(project).mode === "restricted",
    // Whether the section offers to change its names at all, or only shows them.
    canEdit: satisfies(denied.access, PROJECT_ACTIONS.settings),
    // Whether to point at the Domains page or only say who can add a domain.
    canManageDomains,
    // So the form can say so while the name is typed, not only once it is sent.
    panelHostname: canManageDomains && panelUrl && URL.canParse(panelUrl) ? new URL(panelUrl).hostname.toLowerCase() : null,
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.add", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;
    // A new address takes a label on a domain other projects share and spends its
    // Let's Encrypt quota, so it is the Domains page's permission, not only the project's.
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
    const parsed = createHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const db = await getDb();
    const project = await db
      .selectFrom("projects")
      .select(["id", "port", "access_mode", "access_allow", "access_port"])
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });
    if (!project.port) {
      return NextResponse.json(
        { error: "Il progetto non ha una porta: impostala prima di dargli un indirizzo." },
        { status: 409 }
      );
    }
    // Checked again at every apply, since the port can change after: this is
    // only so the refusal comes with a reason instead of a name left out.
    const conflict = upstreamConflict(await claimedPorts(), projectId, listenPort(project, project.port));
    if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });

    const { domainId, subdomain, publicAccess, www } = parsed.data;
    const domain = await db.selectFrom("domains").select(["id", "name"]).where("id", "=", domainId).executeTakeFirst();
    if (!domain) return NextResponse.json({ error: "Dominio non trovato" }, { status: 404 });

    const hostname = hostnameFor(subdomain, domain.name);
    if (!hostname) {
      return NextResponse.json({ error: "L'indirizzo completo supera la lunghezza che il DNS consente." }, { status: 400 });
    }
    const twin = www ? wwwTwin(subdomain, domain.name) : null;
    if (www && !twin) {
      return NextResponse.json(
        { error: `Il rimando da www vale solo per ${domain.name} e per www.${domain.name}.` },
        { status: 400 }
      );
    }

    // Both names or neither: half of the pair would leave a twin nobody asked for.
    for (const name of twin ? [hostname, twin.hostname] : [hostname]) {
      const problem = await addressProblem(name);
      if (problem) return NextResponse.json({ error: problem }, { status: 409 });
    }

    const row = newHostRow({ projectId, domainId: domain.id, subdomain, hostname, publicAccess: publicAccess === true });
    const twinRow = twin
      ? newHostRow({
          projectId,
          domainId: domain.id,
          subdomain: twin.subdomain,
          hostname: twin.hostname,
          publicAccess: publicAccess === true,
          redirectTo: row.id,
        })
      : null;
    await db.transaction().execute(async (trx) => {
      await trx.insertInto("project_hosts").values(row).execute();
      if (twinRow) await trx.insertInto("project_hosts").values(twinRow).execute();
    });

    // The certificate is asked for once the DNS record leads here — seconds
    // after, when it already does — and the section follows `status`.
    const found = await serveNewHosts(twinRow ? [row.id, twinRow.id] : [row.id]);

    return NextResponse.json(
      { host: hostView(row), twin: twinRow ? hostView(twinRow) : null, proxy: { state: found.state, detail: found.detail } },
      { status: 201 }
    );
  });
}
