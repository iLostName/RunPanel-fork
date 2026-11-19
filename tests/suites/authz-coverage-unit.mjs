import { createReporter } from "../harness.mjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Every API handler says what it protects.
 *
 * `proxy.ts` refuses requests without a session, but a session is not a
 * permission: once several people share the panel, a handler that forgets its
 * guard hands every account full control of that route. This walks every
 * `route.ts` and requires each exported handler to call one of the guards from
 * `lib/auth-guard.ts`. The few public endpoints are listed by name, so adding
 * one is a visible edit here.
 */
export const meta = { name: "authz-coverage-unit", needsDocker: false, drivers: [], standalone: true };

const PUBLIC = new Set([
  "auth/check/route.ts",
  "auth/login/route.ts",
  // The code after the password: its credential is the token the password step handed out.
  "auth/login/two-factor/route.ts",
  "auth/logout/route.ts",
  "auth/invite/route.ts",
  // Signing in with GitHub. Leaving needs no session (linking checks its own,
  // with the password); the return's credential is the state and this
  // browser's cookie; finishing it, the cookie the return left.
  "auth/github/start/route.ts",
  "auth/github/callback/route.ts",
  "auth/github/continue/route.ts",
  "webhooks/github/[projectId]/route.ts",
  // A fresh install joining the cluster: its one-time token is the credential.
  "cluster/join/route.ts",
]);

/**
 * Outside the matcher of `proxy.ts`, so nothing checks the origin for them, and
 * written to from a browser with the session cookie.
 */
const OWN_ORIGIN_CHECK = [
  "auth/login/route.ts",
  "auth/login/two-factor/route.ts",
  "auth/two-factor/route.ts",
  "auth/logout/route.ts",
  "auth/invite/route.ts",
  "auth/github/route.ts",
  "auth/github/start/route.ts",
  "auth/github/continue/route.ts",
  "upload/route.ts",
  "nodes/[nodeId]/[...path]/route.ts",
];

const GUARD = /await\s+require(User|Owner|Permission|Project|Service|Folder|Member)\s*\(/;
const HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

export async function run({ repoRoot }) {
  const r = createReporter("authz-coverage-unit");
  const apiDir = join(repoRoot, "app", "api");
  const files = walk(apiDir);
  r.check("routes are found", files.length > 50, String(files.length));

  const unguarded = [];
  const legacy = [];
  for (const file of files) {
    const rel = relative(apiDir, file).split(sep).join("/");
    const source = readFileSync(file, "utf8");
    if (/\brequireAuth\b/.test(source)) legacy.push(rel);
    if (PUBLIC.has(rel)) continue;

    const starts = [...source.matchAll(HANDLER)];
    starts.forEach((m, i) => {
      const body = source.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : source.length);
      if (!GUARD.test(body)) unguarded.push(`${rel} ${m[1]}`);
    });
  }

  r.check("every handler calls a guard", unguarded.length === 0, unguarded.join(", "));

  const unchecked = OWN_ORIGIN_CHECK.filter((rel) => !readFileSync(join(apiDir, rel), "utf8").includes("refuseCrossOrigin(request)"));
  r.check("the browser routes the proxy skips check the origin themselves", unchecked.length === 0, unchecked.join(", "));
  r.check("nothing uses the old requireAuth", legacy.length === 0, legacy.join(", "));
  return r.result();
}
