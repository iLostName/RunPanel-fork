import { getDb } from "@/lib/db";
import { tryDecrypt } from "@/lib/crypto";
import {
  mergeLayers,
  refText,
  resolveEffective,
  type DbRef,
  type EffectiveVar,
  type EnvPair,
  type EnvSource,
  type GroupLayer,
  type InheritedLayer,
  type ProjectRef,
  type RefLookup,
  type RefTarget,
  type Resolution,
} from "@/lib/env-refs";
import { inheritanceChain, readsDatabaseOf } from "@/lib/environments";
import { buildConnectionString, serviceEndpoint, serviceEnvKey, serviceLabel, type ConnectionOrigin } from "@/lib/service-env";
import { attachedGroupIds, loadGroups, loadOwnVars, type LoadedGroup } from "./env-groups";
import { internalPort } from "./service-provisioner";

/**
 * A project's variables as they reach the app: its own, its shared groups, and
 * every reference expanded — the one place the deploy, the restart, the
 * scheduled tasks and the Variables tab get them from.
 *
 * Precedence, highest first:
 *   1. an enabled database link (`services/service-injection.ts`, applied by
 *      the callers after this, as always);
 *   2. the project's own variables;
 *   3. its shared groups, a later one over an earlier one.
 *
 * The links stay on top because that is the contract projects already rely
 * on: "an enabled link wins" replaces a stale `DATABASE_URL` the project still
 * carries, and turning that around would hand those apps the stale value at
 * their next deploy, without a word. A link can be switched off, or given
 * another variable name, from the same tab.
 *
 * A reference that does not resolve is never a value. `loadProjectEnv` throws
 * `EnvResolutionError`, with a sentence that names the variable, before the
 * caller has touched anything.
 */

/** What stops a deploy or a restart: every variable that does not resolve, each with its sentence. */
export class EnvResolutionError extends Error {
  readonly problems: readonly { key: string; message: string }[];

  constructor(problems: readonly { key: string; message: string }[]) {
    // The opening words are what `lib/deploy-explain.ts` recognises.
    super(
      problems.length === 1
        ? `Variabile non risolta — ${problems[0].message}`
        : `${problems.length} variabili non risolte — ${problems[0].message} Le altre sono nel log.`
    );
    this.name = "EnvResolutionError";
    this.problems = problems;
  }
}

interface ServiceRow {
  id: string;
  name: string;
  display_name: string | null;
  type: string;
  port: number;
  credentials: string;
  container_name: string;
  project_id: string | null;
  inject_env: number | null;
  env_key: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  port: number | null;
  folder_id: string | null;
  runtime_type: string;
  environment_of: string | null;
  environment: string | null;
}

/** One project an environment inherits from, with what it would hand down. */
export interface InheritedSource {
  project: { id: string; name: string; slug: string; environment: "production" | "staging" };
  /** Its groups, first to last. */
  groups: LoadedGroup[];
  own: EnvPair[];
  ownUnreadable: string[];
}

/** An inherited variable not handed down, and why. */
export interface WithheldVar {
  key: string;
  source: EnvSource;
  reason: string;
}

const CONTAINER_RUNTIMES = new Set(["docker", "compose"]);

/** The port a project listens on: a native one without a port gets 3000, as the deploy gives it. */
function listeningPort(project: Pick<ProjectRow, "port" | "runtime_type">): number | null {
  return project.port ?? (CONTAINER_RUNTIMES.has(project.runtime_type) ? null : 3000);
}

/** Everything a resolution reads, loaded once. */
export interface EnvSnapshot {
  own: EnvPair[];
  ownUnreadable: string[];
  groups: LoadedGroup[];
  attached: LoadedGroup[];
  services: ServiceRow[];
  projects: ProjectRow[];
  /** The project's enabled links, by the variable each sets. */
  links: ServiceRow[];
  /** Names the panel sets over whatever the variables say: PORT, when the project has one. */
  panelKeys: string[];
  /**
   * What an environment inherits, lowest first (lib/environments.ts): its
   * production, and for a preview its staging after it. Empty for an
   * ordinary project.
   */
  inherited: InheritedSource[];
  /** The slug of the production an environment belongs to: what it inherits never reads that project's databases. */
  productionSlug: string | null;
}

