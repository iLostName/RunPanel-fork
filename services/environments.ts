import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { generateId } from "@/lib/utils";
import { githubFetch, githubToken, parseRepoSlug } from "@/lib/github";
import { upstreamPort } from "@/lib/access-columns";
import { hostnameFor, isInstantHostname, normalizeSubdomain } from "@/lib/proxy-names";
import { serviceEnvKey } from "@/lib/service-env";
import {
  defaultStagingBranch,
  environmentKindOf,
  environmentSlug,
  environmentsBlocker,
  productionIdOf,
  stagingLabel,
  stagingName,
  type EnvironmentKind,
} from "@/lib/environments";
import { insertProjectCopy } from "./project-copy";
import { deleteProject } from "./project-delete";
import { addressProblem, claimedPorts, newHostRow, serveNewHosts, upstreamConflict } from "./proxy";
import { addInstantHost, instantOffer } from "./proxy/instant";
import { syncAutoDeploy } from "./webhook-manage";

/**
 * A production project and its environments, as stored: the family the
 * project page shows as a switch, the staging copy created from production in
 * one step, and the rule that production never goes without them.
 *
 * The rules themselves are in `lib/environments.ts`; the variables an
 * environment inherits are resolved in `services/project-env.ts`; who may see
 * one is decided by its production's grants (`lib/principal.ts`).
 */

/** One member of a family, as the switch and the lists show it. */
export interface EnvironmentBrief {
  id: string;
  name: string;
  slug: string;
  status: string;
  environment: EnvironmentKind | null;
  branch: string;
  pinnedSha: string | null;
  /** Where it answers: its first address that nginx serves. */
  url: string | null;
  /** The commit of its live deployment — what it runs — when one worked. */
  liveCommit: string | null;
  createdAt: string;
  /** For a preview: its pull request (migration 054). */
  pr: { number: number; title: string; author: string; url: string; fork: boolean } | null;
}

export interface Family {
  production: EnvironmentBrief;
  staging: EnvironmentBrief | null;
  /** The previews of pull requests, newest first (migration 054). */
  previews: EnvironmentBrief[];
}

/** The live deployment's commit of each project: the `running` row is the version that answers. */
async function liveCommits(projectIds: readonly string[]): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const db = await getDb();
  const rows = await db
    .selectFrom("deployments")
    .select(["project_id", "commit_sha", "finished_at"])
    .where("project_id", "in", [...projectIds])
    .where("status", "=", "running")
    .where("commit_sha", "is not", null)
    .orderBy("finished_at", "desc")
    .execute();
  const out = new Map<string, string>();
  for (const row of rows) if (row.commit_sha && !out.has(row.project_id)) out.set(row.project_id, row.commit_sha);
  return out;
}

/** The commit staging runs, as `promote` deploys it. */
export async function liveCommitOf(projectId: string): Promise<string | null> {
  return (await liveCommits([projectId])).get(projectId) ?? null;
}

async function briefs(rows: readonly ProjectsTable[]): Promise<EnvironmentBrief[]> {
  if (rows.length === 0) return [];
  const db = await getDb();
  const ids = rows.map((row) => row.id);
  const [hosts, commits, pulls] = await Promise.all([
    db
      .selectFrom("project_hosts")
      .select(["project_id", "hostname", "status"])
      .where("project_id", "in", ids)
      .where("apply_error", "is", null)
      .where("redirect_to", "is", null)
      .orderBy("hostname", "asc")
      .execute(),
    liveCommits(ids),
    db.selectFrom("project_previews").select(["project_id", "pr_number", "title", "author", "url", "fork"]).where("project_id", "in", ids).execute(),
  ]);
  return rows.map((row) => {
    const host = hosts.find((h) => h.project_id === row.id);
    const pull = pulls.find((p) => p.project_id === row.id);
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      environment: environmentKindOf(row),
      branch: row.source_branch,
      pinnedSha: row.pinned_sha,
      url: host ? `${host.status === "active" ? "https" : "http"}://${host.hostname}` : null,
      liveCommit: commits.get(row.id) ?? null,
      createdAt: row.created_at,
      pr: pull ? { number: pull.pr_number, title: pull.title, author: pull.author, url: pull.url, fork: pull.fork === 1 } : null,
    };
  });
}

/** The environments of a production project, oldest first. */
export async function environmentsOf(productionId: string): Promise<ProjectsTable[]> {
  const db = await getDb();
  return db.selectFrom("projects").selectAll().where("environment_of", "=", productionId).orderBy("created_at", "asc").execute();
}

/** The production row of a family, given any member — null when that production is gone. */
export async function productionOf(project: ProjectsTable): Promise<ProjectsTable | null> {
  if (!project.environment_of) return project;
  const db = await getDb();
  const parent = await db.selectFrom("projects").selectAll().where("id", "=", productionIdOf(project)).executeTakeFirst();
  return parent && !parent.environment_of ? parent : null;
}

