import { getDb } from "@/lib/db";
import {
  PROJECT_ACTIONS,
  SERVICE_ACTIONS,
  hasPermission,
  projectAccess,
  satisfies,
  serviceAccess,
  type Access,
  type Principal,
} from "@/lib/authz";
import { projectRefs, serviceRefs } from "@/lib/principal";
import { parseContractJson } from "@/lib/deploy-contract";
import { applyInjected, groupConflict, refText, type EffectiveVar, type EnvSource, type RefTarget } from "@/lib/env-refs";
import { connectionOrigin, type ConnectionOrigin } from "@/lib/service-env";
import { serviceDisplayName } from "@/lib/service-name";
import { findProject, findService, loadSnapshot, resolveFor } from "./project-env";
import { injectLinkedServiceEnv } from "./service-injection";

/**
 * What the app will receive, for the Variables tab: every effective variable
 * with where it comes from, what it replaces, and its value with references
 * expanded — masked, and revealable only to whoever may read every part of it.
 *
 * Who may read a value is decided per variable, by its parts. One of the
 * project's own needs the right to see the project's values; one from a group
 * needs the Variabili condivise permission; a database URL needs that
 * database's credentials. A value built from references also needs the right
 * to read each thing it read, nested ones included — otherwise the preview
 * would be the very way around the rule that writing those references obeys.
 */

export interface PreviewVar {
  key: string;
  source: EnvSource;
  overridden: EnvSource[];
  /** Other groups that set this name and lose: shown as a conflict. */
  conflict: string[] | null;
  /** The references it reads, as the docs spell them. */
  refs: string[];
  /** Masked unless revealed and readable; null when it does not resolve. */
  value: string | null;
  revealable: boolean;
  problem: string | null;
}

export interface EnvPreview {
  origin: ConnectionOrigin;
  vars: PreviewVar[];
  problems: number;
  /** For an environment: the projects it inherits from, lowest first (lib/environments.ts). */
  inherits: { id: string; name: string; environment: "production" | "staging" | "previews" }[];
  /** Inherited variables not handed down, with the sentence that says why. */
  withheld: { key: string; source: EnvSource; reason: string }[];
}

const MASK = "••••••••";

export async function previewProjectEnv(
  projectId: string,
  principal: Principal,
  access: Access,
  reveal: boolean
): Promise<EnvPreview> {
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "slug", "runtime_type", "builder_config", "port"])
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();

  // The viewpoint a restart would use: the contract the last good deploy
  // recorded, else the panel's settings.
  const last = await db
    .selectFrom("deployments")
    .select("resolved_contract")
    .where("project_id", "=", projectId)
    .where("status", "in", ["running", "superseded"])
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const contract = parseContractJson(last?.resolved_contract ?? project.builder_config);
  const origin = connectionOrigin(project.runtime_type, contract.docker.network);

  const snap = await loadSnapshot(projectId);
  const resolution = resolveFor(snap, origin);

  // The links on top, through the very function the deploy uses.
  const injected = await injectLinkedServiceEnv(project, contract.docker.network, { ...resolution.env });
  const linkByName = new Map(snap.links.map((s) => [serviceDisplayName(s), s]));
  const layers: { key: string; source: EnvSource; value: string | null }[] = injected.applied.map((item) => {
    const service = linkByName.get(item.service);
    return { key: item.key, source: { kind: "database", id: service?.id ?? "", name: item.service }, value: item.value };
  });
  // The panel's own, as `buildStartOpts` sets them.
  if (snap.panelKeys.includes("PORT")) {
    const port = project.port ?? 3000;
    layers.push({ key: "PORT", source: { kind: "panel" }, value: String(port) });
  }
  let vars: EffectiveVar[] = applyInjected(resolution.vars, layers);
  if (!vars.some((v) => v.key === "NODE_ENV")) {
    vars = applyInjected(vars, [{ key: "NODE_ENV", source: { kind: "panel" }, value: "production" }]);
  }

  const [projects, services] = await Promise.all([projectRefs(), serviceRefs()]);
  const canCredentials = (serviceId: string) => {
    const ref = services.get(serviceId);
    return ref ? satisfies(serviceAccess(principal, ref), SERVICE_ACTIONS.credentials) : false;
  };
  const readsTarget = (ref: RefTarget): boolean => {
    if (ref.kind === "shared") return hasPermission(principal, "variables");
    if (ref.kind === "db") {
      const found = findService(snap, ref);
      return "service" in found && canCredentials(found.service.id);
    }
    const found = findProject(snap, ref);
    const target = "project" in found ? projects.get(found.project.id) : undefined;
    return target ? projectAccess(principal, target).level !== null : false;
  };
  const revealable = (v: EffectiveVar): boolean => {
    if (v.value === null) return false;
    if (v.source.kind === "panel") return true;
    if (v.source.kind === "database") return canCredentials(v.source.id);
    // An inherited variable is production's own, and production's grants are
    // this environment's: the same right reveals it.
    const base =
      v.source.kind === "own" || v.source.kind === "inherited"
        ? satisfies(access, PROJECT_ACTIONS["env.reveal"])
        : hasPermission(principal, "variables");
    return base && v.refs.every(readsTarget);
  };

  return {
    origin,
    vars: vars.map((v) => {
      const open = revealable(v);
      return {
        key: v.key,
        source: v.source,
        overridden: v.overridden,
        conflict: groupConflict(v),
        refs: [...new Set(v.refs.map(refText))],
        value: v.value === null ? null : open && reveal ? v.value : MASK,
        revealable: open,
        problem: v.problem,
      };
    }),
    problems: resolution.problems.length,
    inherits: snap.inherited.map((from) => ({ id: from.project.id, name: from.project.name, environment: from.project.environment })),
    withheld: resolution.withheld,
  };
}