export async function loadSnapshot(projectId: string): Promise<EnvSnapshot> {
  const db = await getDb();
  const [own, groups, attachedIds, services, projects] = await Promise.all([
    loadOwnVars(projectId),
    loadGroups(),
    attachedGroupIds(projectId),
    db
      .selectFrom("services")
      .select(["id", "name", "display_name", "type", "port", "credentials", "container_name", "project_id", "inject_env", "env_key"])
      .execute(),
    db.selectFrom("projects").select(["id", "name", "slug", "port", "folder_id", "runtime_type", "environment_of", "environment"]).execute(),
  ]);
  const byId = new Map(groups.map((g) => [g.id, g]));
  const groupsOf = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter((g): g is LoadedGroup => g !== undefined);
  const self = projects.find((p) => p.id === projectId);
  const chain = self ? inheritanceChain(self, projects) : [];
  const inherited = await Promise.all(
    chain.map(async (project, index): Promise<InheritedSource> => {
      const [vars, ids] = await Promise.all([loadOwnVars(project.id), attachedGroupIds(project.id)]);
      return {
        project: { id: project.id, name: project.name, slug: project.slug, environment: index === 0 ? "production" : "staging" },
        groups: groupsOf(ids),
        own: vars.vars,
        ownUnreadable: vars.unreadable,
      };
    })
  );
  return {
    own: own.vars,
    ownUnreadable: own.unreadable,
    groups,
    attached: groupsOf(attachedIds),
    services: services as ServiceRow[],
    projects,
    links: (services as ServiceRow[]).filter((s) => s.project_id === projectId && s.inject_env === 1),
    panelKeys: self && (listeningPort(self) ?? 0) > 0 ? ["PORT"] : [],
    inherited,
    productionSlug: inherited[0]?.project.slug ?? null,
  };
}

/** Which database a reference names, or why none. Shared with the permission check, which must look at the same one. */
export function findService(snap: Pick<EnvSnapshot, "services" | "projects">, ref: DbRef): { service: ServiceRow } | { problem: string } {
  if (ref.project) {
    const owner = snap.projects.find((p) => p.slug === ref.project);
    if (!owner) return { problem: `non c'è un progetto «${ref.project}» su questo server` };
    const service = snap.services.find((s) => s.project_id === owner.id && s.name === ref.service);
    return service ? { service } : { problem: `il progetto «${ref.project}» non ha un database «${ref.service}»` };
  }
  const standalone = snap.services.filter((s) => s.project_id === null && s.name === ref.service);
  if (standalone.length === 1) return { service: standalone[0] };
  if (standalone.length > 1) {
    return { problem: `ci sono ${standalone.length} database senza progetto chiamati «${ref.service}» e non si può scegliere: collegane uno a un progetto` };
  }
  // The likely slip: the database is linked to a project, which then has to be named.
  const linked = snap.services.find((s) => s.project_id !== null && s.name === ref.service);
  const owner = linked ? snap.projects.find((p) => p.id === linked.project_id) : undefined;
  return {
    problem: owner
      ? `«${ref.service}» è collegato al progetto «${owner.slug}»: si scrive \${{ db.${owner.slug}.${ref.service}.${ref.field} }}`
      : `non c'è un database senza progetto chiamato «${ref.service}» su questo server`,
  };
}

/** Which project a reference names, or why none. */
export function findProject(snap: Pick<EnvSnapshot, "projects">, ref: ProjectRef): { project: ProjectRow } | { problem: string } {
  const project = snap.projects.find((p) => p.slug === ref.slug);
  return project ? { project } : { problem: `non c'è un progetto «${ref.slug}» su questo server` };
}

