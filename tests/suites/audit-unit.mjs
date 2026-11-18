import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

/**
 * What the activity log records, and who gets to read which entry.
 *
 * Two rules matter most. Security events are recorded whatever the owner turns
 * off — a log where one can switch off one's own traces is not a log. And an
 * entry is shown only to someone who could see what it is about, or the log
 * becomes a side door listing projects nobody granted.
 */
export const meta = { name: "audit-unit", needsDocker: false, drivers: [], standalone: true };

/** The `${...}` actions, and what each can become. A new one has to be listed here. */
const TEMPLATE_ACTIONS = {
  "`service.console.${mode}`": ["service.console.engine", "service.console.shell"],
  "`user.${kind}`": ["user.invite", "user.reset"],
};

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * Every action the code records, read from the calls themselves. Each call
 * writes `category` and then `action`; the count against the calls is what keeps
 * this honest, so a call written another way fails here instead of going unread.
 */
function recordedActions(repoRoot) {
  const actions = new Set();
  const unreadable = [];
  let calls = 0;
  let read = 0;
  for (const file of ["app", "services", "lib"].flatMap((dir) => sourceFiles(join(repoRoot, dir)))) {
    if (file.endsWith(join("lib", "audit.ts"))) continue;
    const source = readFileSync(file, "utf8");
    calls += [...source.matchAll(/\baudit\(\{|\bwithAudit\(\w+,\s*\{/g)].length;
    for (const [, expression] of source.matchAll(/category:\s*"[a-z]+",\s*action:\s*([^,\n]+)/g)) {
      read += 1;
      const known = TEMPLATE_ACTIONS[expression.trim()];
      const literals = [...expression.matchAll(/"([a-z-]+(?:\.[a-z-]+)+)"/g)].map((m) => m[1]);
      if (known) known.forEach((action) => actions.add(action));
      else if (literals.length > 0 && !expression.includes("`")) literals.forEach((action) => actions.add(action));
      else unreadable.push(`${file}: ${expression.trim()}`);
    }
  }
  return { actions, unreadable, calls, read };
}

export async function run({ repoRoot }) {
  const r = createReporter("audit-unit");
  const { AUDIT_CATEGORIES, parseEnabledCategories, shouldRecord, canSeeEntry, retentionCutoff, parseRetentionDays } =
    await import(pathToFileURL(join(repoRoot, "lib", "audit-filter.ts")).href);

  // --- labels ----------------------------------------------------------------
  {
    const { actions, unreadable, calls, read } = recordedActions(repoRoot);
    // The map lives in lib/audit-labels.ts, shared by the log page and the Overview's feed.
    const page = readFileSync(join(repoRoot, "lib", "audit-labels.ts"), "utf8");
    const block = page.slice(page.indexOf("export const ACTION_LABEL"), page.indexOf("export function actionLabel"));
    const labels = new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));

    r.check("the scan reads every audit call", calls > 50 && read === calls, `${read} of ${calls}`);
    r.check("every action is a literal or a listed template", unreadable.length === 0, unreadable.join("; "));
    const missing = [...actions].filter((action) => !labels.has(action));
    r.check("every recorded action has a label in the log", missing.length === 0, missing.join(", "));
  }

  // --- categories ------------------------------------------------------------
  {
    const all = parseEnabledCategories(null);
    r.check("nothing stored records everything", AUDIT_CATEGORIES.every((c) => all.has(c)));
    const some = parseEnabledCategories(JSON.stringify(["deploy"]));
    r.check("a stored list is honoured", some.has("deploy") && !some.has("config"));
    r.check("security is always on", some.has("security"));
    r.check("garbage falls back to everything", parseEnabledCategories("{nope").size === AUDIT_CATEGORIES.length);
    r.check("unknown names are dropped", !parseEnabledCategories(JSON.stringify(["deploy", "bogus"])).has("bogus"));
    r.check("security records even when absent from the list", shouldRecord("security", new Set(["deploy"])));
    r.check("a disabled category does not record", !shouldRecord("config", new Set(["deploy"])));
  }

  // --- retention -------------------------------------------------------------
  {
    r.check("retention defaults to 90 days", parseRetentionDays(null) === 90);
    r.check("retention is clamped to at least a day", parseRetentionDays("0") === 1);
    r.check("retention is clamped to ten years", parseRetentionDays("99999") === 3650);
    r.check("garbage retention is the default", parseRetentionDays("abc") === 90);
    const now = new Date("2026-10-09T00:00:00.000Z");
    r.check("the cutoff is that many days back", retentionCutoff(10, now) === "2026-09-29T00:00:00.000Z", retentionCutoff(10, now));
  }

  // --- visibility ------------------------------------------------------------
  {
    const owner = { userId: "o", isOwner: true, permissions: new Set(), grants: [] };
    const user = (perms = []) => ({ userId: "u", isOwner: false, permissions: new Set(perms), grants: [] });
    const visible = { projects: new Set(["p1"]), services: new Set(["s1"]), folders: new Set(["f1"]) };
    const e = (category, scope = null, scopeId = null) => ({ category, scope, scopeId });

    r.check("the owner sees everything", canSeeEntry(owner, e("security", "user", "x"), visible));
    r.check("a visible project's entry is shown", canSeeEntry(user(), e("deploy", "project", "p1"), visible));
    r.check("another project's entry is hidden", !canSeeEntry(user(), e("deploy", "project", "p2"), visible));
    r.check("a visible service's entry is shown", canSeeEntry(user(), e("terminal", "service", "s1"), visible));
    r.check("a folder entry follows folder visibility", !canSeeEntry(user(), e("delete", "folder", "f2"), visible));
    r.check("a panel entry needs that permission", canSeeEntry(user(["backup"]), e("backup", "permission", "backup"), visible));
    r.check("without it the panel entry is hidden", !canSeeEntry(user(["monitor"]), e("backup", "permission", "backup"), visible));
    r.check("security entries need users.manage", !canSeeEntry(user(["backup"]), e("security", "user", "x"), visible));
    r.check("users.manage sees security entries", canSeeEntry(user(["users.manage"]), e("security", null, null), visible));
    r.check("an entry about nothing is the owner's", !canSeeEntry(user(["backup"]), e("system", null, null), visible));
  }

  return r.result();
}
