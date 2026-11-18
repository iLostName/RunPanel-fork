import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The Overview's words: the first-run checklist, the names on the cards and
 * the activity feed's sentences.
 *
 * Standalone: lib/onboarding.ts, lib/labels.ts and lib/audit-labels.ts have no
 * imports.
 */
export const meta = { name: "overview-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("overview-unit");
  const load = (file) => import(pathToFileURL(join(repoRoot, "lib", file)).href);
  const { onboardingItems, policyCoversVolumes } = await load("onboarding.ts");
  const { runtimeLabel, engineLabel, engineWithVersion, deployCountLabel } = await load("labels.ts");
  const { actionLabel } = await load("audit-labels.ts");

  // --- the checklist -------------------------------------------------------------
  const all = onboardingItems({ github: true, project: false, domain: false, backup: false, autostart: true, notifications: false });
  r.check("every step that applies is listed", all.length === 6, all.map((i) => i.id).join(","));
  r.check("in the order each makes the next possible", all.map((i) => i.id).join(",") === "github,project,domain,backup,autostart,notifications");
  r.check("done is carried over", all.find((i) => i.id === "github").done === true && all.find((i) => i.id === "project").done === false);
  r.check("every step says what to press and where", all.every((i) => i.cta && i.href.startsWith("/") && i.title && i.description));
  r.check("a step that does not apply is left out", onboardingItems({ github: true }).length === 1);
  r.check("nothing known, nothing listed", onboardingItems({}).length === 0);

  // --- which schedules count as covering the files -----------------------------------
  r.check("the old preset (config only) does not count", !policyCoversVolumes(JSON.stringify([{ kind: "all-services" }, { kind: "all-projects", include: ["config"] }])));
  r.check("all projects with volumes counts", policyCoversVolumes(JSON.stringify([{ kind: "all-projects", include: ["config", "volumes"] }])));
  r.check("one project with volumes counts", policyCoversVolumes(JSON.stringify([{ kind: "project", id: "p1", include: ["volumes"] }])));
  r.check("databases alone do not count", !policyCoversVolumes(JSON.stringify([{ kind: "all-services" }])));
  r.check("garbage does not count", !policyCoversVolumes("not json") && !policyCoversVolumes("{}"));

  // --- names on the cards -------------------------------------------------------------
  r.check("runtimes read as people say them", runtimeLabel("node") === "Node.js" && runtimeLabel("static") === "Sito statico" && runtimeLabel("compose") === "Docker Compose");
  r.check("an unknown runtime keeps its name", runtimeLabel("bun") === "bun");
  r.check("no runtime yet says so", runtimeLabel(null) === "Da configurare");
  r.check("engines read as people say them", engineLabel("postgresql") === "PostgreSQL" && engineLabel("mongodb") === "MongoDB");
  r.check("with the version", engineWithVersion("postgresql", "16") === "PostgreSQL 16" && engineWithVersion("redis", null) === "Redis");
  r.check("deploy counts", deployCountLabel(0) === "nessun deploy" && deployCountLabel(1) === "1 deploy" && deployCountLabel(4) === "4 deploy");

  // --- the feed's sentences -------------------------------------------------------------
  r.check("a known action reads as a sentence", actionLabel("auth.login") === "Accesso");
  r.check("an unknown one falls back to its key", actionLabel("something.new") === "something.new");

  return r.result();
}
