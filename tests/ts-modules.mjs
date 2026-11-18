/**
 * Loading the panel's TypeScript from a standalone suite.
 *
 * Node strips the types itself; what it cannot do is resolve the way the
 * bundler does — `@/lib/x` and `./x` without an extension. One hook, shared by
 * the suites that need it, maps both to the `.ts` (or `/index.ts`) file and
 * leaves every other specifier alone.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let registered = null;

export function useTsModules(repoRoot) {
  if (registered === repoRoot) return;
  registered = repoRoot;
  const target = (base) => [`${base}.ts`, `${base}/index.ts`].find((url) => existsSync(fileURLToPath(url)));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const found = target(pathToFileURL(join(repoRoot, specifier.slice(2))).href);
        if (found) return nextResolve(found, context);
      }
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      if (extensionless && context.parentURL?.endsWith(".ts")) {
        const found = target(new URL(specifier, context.parentURL).href);
        if (found) return nextResolve(found, context);
      }
      return nextResolve(specifier, context);
    },
  });
}

export function loadTs(repoRoot, ...parts) {
  useTsModules(repoRoot);
  return import(pathToFileURL(join(repoRoot, ...parts)).href);
}