/** The family of any member: production, its staging and its previews. Null for a project that has none. */
export async function familyOf(project: ProjectsTable): Promise<Family | null> {
  const production = await productionOf(project);
  if (!production) return null;
  const members = await environmentsOf(production.id);
  if (members.length === 0) return null;
  const [prod, ...rest] = await briefs([production, ...members]);
  return {
    production: prod,
    staging: rest.find((m) => m.environment === "staging") ?? null,
    previews: rest.filter((m) => m.environment === "preview").reverse(),
  };
}

// --- what creating a staging copy would do ------------------------------------------

export type AddressRequest =
  | { kind: "domain"; domainId: string; subdomain: string }
  | { kind: "instant"; label: string };

export interface StagingOffer {
  /** Why production cannot have a staging copy now, or null. */
  blocker: string | null;
  branch: string;
  /** The repository's branches, when GitHub could be asked. */
  branches: string[] | null;
  /** The address proposed next to production's, or null when there is none to propose. */
  address: (AddressRequest & { hostname: string }) | null;
  /** Why no address is proposed, when it is not. */
  addressNote: string | null;
  /** Production's databases a staging copy could use instead of its own — off unless asked for. */
  databases: { id: string; name: string; envKey: string }[];
}

async function repositoryBranches(sourceUrl: string | null): Promise<string[] | null> {
  const slug = parseRepoSlug(sourceUrl);
  const token = await githubToken();
  if (!slug || !token) return null;
  try {
    const res = await githubFetch(`/repos/${slug.full}/branches?per_page=100`, token);
    if (!res.ok) return null;
    return ((await res.json()) as { name: string }[]).map((b) => b.name);
  } catch {
    return null;
  }
}

export async function stagingOffer(production: ProjectsTable, canManageDomains: boolean): Promise<StagingOffer> {
  const db = await getDb();
  const existing = (await environmentsOf(production.id)).find((row) => environmentKindOf(row) === "staging");
  const blocker = environmentsBlocker(production) ?? (existing ? `Lo staging esiste già: «${existing.name}».` : null);
  const branches = blocker ? null : await repositoryBranches(production.source_url);

  let address: StagingOffer["address"] = null;
  let addressNote: string | null = null;
  if (!blocker) {
    const named = await db
      .selectFrom("project_hosts")
      .innerJoin("domains", "domains.id", "project_hosts.domain_id")
      .select(["project_hosts.subdomain", "project_hosts.hostname", "domains.id as domain_id", "domains.name as domain_name"])
      .where("project_hosts.project_id", "=", production.id)
      .where("project_hosts.redirect_to", "is", null)
      .orderBy("project_hosts.created_at", "asc")
      .execute();
    const own = named.find((host) => !isInstantHostname(host.hostname));
    if (!canManageDomains) {
      addressNote = "Un indirizzo lo aggiunge chi ha il permesso Accesso all'host: lo staging nasce senza.";
    } else if (!production.port) {
      addressNote = "Produzione non ha una porta: lo staging nasce senza indirizzo.";
    } else if (own) {
      const subdomain = stagingLabel(own.subdomain);
      const hostname = hostnameFor(subdomain, own.domain_name);
      if (hostname) address = { kind: "domain", domainId: own.domain_id, subdomain, hostname };
    } else {
      const offer = await instantOffer(production.id, true);
      if (offer.available && offer.domain) {
        const label = stagingLabel(offer.suggestedLabel).slice(0, 63);
        address = { kind: "instant", label, hostname: `${label}.${offer.domain}` };
      } else {
        addressNote = offer.reason ?? "Nessun indirizzo da proporre: aggiungilo dopo, dalle impostazioni dello staging.";
      }
    }
  }

  const databases = (
    await db
      .selectFrom("services")
      .select(["id", "name", "display_name", "type", "env_key", "inject_env"])
      .where("project_id", "=", production.id)
      .execute()
  )
    .filter((s) => s.inject_env === 1)
    .map((s) => ({ id: s.id, name: s.display_name || s.name, envKey: serviceEnvKey(s) }));

  return { blocker, branch: defaultStagingBranch(production.source_branch, branches), branches, address, addressNote, databases };
}

// --- creating it ----------------------------------------------------------------------

/** Give a project an address, the way the Indirizzi section does. */
export async function giveAddress(
  project: Pick<ProjectsTable, "id" | "port" | "access_mode" | "access_allow" | "access_port" | "live_port">,
  request: AddressRequest
): Promise<{ ok: true; hostname: string } | { ok: false; error: string }> {
  if (request.kind === "instant") {
    const outcome = await addInstantHost(project.id, request.label);
    return outcome.ok ? { ok: true, hostname: outcome.host.hostname } : { ok: false, error: outcome.error };
  }
  if (!project.port) return { ok: false, error: "Il progetto non ha una porta: impostala prima di dargli un indirizzo." };
  const db = await getDb();
  const domain = await db.selectFrom("domains").select(["id", "name"]).where("id", "=", request.domainId).executeTakeFirst();
  if (!domain) return { ok: false, error: "Dominio non trovato." };
  const subdomain = normalizeSubdomain(request.subdomain);
  const hostname = subdomain === null ? null : hostnameFor(subdomain, domain.name);
  if (subdomain === null || !hostname) return { ok: false, error: "Indirizzo non valido: una sola parola di lettere, numeri e trattini." };
  const problem = await addressProblem(hostname);
  if (problem) return { ok: false, error: problem };
  const conflict = upstreamConflict(await claimedPorts(), project.id, upstreamPort(project, project.port));
  if (conflict) return { ok: false, error: conflict };
  const row = newHostRow({ projectId: project.id, domainId: domain.id, subdomain, hostname, publicAccess: false });
  try {
    await db.insertInto("project_hosts").values(row).execute();
  } catch {
    return { ok: false, error: `${hostname} è già assegnato.` };
  }
  await serveNewHosts([row.id]);
  return { ok: true, hostname };
}

