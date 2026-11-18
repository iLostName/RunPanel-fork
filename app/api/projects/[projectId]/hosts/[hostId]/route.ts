import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { hasPermission } from "@/lib/authz";
import { getDb, nowIso } from "@/lib/db";
import { wwwTwin } from "@/lib/proxy-names";
import { hostActionSchema, updateHostSchema } from "@/lib/validation";
import type { ProjectHostsTable } from "@/lib/db/schema";
import { hashPassword } from "@/services/proxy/password";
import {
  addressProblem,
  applyProxy,
  applyProxySoon,
  forgetCertificate,
  hostView,
  isIssuing,
  issueCertificate,
  newHostRow,
  proxyProbe,
  serveNewHosts,
} from "@/services/proxy";

type Params = { params: Promise<{ projectId: string; hostId: string }> };

/** The name, only if it belongs to this project — another project's id answers like a missing one. */
async function findHost(projectId: string, hostId: string) {
  const db = await getDb();
  return db
    .selectFrom("project_hosts")
    .selectAll()
    .where("id", "=", hostId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();
}

/** The names that only redirect to this one: its `www.` twin, when it has one. */
async function findTwins(hostId: string) {
  const db = await getDb();
  return db.selectFrom("project_hosts").selectAll().where("redirect_to", "=", hostId).execute();
}

async function readBody(request: NextRequest): Promise<unknown | NextResponse> {
  try {
    return await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
}

/**
 * Open the name to everyone while the port stays restricted, or make it follow
 * the port again; put a password in front of it, or take it away; give it the
 * `www.` twin that redirects to it, or take that away.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.update", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, hostId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const body = await readBody(request);
    if (body instanceof NextResponse) return body;
    const parsed = updateHostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const host = await findHost(projectId, hostId);
    if (!host) return NextResponse.json({ error: "Indirizzo non trovato" }, { status: 404 });

    const { publicAccess, auth, www } = parsed.data;
    const db = await getDb();
    if (host.redirect_to) {
      // A twin serves nothing but a redirect: who gets in is decided by the name it sends visitors to.
      const target = await db.selectFrom("project_hosts").select("hostname").where("id", "=", host.redirect_to).executeTakeFirst();
      return NextResponse.json(
        { error: `${host.hostname} rimanda a ${target?.hostname ?? "un altro indirizzo"}: accesso e password si impostano lì.` },
        { status: 400 }
      );
    }

    let twin: ProjectHostsTable | null = (await findTwins(hostId))[0] ?? null;
    let createdTwin = false;
    if (www === true && !twin) {
      // A new name on the domain, like adding one: the same permission.
      if (!hasPermission(denied.principal, "host")) {
        return NextResponse.json({ error: "Per aggiungere un indirizzo serve il permesso Accesso all'host" }, { status: 403 });
      }
      const domain = await db.selectFrom("domains").select("name").where("id", "=", host.domain_id).executeTakeFirst();
      const name = domain ? wwwTwin(host.subdomain, domain.name) : null;
      if (!domain || !name) {
        return NextResponse.json(
          { error: `Il rimando da www vale solo per il dominio intero e per il suo www, non per ${host.hostname}.` },
          { status: 400 }
        );
      }
      const problem = await addressProblem(name.hostname);
      if (problem) return NextResponse.json({ error: problem }, { status: 409 });
      twin = newHostRow({
        projectId,
        domainId: host.domain_id,
        subdomain: name.subdomain,
        hostname: name.hostname,
        // Unused by a redirect, kept in step with its name for whoever reads the row.
        publicAccess: host.public_access === 1,
        redirectTo: host.id,
      });
      await db.insertInto("project_hosts").values(twin).execute();
      createdTwin = true;
    }

    const values: Partial<ProjectHostsTable> = {};
    if (publicAccess !== undefined) values.public_access = publicAccess ? 1 : 0;
    if (auth !== undefined) {
      values.auth_user = auth?.user ?? null;
      values.auth_hash = auth ? hashPassword(auth.password) : null;
    }
    if (Object.keys(values).length > 0) {
      await db.updateTable("project_hosts").set({ ...values, updated_at: nowIso() }).where("id", "=", hostId).execute();
    }

    if (www === false && twin) {
      const gone = twin;
      await db.deleteFrom("project_hosts").where("redirect_to", "=", hostId).execute();
      twin = null;
      // The block goes first; its certificate only once nothing refers to it.
      void applyProxy().then(() => forgetCertificate(gone.hostname));
    } else if (createdTwin && twin) {
      // Like a name just added: its block now — with whatever changed above —
      // and its certificate once its DNS leads here.
      await serveNewHosts([twin.id]);
    } else {
      applyProxySoon();
    }

    return NextResponse.json({ host: hostView({ ...host, ...values }), twin: twin ? hostView(twin) : null });
  });
}

/** Ask for the certificate again, after fixing what the last attempt reported. */
export async function POST(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.retry", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, hostId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const body = await readBody(request);
    if (body instanceof NextResponse) return body;
    if (!hostActionSchema.safeParse(body).success) {
      return NextResponse.json({ error: "Azione non valida" }, { status: 400 });
    }

    const host = await findHost(projectId, hostId);
    if (!host) return NextResponse.json({ error: "Indirizzo non trovato" }, { status: 404 });

    const found = await proxyProbe(true);
    if (found.state !== "ready") return NextResponse.json({ error: found.detail }, { status: 409 });
    if (!isIssuing(hostId)) issueCertificate(hostId);

    return NextResponse.json({ host: hostView({ ...host, status: "issuing" }) }, { status: 202 });
  });
}

/** The name, and the twin that redirects to it: without it, that one would send visitors nowhere. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "config", action: "project.host.remove", scope: "project", scopeId: async () => (await params).projectId }, async () => {
    const { projectId, hostId } = await params;
    const denied = await requireProject(projectId, "settings");
    if (isDenied(denied)) return denied;

    const host = await findHost(projectId, hostId);
    if (!host) return NextResponse.json({ error: "Indirizzo non trovato" }, { status: 404 });

    const db = await getDb();
    const twins = await findTwins(hostId);
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("project_hosts").where("redirect_to", "=", hostId).execute();
      await trx.deleteFrom("project_hosts").where("id", "=", hostId).execute();
    });

    // The blocks go first; their certificates only once nothing refers to them.
    const hostnames = [host.hostname, ...twins.map((twin) => twin.hostname)];
    void applyProxy().then(() => hostnames.forEach(forgetCertificate));

    return NextResponse.json({ success: true, removed: hostnames });
  });
}
