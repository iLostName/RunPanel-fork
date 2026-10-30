import { createReporter } from "../harness.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The MCP catalog names every endpoint, and only endpoints that exist.
 *
 * `services/mcp/catalog.ts` is what an AI assistant reads to find its way
 * around the panel: a route missing from it is a route the assistant does not
 * know it can call, and an entry left behind after a route moved sends it to a
 * 404. This walks `app/api` like `authz-coverage-unit` and compares both ways.
 * The few routes no API client may call are listed by name.
 */
export const meta = { name: "mcp-catalog-unit", needsDocker: false, drivers: [], standalone: true };

const INTERNAL = [
  /^auth\//,
  /^webhooks\//,
  /^nodes\//,
  /^upload$/,
  /^mcp$/,
  /^api-tokens$/,
  /^cluster\/(join|directory|leave|ping|secret)$/,
];

const HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
const ENTRY = /\{ method: "(GET|POST|PUT|PATCH|DELETE)", path: "([^"]+)"/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

export async function run({ repoRoot }) {
  const r = createReporter("mcp-catalog-unit");
  const apiDir = join(repoRoot, "app", "api");

  const handlers = new Set();
  for (const file of walk(apiDir)) {
    const route = relative(apiDir, file).split(sep).join("/").replace(/\/?route\.ts$/, "");
    if (INTERNAL.some((re) => re.test(route))) continue;
    const path = `/api/${route.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, "{$1}")}`;
    for (const m of readFileSync(file, "utf8").matchAll(HANDLER)) handlers.add(`${m[1]} ${path}`);
  }

  const catalog = readFileSync(join(repoRoot, "services", "mcp", "catalog.ts"), "utf8");
  const entries = new Set([...catalog.matchAll(ENTRY)].map((m) => `${m[1]} ${m[2]}`));

  r.check("handlers are found", handlers.size > 100, String(handlers.size));
  const missing = [...handlers].filter((h) => !entries.has(h));
  const stale = [...entries].filter((e) => !handlers.has(e));
  r.check("every handler is in the catalog", missing.length === 0, missing.join(", "));
  r.check("every catalog entry is a handler", stale.length === 0, stale.join(", "));
  return r.result();
}
