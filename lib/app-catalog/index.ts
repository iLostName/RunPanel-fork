import type { AppLocation, CatalogCategory, CatalogTemplate, EnvEntry } from "./types";
import { CATEGORY_LABEL, CATEGORY_ORDER, composeFile, templateVariables } from "./render";
import { n8n } from "./templates/n8n";
import { wordpress } from "./templates/wordpress";
import { uptimeKuma } from "./templates/uptime-kuma";
import { umami } from "./templates/umami";
import { ghost } from "./templates/ghost";
import { vaultwarden } from "./templates/vaultwarden";
import { gitea } from "./templates/gitea";
import { minio } from "./templates/minio";

export * from "./types";
export * from "./render";

/**
 * The catalogue: one-click apps, each a Compose stack the panel installs as an
 * ordinary project.
 *
 * The same list is bundled for the gallery and loaded by the install route, so
 * what a page offers is what the server it talks to knows how to install. In a
 * cluster a server on an older version may lack a template the page shows; the
 * route answers 404 for it rather than guessing.
 *
 * In the order the gallery shows them: the ones people ask for first.
 */
export const CATALOG: readonly CatalogTemplate[] = [n8n, wordpress, uptimeKuma, umami, ghost, vaultwarden, gitea, minio];

export function getTemplate(id: string): CatalogTemplate | null {
  return CATALOG.find((template) => template.id === id) ?? null;
}

/** The categories that have at least one app, in their usual order. */
export function catalogCategories(templates: readonly CatalogTemplate[] = CATALOG): CatalogCategory[] {
  return CATEGORY_ORDER.filter((category) => templates.some((template) => template.category === category));
}

/**
 * The values a note may show: every variable that is not a secret, and where
 * the app answers. A password typed by the person stays out too.
 */
export function noteValues(entries: readonly Pick<EnvEntry, "key" | "value" | "sensitive">[], location: Pick<AppLocation, "url">): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of entries) if (!entry.sensitive) values[entry.key] = entry.value;
  values.APP_URL = location.url;
  return values;
}

/**
 * A template as JSON can carry it, for `GET /api/catalog`: what an API client
 * needs to fill the install body and to see what it installs. The `derive`
 * function stays behind; its keys are listed.
 */
export function catalogEntry(template: CatalogTemplate) {
  return {
    id: template.id,
    revision: template.revision,
    name: template.name,
    description: template.description,
    about: template.about,
    category: template.category,
    categoryLabel: CATEGORY_LABEL[template.category],
    icon: template.icon,
    website: template.website,
    address: template.address,
    addressNote: template.addressNote ?? null,
    web: template.web,
    volumes: template.volumes,
    databases: template.databases,
    questions: template.questions,
    secrets: template.secrets.map(({ key, label, important }) => ({ key, label, important: important === true })),
    variables: templateVariables(template),
    notes: template.notes,
    compose: composeFile(template),
  };
}
