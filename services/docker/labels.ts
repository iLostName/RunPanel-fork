/**
 * Ownership labels.
 *
 * Every container, image, volume and network RunPanel creates is stamped with
 * these. Without them there is no safe way to clean anything up: a prune would
 * either be scoped by name prefix (fragile) or unscoped (and would delete a
 * user's unrelated containers on the same host). Every destructive operation in
 * this module filters on `runpanel.managed=true`.
 */

export const LABEL_MANAGED = "runpanel.managed";
export const LABEL_PROJECT = "runpanel.project";
export const LABEL_KIND = "runpanel.kind";
export const LABEL_DEPLOYMENT = "runpanel.deployment";
export const LABEL_SERVICE = "runpanel.service";
/** Stamped by compose itself, which refuses `--label` on `up`. */
export const LABEL_COMPOSE_PROJECT = "com.docker.compose.project";
const LABEL_COMPOSE_ONE_OFF = "com.docker.compose.oneoff";

export type ResourceKind = "app" | "service" | "network";

export interface OwnershipLabels {
  project?: string;
  kind?: ResourceKind;
  deployment?: string;
  service?: string;
}

/** `--label k=v` arguments for a create/run/build command. */
export function labelArgs(labels: OwnershipLabels): string[] {
  const pairs: [string, string][] = [[LABEL_MANAGED, "true"]];
  if (labels.project) pairs.push([LABEL_PROJECT, labels.project]);
  if (labels.kind) pairs.push([LABEL_KIND, labels.kind]);
  if (labels.deployment) pairs.push([LABEL_DEPLOYMENT, labels.deployment]);
  if (labels.service) pairs.push([LABEL_SERVICE, labels.service]);

  return pairs.flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

/**
 * `--filter` arguments restricting a listing or prune to RunPanel's own
 * resources. Never call a destructive docker command without these.
 */
export function ownedFilters(labels: OwnershipLabels = {}): string[] {
  const filters = [`${LABEL_MANAGED}=true`];
  if (labels.project) filters.push(`${LABEL_PROJECT}=${labels.project}`);
  if (labels.kind) filters.push(`${LABEL_KIND}=${labels.kind}`);
  if (labels.deployment) filters.push(`${LABEL_DEPLOYMENT}=${labels.deployment}`);

  return filters.flatMap((f) => ["--filter", `label=${f}`]);
}

/**
 * Parse the label string `docker ... ls --format "{{.Labels}}"` prints:
 * `key=value,key=value`.
 *
 * Using this instead of `docker inspect` per object matters more than it looks:
 * every docker CLI invocation costs several hundred milliseconds, so an inspect
 * per volume turned one listing into a second of latency.
 *
 * A label value containing a comma would split wrongly — none of RunPanel's own
 * labels can, since they are slugs and fixed strings, and only RunPanel's labels
 * are ever read here.
 */
export function parseLabels(labels: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;

  for (const pair of labels.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** The output of `{{json .Config.Labels}}`, which is `null` for no labels at all. */
export function parseLabelsJson(text: string): Record<string, string> {
  return (JSON.parse(text.trim() || "null") as Record<string, string> | null) ?? {};
}

/** One line of `docker ps -a --format CONTAINER_LIST_FORMAT`. */
export const CONTAINER_LIST_FORMAT = "{{.Names}}|{{.State}}|{{.Labels}}";

export interface ContainerRow {
  names: string[];
  state: string;
  labels: Record<string, string>;
  /** The compose project it belongs to. Empty for anything else. */
  composeProject: string;
  /** A `compose run`, which is not part of the state of the stack. */
  oneOff: boolean;
}

export function parseContainerList(stdout: string): ContainerRow[] {
  const rows: ContainerRow[] = [];

  for (const line of stdout.split("\n")) {
    const [names, state, ...rest] = line.trim().split("|");
    if (!names || !state) continue;

    const labels = parseLabels(rest.join("|"));
    rows.push({
      // One container can carry several names, comma-separated.
      names: names.split(",").map((name) => name.trim()).filter(Boolean),
      state,
      labels,
      composeProject: labels[LABEL_COMPOSE_PROJECT] ?? "",
      oneOff: labels[LABEL_COMPOSE_ONE_OFF] === "True",
    });
  }
  return rows;
}

/**
 * Who a container answering to `runpanel-<slug>` belongs to, when that is not
 * the project `slug`: a description for the operator, or null when it is the
 * own container of the project.
 *
 * The name alone proves nothing. Slugs were never reserved, so an existing
 * project can be called `svc-postgres`, which is the container of the postgres
 * service, or `shop-web-1`, which is what compose names the first `web` of the
 * stack `shop`. Those are not renamed, since other things reach them by name:
 * the labels are what tell them apart.
 *
 * No labels at all is a container from before they existed (8da5d0c), and it can
 * only be the app of the project: a service would sit in a reserved namespace,
 * which is what `reservedName` says, and compose always stamps its containers.
 */
export function foreignOwner(slug: string, labels: Record<string, string>, reservedName: boolean): string | null {
  if (labels[LABEL_KIND] === "app" && labels[LABEL_PROJECT] === slug) return null;

  if (labels[LABEL_COMPOSE_PROJECT]) return `lo stack Compose ${labels[LABEL_COMPOSE_PROJECT]}`;
  if (labels[LABEL_KIND] === "service") return `il servizio ${labels[LABEL_SERVICE] ?? "senza nome"}`;
  if (labels[LABEL_MANAGED]) return `il progetto ${labels[LABEL_PROJECT] ?? "senza nome"}`;

  return reservedName ? "una risorsa riservata del pannello" : null;
}

// --- Naming -----------------------------------------------------------------
// Kept in one place so the GC and the drivers cannot drift apart on what a
// RunPanel-owned name looks like.

export const appContainerName = (slug: string) => `runpanel-${slug}`;
export const imageRepo = (slug: string) => `runpanel/${slug}`;
export const networkName = (slug: string) => `runpanel-net-${slug}`;

export function serviceContainerName(serviceName: string, projectSlug?: string | null): string {
  return projectSlug ? `runpanel-svc-${projectSlug}-${serviceName}` : `runpanel-svc-${serviceName}`;
}
