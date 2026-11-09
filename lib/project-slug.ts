/**
 * Slugs a new project cannot take.
 *
 * A project's container is `runpanel-<slug>`, and the panel names its own
 * containers and networks in that same space: `runpanel-svc-…`, `runpanel-net-…`,
 * `runpanel-mountseed-…`. A project called "svc postgres" would therefore answer
 * to the name of the postgres service: its terminal would open a shell in the
 * database, and its first deploy would remove it.
 *
 * Only new projects go through this. Renaming a live container is riskier than
 * the clash, so slugs that already exist keep working and are stopped at the
 * container instead: see `foreignOwner` in `services/docker/labels.ts`.
 */
const RESERVED_NAMESPACES = ["svc", "net", "mountseed"];

export function isReservedSlug(slug: string): boolean {
  return RESERVED_NAMESPACES.some((namespace) => slug === namespace || slug.startsWith(`${namespace}-`));
}