function credentialsOf(service: ServiceRow): { user?: string; password?: string; database?: string } | null {
  const raw = tryDecrypt(service.credentials);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** How references are answered for an app that runs at `origin`. */
export function lookupFor(snap: EnvSnapshot, origin: ConnectionOrigin): RefLookup {
  const byName = new Map(snap.groups.map((g) => [g.name, g]));
  return {
    shared(groupName, key) {
      const group = byName.get(groupName);
      if (!group) return { problem: `il gruppo «${groupName}» non esiste su questo server` };
      if (group.unreadable.includes(key)) {
        return { problem: `${key} del gruppo «${groupName}» non si può leggere con la chiave di questo pannello` };
      }
      const pair = group.vars.find((v) => v.key === key);
      return pair ? { value: pair.value } : { problem: `il gruppo «${groupName}» non ha la variabile ${key}` };
    },
    resource(ref) {
      if (ref.kind === "project") {
        const found = findProject(snap, ref);
        if ("problem" in found) return found;
        const port = listeningPort(found.project);
        if (!port) return { problem: `il progetto «${ref.slug}» non ha una porta` };
        // The published port, from wherever the app runs: projects have no
        // network in common, so the host is the way across — `localhost` from
        // the host, the host gateway the panel adds to a container.
        const host = origin === "container" ? "host.docker.internal" : "localhost";
        if (ref.field === "port") return { value: String(port) };
        if (ref.field === "host") return { value: host };
        return { value: `http://${host}:${port}` };
      }

      const found = findService(snap, ref);
      if ("problem" in found) return found;
      const service = found.service;
      const creds = credentialsOf(service);
      if (!creds) return { problem: `le credenziali del database «${ref.service}» non si possono leggere con la chiave di questo pannello` };
      const endpoint = serviceEndpoint(
        { type: service.type, port: service.port, internalPort: internalPort(service.type, service.port), containerName: service.container_name },
        origin
      );
      const engine = serviceLabel(service.type);
      switch (ref.field) {
        case "url":
          return { value: buildConnectionString(service.type, { host: endpoint.host, port: endpoint.port, ...creds }) };
        case "host":
          return { value: endpoint.host };
        case "port":
          return { value: String(endpoint.port) };
        case "user":
          return creds.user ? { value: creds.user } : { problem: `il database «${ref.service}» (${engine}) non ha un utente` };
        case "password":
          return creds.password ? { value: creds.password } : { problem: `il database «${ref.service}» (${engine}) non ha una password` };
        case "database":
          // Redis numbers its databases and the URL the panel builds uses 0.
          if (service.type === "redis") return { value: "0" };
          return creds.database ? { value: creds.database } : { problem: `il database «${ref.service}» (${engine}) non ha un nome di database` };
      }
    },
  };
}

/** A value that cannot be decrypted still sets its name: it is marked, so the layer under it does not quietly take its place. */
const withUnreadable = (vars: readonly EnvPair[], unreadable: readonly string[]): EnvPair[] => [
  ...vars,
  ...unreadable.map((key) => ({ key, value: "" })),
];

/** Whether a variable was handed down rather than set by the project itself. */
export function isInherited(source: EnvSource): boolean {
  return source.kind === "inherited" || (source.kind === "group" && source.via !== undefined);
}

/** The layers merged, unreadable values turned into problems rather than left out. */
export function effectiveVars(snap: EnvSnapshot): EffectiveVar[] {
  const layers: GroupLayer[] = snap.attached.map((g) => ({ id: g.id, name: g.name, vars: withUnreadable(g.vars, g.unreadable) }));
  const own = withUnreadable(snap.own, snap.ownUnreadable);
  const inherited: InheritedLayer[] = snap.inherited.flatMap((from) => [
    ...from.groups.map((g) => ({
      source: { kind: "group" as const, id: g.id, name: g.name, via: from.project.name },
      vars: withUnreadable(g.vars, g.unreadable),
    })),
    {
      source: { kind: "inherited" as const, id: from.project.id, name: from.project.name, environment: from.project.environment },
      vars: withUnreadable(from.own, from.ownUnreadable),
    },
  ]);
  return mergeLayers(layers, own, inherited).map((v) => {
    const source = v.source;
    const unreadable =
      source.kind === "own"
        ? snap.ownUnreadable.includes(v.key)
        : source.kind === "inherited"
          ? snap.inherited.find((from) => from.project.id === source.id)?.ownUnreadable.includes(v.key)
          : source.kind === "group" && snap.groups.find((g) => g.id === source.id)?.unreadable.includes(v.key);
    if (!unreadable) return v;
    const where = source.kind === "group" ? ` del gruppo «${source.name}»` : source.kind === "inherited" ? ` di «${source.name}»` : "";
    return { ...v, problem: `La variabile ${v.key}${where} non si può leggere con la chiave di questo pannello: salvala di nuovo.` };
  });
}

/** A resolution, plus what an environment was not handed down. */
export interface ProjectResolution extends Resolution {
  withheld: WithheldVar[];
}

/**
 * Resolve for one viewpoint. Values a database link replaces are not resolved: they never reach the app.
 *
 * An environment's inherited variable that reads one of production's
 * databases is held back, before it can reach the app and whatever it
 * resolves to: a staging copy writing into production's data is the one
 * mistake an environment exists to prevent. Its own variables are not held
 * back — writing that reference there is the explicit choice.
 */
export function resolveFor(snap: EnvSnapshot, origin: ConnectionOrigin): ProjectResolution {
  const vars = effectiveVars(snap);
  const broken = vars.filter((v) => v.problem !== null);
  const skip = new Set([...snap.links.map((s) => serviceEnvKey(s)), ...snap.panelKeys]);
  const resolution = resolveEffective(
    vars.filter((v) => v.problem === null),
    lookupFor(snap, origin),
    { skip }
  );

  const production = snap.productionSlug;
  const held = new Set(
    production
      ? resolution.vars.filter((v) => isInherited(v.source) && !skip.has(v.key) && readsDatabaseOf(v.refs, production)).map((v) => v.key)
      : []
  );
  const withheld: WithheldVar[] = resolution.vars
    .filter((v) => held.has(v.key))
    .map((v) => ({
      key: v.key,
      source: v.source,
      reason: `Non ereditata: legge un database di «${snap.inherited[0]?.project.name ?? production}». Collega un database a questo ambiente, oppure scrivi la variabile qui se vuoi davvero usare quello.`,
    }));
  const env = { ...resolution.env };
  for (const key of held) delete env[key];

  return {
    vars: [...resolution.vars.filter((v) => !held.has(v.key)), ...broken].sort((a, b) => a.key.localeCompare(b.key)),
    env,
    problems: [
      ...broken.filter((v) => !skip.has(v.key)).map((v) => ({ key: v.key, source: v.source, message: v.problem as string })),
      ...resolution.problems.filter((p) => !held.has(p.key)),
    ],
    withheld,
  };
}

export interface ProjectEnv {
  /** Name → value as the app reads it from `origin`: without the database links and the panel's own PORT. */
  forOrigin(origin: ConnectionOrigin): Record<string, string>;
  /**
   * Puts the values for `origin` on the names that depend on it — a database
   * reached by container name or on localhost — where `target` still holds
   * the other viewpoint's value. A name somebody has set since (the panel's
   * PORT) is left alone.
   */
  applyOrigin(target: Record<string, string>, origin: ConnectionOrigin): void;
  /** For the deploy log: where the variables came from, never their values. */
  summary: string[];
}

/**
 * The project's variables, resolved, or `EnvResolutionError`.
 *
 * Both viewpoints are worked out at once for a container runtime. The deploy
 * only learns which one its app has after the source is fetched (a Compose
 * stack entirely on `network_mode: host` reaches things like a native process
 * does), and its commands that run on the host want the other one anyway —
 * and a problem has to stop the deploy here, before anything is touched, not
 * halfway through.
 */
export async function loadProjectEnv(
  project: { id: string; runtime_type: string },
  opts: { onLog?: (line: string) => void } = {}
): Promise<ProjectEnv> {
  const snap = await loadSnapshot(project.id);
  const container = project.runtime_type === "docker" || project.runtime_type === "compose";
  const origins: ConnectionOrigin[] = container ? ["container", "host"] : ["host"];
  const resolved = new Map(origins.map((origin) => [origin, resolveFor(snap, origin)]));

  const problems = new Map<string, { key: string; message: string }>();
  for (const resolution of resolved.values()) {
    for (const problem of resolution.problems) if (!problems.has(problem.message)) problems.set(problem.message, problem);
  }
  if (problems.size > 0) {
    for (const problem of problems.values()) opts.onLog?.(`[errore] ${problem.message}`);
    throw new EnvResolutionError([...problems.values()]);
  }

  const values = (origin: ConnectionOrigin) => ({ ...(resolved.get(origin) ?? resolved.get("host"))!.env });
  const summary: string[] = [`Loaded ${snap.own.length} env var(s)`];
  if (snap.attached.length > 0) {
    summary.push(
      `Variabili condivise: ${snap.attached.map((g) => `${g.name} (${g.vars.length})`).join(", ")}. ` +
        "Dove due gruppi hanno lo stesso nome vince il più in basso; le variabili del progetto vincono sui gruppi."
    );
  }
  for (const from of snap.inherited) {
    const count = from.own.length + from.groups.reduce((n, g) => n + g.vars.length, 0);
    summary.push(`Variabili ereditate da «${from.project.name}»: ${count}. Quelle di questo ambiente vincono.`);
  }
  const withheld = resolved.get(origins[0])?.withheld ?? [];
  if (withheld.length > 0) {
    summary.push(`Non ereditate, perché leggono un database di produzione: ${withheld.map((v) => v.key).join(", ")}`);
  }
  const withRefs = (resolved.get(origins[0])?.vars ?? []).filter((v) => v.refs.length > 0).map((v) => v.key);
  if (withRefs.length > 0) summary.push(`Riferimenti risolti: ${withRefs.join(", ")}`);

  return {
    forOrigin: values,
    applyOrigin(target, origin) {
      const want = resolved.get(origin);
      if (!want) return;
      for (const [other, resolution] of resolved) {
        if (other === origin) continue;
        for (const [key, value] of Object.entries(want.env)) {
          if (resolution.env[key] !== value && target[key] === resolution.env[key]) target[key] = value;
        }
      }
    },
    summary,
  };
}

/** The references a value reads, as the docs spell them, for a message. */
export function refList(refs: readonly RefTarget[]): string {
  return [...new Set(refs.map(refText))].join(", ");
}
