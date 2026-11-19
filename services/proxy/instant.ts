import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { upstreamPort } from "@/lib/access-columns";
import { INSTANT_SUFFIX, hostnameFor, instantDomainFor, labelFrom } from "@/lib/proxy-names";
import type { ProjectHostsTable } from "@/lib/db/schema";
import { addressProblem, canApply, claimedPorts, newHostRow, proxyProbe, serveNewHosts, serverAddresses, upstreamConflict } from "./index";

/**
 * An instant address: `app.203-0-113-7.sslip.io`, a name for a project with
 * no domain and no DNS record to create, because the service answers every
 * such name with the address written in it.
 *
 * Served over HTTP only, and the page says so before it is created. sslip.io
 * is not on the Public Suffix List, so every certificate for every name under
 * it counts against one Let's Encrypt limit shared by everyone who uses it,
 * which ran out several times in 2026; the panel does not make a promise it
 * cannot keep. For the padlock there is the project's own domain.
 *
 * Otherwise it is a name like any other — a row of `project_hosts` under a
 * domain row named after the server's address, created the first time — so
 * nginx, the network rules, the password and the removal all treat it as one.
 */

export const INSTANT_PROVIDER = INSTANT_SUFFIX;

export interface InstantOffer {
  available: boolean;
  /** Why not, in a sentence, when it is not. */
  reason: string | null;
  /** `203-0-113-7.sslip.io`, or null while the server's public address is unknown. */
  domain: string | null;
  address: string | null;
  /** A free label to start from, made from the project's name. */
  suggestedLabel: string;
  provider: string;
}

/**
 * The address the name would carry: the server's public IPv4, or its IPv6 on
 * a server with no IPv4 at all. Behind NAT it is the one the outside sees,
 * which needs ports 80 and 443 forwarded like any other name.
 */
async function instantAddress(): Promise<{ address: string; domain: string } | null> {
  const server = await serverAddresses();
  for (const address of [...server.v4, ...server.v6]) {
    const domain = instantDomainFor(address);
    if (domain) return { address, domain };
  }
  return null;
}

/** Whether the project can have one now, and what it would be called. */
export async function instantOffer(projectId: string, canManageDomains: boolean): Promise<InstantOffer> {
  const db = await getDb();
  const project = await db.selectFrom("projects").select(["slug", "name", "port"]).where("id", "=", projectId).executeTakeFirst();
  const target = await instantAddress();
  const base = labelFrom(project?.slug || project?.name || "app");
  const offer: InstantOffer = {
    available: false,
    reason: null,
    domain: target?.domain ?? null,
    address: target?.address ?? null,
    suggestedLabel: base,
    provider: INSTANT_PROVIDER,
  };

  if (target) {
    // The first of `base`, `base-2`, … nobody holds yet.
    const taken = new Set(
      (await db.selectFrom("project_hosts").select("hostname").where("hostname", "like", `%.${target.domain}`).execute()).map(
        (row) => row.hostname
      )
    );
    for (let n = 1; n <= 20; n++) {
      const label = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
      if (!taken.has(`${label}.${target.domain}`)) {
        offer.suggestedLabel = label;
        break;
      }
    }
  }

  const found = await proxyProbe();
  if (!canManageDomains) offer.reason = "Un nuovo indirizzo lo aggiunge chi ha il permesso Accesso all'host.";
  else if (!project) offer.reason = "Progetto non trovato.";
  else if (!project.port) offer.reason = "Il progetto non ha una porta: impostala in Impostazioni › Rete.";
  else if (!canApply(found)) offer.reason = found.detail;
  else if (!target) {
    offer.reason = "Non conosco l'indirizzo pubblico di questo server, quindi non so che nome dargli: usa un tuo dominio.";
  }
  offer.available = offer.reason === null;
  return offer;
}

export type InstantOutcome = { ok: true; host: ProjectHostsTable } | { ok: false; status: number; error: string };

/** Give the project its instant address, under a domain row for the server's address made the first time. */
export async function addInstantHost(projectId: string, label: string): Promise<InstantOutcome> {
  const offer = await instantOffer(projectId, true);
  if (!offer.available || !offer.domain) return { ok: false, status: 409, error: offer.reason ?? "Non disponibile." };
  const hostname = hostnameFor(label, offer.domain);
  if (!hostname) return { ok: false, status: 400, error: "L'indirizzo completo supera la lunghezza che il DNS consente." };
  const problem = await addressProblem(hostname);
  if (problem) return { ok: false, status: 409, error: problem };

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["port", "access_mode", "access_allow", "access_port", "live_port"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!project?.port) return { ok: false, status: 409, error: "Il progetto non ha una porta: impostala prima di dargli un indirizzo." };
  // Checked again at every apply; here only so the refusal comes with a reason.
  const conflict = upstreamConflict(await claimedPorts(), projectId, upstreamPort(project, project.port));
  if (conflict) return { ok: false, status: 409, error: conflict };

  let domain = await db.selectFrom("domains").select("id").where("name", "=", offer.domain).executeTakeFirst();
  if (!domain) {
    const now = nowIso();
    try {
      await db.insertInto("domains").values({ id: generateId(), name: offer.domain, cloudflare: 0, created_at: now, updated_at: now }).execute();
    } catch {
      /* another request made it first: read it back below */
    }
    domain = await db.selectFrom("domains").select("id").where("name", "=", offer.domain).executeTakeFirst();
  }
  if (!domain) return { ok: false, status: 500, error: "Non sono riuscito a preparare il dominio dell'indirizzo." };

  const row = newHostRow({ projectId, domainId: domain.id, subdomain: label, hostname, publicAccess: false });
  try {
    await db.insertInto("project_hosts").values(row).execute();
  } catch {
    return { ok: false, status: 409, error: `${hostname} è già assegnato.` };
  }
  // Its block now, over HTTP; no certificate is asked for a name like this.
  await serveNewHosts([row.id]);
  return { ok: true, host: row };
}