export interface CreateStagingInput {
  production: ProjectsTable;
  branch: string;
  address: AddressRequest | null;
  /** Production's linked databases, by id, to read through references — the explicit choice. */
  databaseIds: string[];
  request?: Request;
}

export type CreateStagingOutcome =
  | { ok: true; staging: ProjectsTable; warnings: string[] }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Production's staging copy, in one step: the same source, settings and
 * resources, another branch, its own port and address, production's
 * variables inherited rather than copied — and none of its databases unless
 * `databaseIds` names them, which writes a reference to each into staging's
 * own variables, where it shows and can be taken out.
 */
export async function createStaging(input: CreateStagingInput): Promise<CreateStagingOutcome> {
  const { production } = input;
  const db = await getDb();
  const blocker = environmentsBlocker(production);
  if (blocker) return { ok: false, status: 409, error: blocker, code: "not_eligible" };
  const existing = (await environmentsOf(production.id)).find((row) => environmentKindOf(row) === "staging");
  if (existing) return { ok: false, status: 409, error: `Lo staging esiste già: «${existing.name}».`, code: "staging_exists" };

  const linked = input.databaseIds.length
    ? await db
        .selectFrom("services")
        .select(["id", "name", "type", "env_key"])
        .where("project_id", "=", production.id)
        .where("id", "in", input.databaseIds)
        .execute()
    : [];
  if (linked.length !== new Set(input.databaseIds).size) {
    return { ok: false, status: 404, error: "Uno dei database scelti non è collegato a produzione." };
  }

  const taken = new Set((await db.selectFrom("projects").select("slug").execute()).map((row) => row.slug));
  const staging = await insertProjectCopy({
    source: production,
    name: stagingName(production.name),
    slug: environmentSlug(production.slug, "staging", taken),
    sourceBranch: input.branch,
    environment: { of: production.id, kind: "staging" },
    settings: true,
    autoDeploy: production.auto_deploy === 1,
    deployTrigger: production.deploy_trigger,
  });

  const warnings: string[] = [];
  if (linked.length > 0) {
    const now = nowIso();
    await db
      .insertInto("env_vars")
      .values(
        linked.map((service) => ({
          id: generateId(),
          project_id: staging.id,
          key: serviceEnvKey(service),
          value: encrypt(`\${{ db.${production.slug}.${service.name}.url }}`),
          created_at: now,
        }))
      )
      .execute();
  }

  if (input.address) {
    const given = await giveAddress(staging, input.address);
    if (!given.ok) warnings.push(`Lo staging è stato creato senza indirizzo: ${given.error}`);
  }

  // Auto-deploy as production has it, onto staging's own webhook or poll.
  if (staging.auto_deploy === 1) {
    const sync = await syncAutoDeploy(staging, input.request);
    if (sync && !sync.ok) warnings.push(sync.message);
  }

  const created = await db.selectFrom("projects").selectAll().where("id", "=", staging.id).executeTakeFirstOrThrow();
  return { ok: true, staging: created, warnings };
}

// --- deleting -------------------------------------------------------------------------

export type DeleteEnvironmentsOutcome =
  | { ok: true; deleted: { id: string; name: string }[]; volumesRemoved: string[]; servicesKept: number }
  | { ok: false; status: 409; error: string; deleted: { id: string; name: string }[] };

/**
 * Every environment of a production project, each deleted like a project of
 * its own (services/project-delete.ts), so none of it reaches production. One
 * that cannot go now — a deploy holding its lock — stops the rest, and
 * production with them: production never goes ahead of its environments.
 */
export async function deleteEnvironments(productionId: string, opts: { deleteServices: boolean }): Promise<DeleteEnvironmentsOutcome> {
  const deleted: { id: string; name: string }[] = [];
  const volumesRemoved: string[] = [];
  let servicesKept = 0;
  // Previews before staging: a preview inherits from staging.
  const members = (await environmentsOf(productionId)).sort(
    (a, b) => Number(environmentKindOf(a) === "staging") - Number(environmentKindOf(b) === "staging")
  );
  for (const member of members) {
    const outcome = await deleteProject(member, opts);
    if (!outcome.ok) return { ok: false, status: 409, error: `«${member.name}»: ${outcome.error}`, deleted };
    deleted.push({ id: member.id, name: member.name });
    volumesRemoved.push(...outcome.volumesRemoved);
    servicesKept += outcome.servicesKept;
  }
  return { ok: true, deleted, volumesRemoved, servicesKept };
}
