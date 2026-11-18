import { getDb, nowIso } from "@/lib/db";
import { zoneFor } from "@/lib/proxy-names";
import type { PanelHostsTable } from "@/lib/db/schema";

/**
 * The panel's own name as the store keeps it: the one row of `panel_hosts`.
 *
 * Apart from `services/proxy/index.ts` and `./panel.ts` so both can read it
 * without importing each other: the apply writes the panel's block from here,
 * and the routes that choose and remove the name write here.
 */

/** The panel's name, or null while it has none. */
export async function loadPanelHost(): Promise<PanelHostsTable | null> {
  const db = await getDb();
  return (await db.selectFrom("panel_hosts").selectAll().orderBy("created_at", "asc").executeTakeFirst()) ?? null;
}

export async function panelHostById(id: string): Promise<PanelHostsTable | null> {
  const db = await getDb();
  return (await db.selectFrom("panel_hosts").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
}

export async function setPanelHost(id: string, values: Partial<PanelHostsTable>): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("panel_hosts")
    .set({ ...values, updated_at: nowIso() })
    .where("id", "=", id)
    .execute();
}

export interface PanelDomain {
  id: string;
  name: string;
  /** On the Cloudflare account: the certificate goes through DNS, the visitor through `CF-Connecting-IP`. */
  cloudflare: boolean;
}

/**
 * The domain of the panel whose zone holds the name, when there is one.
 *
 * Read when needed rather than stored with the name: a name typed whole may
 * belong to a domain added later, and linking that domain to Cloudflare should
 * reach the panel's certificate as it reaches the projects'.
 */
export async function panelDomain(hostname: string): Promise<PanelDomain | null> {
  const db = await getDb();
  const domains = await db.selectFrom("domains").select(["id", "name", "cloudflare"]).execute();
  const zone = zoneFor(
    hostname,
    domains.map((domain) => domain.name)
  );
  const domain = zone ? domains.find((candidate) => candidate.name === zone) : undefined;
  return domain ? { id: domain.id, name: domain.name, cloudflare: domain.cloudflare === 1 } : null;
}
