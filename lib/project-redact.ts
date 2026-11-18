/**
 * What a project row may show to someone below `manage`.
 *
 * The webhook secret signs pushes the public webhook route accepts: anyone who
 * reads it can start a deploy without being allowed to. Build-time variables
 * routinely carry registry and package tokens. Both are blanked rather than
 * dropped, so the shape the pages read stays the same.
 */
export function redactProject<T extends { webhook_secret: string; builder_config: string }>(row: T, canManage: boolean): T {
  if (canManage) return row;
  let builderConfig = row.builder_config;
  try {
    const parsed = JSON.parse(row.builder_config) as { buildEnv?: Record<string, string> };
    if (parsed && typeof parsed === "object" && parsed.buildEnv && typeof parsed.buildEnv === "object") {
      parsed.buildEnv = Object.fromEntries(Object.keys(parsed.buildEnv).map((key) => [key, "••••••••"]));
      builderConfig = JSON.stringify(parsed);
    }
  } catch {
    builderConfig = "{}";
  }
  return { ...row, webhook_secret: "", builder_config: builderConfig };
}

/** The columns a backup's `summary.json` is built from. */
export interface SummaryRow {
  id: string;
  name: string;
  slug: string;
  app_name: string | null;
  source_type: string;
  source_url: string | null;
  source_branch: string;
  runtime_type: string;
  port: number | null;
  status: string;
  builder_config: string;
  created_at: string;
  updated_at: string;
}

/**
 * What a project looks like in `summary.json`, which sits unencrypted in the
 * archive whatever the key does.
 *
 * Named field by field, so a column added tomorrow stays out until someone
 * decides it belongs. The deploy contract stays out whole: not only `buildEnv`,
 * but any command in it can hold a token typed inline. Of `buildEnv` only the
 * names survive, like `envKeys`. `cleanUrl` is `stripRemoteCredentials`, taken
 * as an argument to keep this module free of imports; the query string goes
 * too, where some hosts carry a token.
 */
export function projectBackupSummary(row: SummaryRow, cleanUrl: (url: string) => string) {
  let buildEnvKeys: string[] = [];
  try {
    const parsed = JSON.parse(row.builder_config) as { buildEnv?: Record<string, string> } | null;
    if (parsed?.buildEnv && typeof parsed.buildEnv === "object") buildEnvKeys = Object.keys(parsed.buildEnv);
  } catch {
    /* a contract that does not parse has no names worth listing */
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    app_name: row.app_name,
    source_type: row.source_type,
    source_url: row.source_url === null ? null : cleanUrl(row.source_url).split(/[?#]/, 1)[0],
    source_branch: row.source_branch,
    runtime_type: row.runtime_type,
    port: row.port,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    buildEnvKeys,
  };
}
