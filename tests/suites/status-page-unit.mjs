import { createReporter } from "../harness.mjs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The public status page without a server: the two decisions that matter on
 * the one screen anyone can open without signing in.
 *
 *  - whether an address gets the page. Off, or any path but the owner's, is
 *    the same "not found" as a path that never existed; only the owner,
 *    signed in, gets a preview of a page that is off.
 *  - what it may say. The owner's words and, per project, a state, uptime
 *    figures and the times of outages. Fed inputs full of everything the
 *    panel knows about a project — its internal name, slug, port, path, id,
 *    server, the cause of a failed check — none of it may come out, whether
 *    the status was made here or arrived from another server.
 *
 * And the request schema, loaded with the extension hook `validation-unit`
 * uses, for what the settings route accepts.
 */
export const meta = { name: "status-page-unit", needsDocker: false, drivers: [], standalone: true };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export async function run({ repoRoot }) {
  const r = createReporter("status-page-unit");
  const s = await import(pathToFileURL(join(repoRoot, "lib", "status-page.ts")).href);

  // --- the address ----------------------------------------------------------------------
  {
    const slugs = Array.from({ length: 200 }, () => s.randomSlug());
    r.check("a random path is twelve characters", slugs.every((slug) => slug.length === s.RANDOM_SLUG_LENGTH), slugs[0]);
    r.check("and a valid one", slugs.every((slug) => s.isValidSlug(slug)));
    r.check("from the unambiguous alphabet", slugs.every((slug) => /^[2-9a-km-np-z]+$/.test(slug)), slugs.find((slug) => !/^[2-9a-km-np-z]+$/.test(slug)));
    r.check("and never the same twice", new Set(slugs).size === slugs.length);

    r.check("a short memorable path is allowed", s.isValidSlug("stato") && s.isValidSlug("acme-status") && s.isValidSlug("abc"));
    r.check("two characters are not", !s.isValidSlug("ab"));
    r.check("sixty-five are not", !s.isValidSlug("a".repeat(65)) && s.isValidSlug("a".repeat(64)));
    r.check("no capitals, no dots, no slashes", !s.isValidSlug("Stato") && !s.isValidSlug("a.b") && !s.isValidSlug("a/b") && !s.isValidSlug("../x"));
    r.check("no encoded characters", !s.isValidSlug("%2e%2e") && !s.isValidSlug("st%41to"));
    r.check("no dash at either end", !s.isValidSlug("-abc") && !s.isValidSlug("abc-") && s.isValidSlug("a-b-c"));
    r.check("not a number or nothing", !s.isValidSlug(123) && !s.isValidSlug(null) && !s.isValidSlug(""));
    r.check("the path is under /status", s.statusPagePath("abc") === "/status/abc");
    r.check(
      "the proxy gates /status and below, and nothing else",
      s.isStatusPagePath("/status") && s.isStatusPagePath("/status/abc") && s.isStatusPagePath("/status/abc/x") && !s.isStatusPagePath("/statuses") && !s.isStatusPagePath("/api/status-page")
    );
    r.check("the slug it sees is what the page would", s.slugOfPath("/status/abc") === "abc" && s.slugOfPath("/status") === "" && !s.isValidSlug(s.slugOfPath("/status/abc/x")));
    r.check("a miss goes where no page can be: a private folder", /^\/_[a-z-]+$/.test(s.STATUS_PAGE_MISS) && !s.STATUS_PAGE_MISS.startsWith("/_next"));
  }

  // --- what is stored ----------------------------------------------------------------------
  {
    r.check("nothing stored is no page", s.parseStatusPageConfig(null) === null && s.parseStatusPageConfig("") === null);
    r.check("garbage is no page", s.parseStatusPageConfig("{nope") === null && s.parseStatusPageConfig("[]") === null);
    r.check("no valid slug, no page", s.parseStatusPageConfig(JSON.stringify({ enabled: true, slug: "../admin" })) === null);

    const loose = s.parseStatusPageConfig(JSON.stringify({ enabled: "true", slug: "abc", allowIndexing: 1 }));
    r.check("on only when literally true", loose !== null && loose.enabled === false && loose.allowIndexing === false, JSON.stringify(loose));
    r.check("a missing title is the default", loose.title === s.DEFAULT_TITLE && loose.message === "" && loose.projects.length === 0);

    const parsed = s.parseStatusPageConfig(
      JSON.stringify({
        enabled: true,
        slug: "abc",
        title: "  Stato\n di\tAcme  ",
        message: "Riga uno\r\n\r\n\r\n\r\nRiga due\u0007",
        projects: [
          { server: null, projectId: "p1", name: "  Sito  " },
          { server: null, projectId: "p1", name: "Doppione" },
          { server: null, projectId: "p2", name: "   " },
          { server: "m1", projectId: "p1", name: "Altro server" },
          { server: "../x", projectId: "p3", name: "Server strano" },
          { projectId: "p 4", name: "Id strano" },
          "nemmeno un oggetto",
        ],
      })
    );
    r.check("a title is one line", parsed.title === "Stato di Acme", JSON.stringify(parsed.title));
    r.check("a message keeps one empty line, nothing invisible", parsed.message === "Riga uno\n\nRiga due", JSON.stringify(parsed.message));
    r.check(
      "a project shown twice, one with no name and malformed ones are dropped",
      JSON.stringify(parsed.projects.map((p) => [p.server, p.projectId, p.name])) === JSON.stringify([[null, "p1", "Sito"], ["m1", "p1", "Altro server"]]),
      JSON.stringify(parsed.projects)
    );

    r.check(
      "no invisible characters in what the public reads",
      s.cleanLine("Si‮to​", 60) === "Sito" && s.cleanText("Ri⁦ga﻿", 600) === "Riga"
    );

    const many = s.parseStatusPageConfig(
      JSON.stringify({ slug: "abc", projects: Array.from({ length: 40 }, (_, i) => ({ projectId: `p${i}`, name: `P${i}` })) })
    );
    r.check("at most thirty projects", many.projects.length === s.MAX_PAGE_PROJECTS, String(many.projects.length));

    const defaults = s.defaultStatusPageConfig();
    r.check("a new page starts off, unindexed, with a random path", defaults.enabled === false && defaults.allowIndexing === false && s.isValidSlug(defaults.slug));

    const normalized = s.normalizeEntries([{ server: "self", projectId: "a", name: "A" }, { server: "other", projectId: "b", name: "B" }], "self");
    r.check("this server named by its id is this server", normalized[0].server === null && normalized[1].server === "other");
  }

  // --- who gets the page --------------------------------------------------------------------
  {
    const on = { ...s.defaultStatusPageConfig("stato-acme"), enabled: true };
    const off = { ...on, enabled: false };
    r.check("no page answers nobody", s.pageAccess(null, "stato-acme", true) === null);
    r.check("on, at its address: the page", s.pageAccess(on, "stato-acme", false) === "public");
    r.check("on, elsewhere: nothing", s.pageAccess(on, "stato-acm", false) === null && s.pageAccess(on, "stato-acme-", false) === null);
    r.check("the address is exact", s.pageAccess(on, "Stato-Acme", false) === null && s.pageAccess(on, "stato-acme/", false) === null);
    r.check("off: nothing, the same as a wrong address", s.pageAccess(off, "stato-acme", false) === null);
    r.check("off, for the owner: a preview", s.pageAccess(off, "stato-acme", true) === "preview");
    r.check("off, for the owner at a wrong address: nothing", s.pageAccess(off, "stato", true) === null);
    r.check("a preview is never indexed", !s.allowsIndexing({ ...off, allowIndexing: true }, "preview"));
    r.check("a page is indexed only when allowed", !s.allowsIndexing(on, "public") && s.allowsIndexing({ ...on, allowIndexing: true }, "public"));
  }

  // --- a project's state --------------------------------------------------------------------
  {
    const base = { status: "running", watched: true, last: { at: 0, ok: true }, open: null };
    const state = (over) => s.publicState({ ...base, ...over });
    r.check("answering: up", state({}) === "up");
    r.check("one failed check with no incident is still up", state({ last: { at: 0, ok: false } }) === "up");
    r.check("an open incident: down", state({ open: { startedAt: new Date(0).toISOString() } }) === "down");
    r.check("no recent check: no data", state({ last: null }) === "unknown");
    r.check("not checked at all: no data", state({ watched: false }) === "unknown" && state({ watched: false, open: { startedAt: "x" } }) === "unknown");
    r.check("a deploy is maintenance", state({ status: "deploying", open: { startedAt: "x" } }) === "maintenance");
    r.check("stopped or in error does not answer", state({ status: "stopped" }) === "down" && state({ status: "error", watched: false }) === "down");
  }

  // --- nothing unchosen leaks ----------------------------------------------------------------
  const now = Date.UTC(2026, 10, 18, 12, 0);
  const secrets = ["internal-billing", "Billing Interno", "8443", "/healthz", "status:502", "refused", "prj_secret01", "member_x9", "10.0.0.7", "Nessuno risponde"];
  const rich = {
    // What `uptimeSummary` and the project row hold, and more.
    id: "prj_secret01",
    name: "Billing Interno",
    slug: "internal-billing",
    port: 8443,
    path: "/healthz",
    server: "member_x9",
    url: "http://10.0.0.7:8443/healthz",
    status: "running",
    watched: true,
    up24h: 0.99,
    up30d: 0.995,
    checks24h: 1440,
    latency24h: 123,
    series: { t: [1, 2], series: { latency: [10, 20] } },
    last: { at: now - MIN, ok: false, latencyMs: 8443 },
    since: { at: 1, atLeast: true },
    days: Array.from({ length: 30 }, (_, i) => ({ day: now - (29 - i) * DAY, ratio: i === 29 ? 0.9 : 1, cause: "refused" })),
    open: { id: "inc1", startedAt: new Date(now - 12 * MIN).toISOString(), endedAt: null, cause: "status:502", resolution: null, durationMs: 1 },
    incidents: [
      { id: "inc1", startedAt: new Date(now - 12 * MIN).toISOString(), endedAt: null, cause: "status:502", resolution: null, durationMs: 1 },
      { id: "inc2", startedAt: new Date(now - 2 * DAY).toISOString(), endedAt: new Date(now - 2 * DAY + 5 * MIN).toISOString(), cause: "refused", resolution: "paused", durationMs: 1, detail: "Nessuno risponde sulla porta 8443" },
      { id: "inc3", startedAt: new Date(now - 40 * DAY).toISOString(), endedAt: new Date(now - 40 * DAY + MIN).toISOString(), cause: "timeout", resolution: "recovered", durationMs: 1 },
    ],
  };

  {
    const status = s.projectStatus(rich, now);
    r.check(
      "a project's status has exactly the allowed fields",
      JSON.stringify(Object.keys(status).sort()) === JSON.stringify(["days", "incidents", "since", "state", "up24h", "up30d"]),
      Object.keys(status).join(",")
    );
    r.check("its days, only a day and a share", status.days.every((d) => JSON.stringify(Object.keys(d).sort()) === '["day","ratio"]') && status.days.length === 30);
    r.check(
      "its incidents, only when and whether the end is known",
      status.incidents.every((i) => JSON.stringify(Object.keys(i).sort()) === '["endUnknown","endedAt","startedAt"]'),
      JSON.stringify(status.incidents)
    );
    r.check("down, since the incident began", status.state === "down" && status.since === now - 12 * MIN);
    r.check("outages older than thirty days are left out", status.incidents.length === 2, JSON.stringify(status.incidents));
    r.check("a watch that stopped is an end not known", status.incidents[1].endUnknown === true && status.incidents[0].endUnknown === false);
    const text = JSON.stringify(status);
    const leaked = secrets.filter((secret) => text.includes(secret));
    r.check("nothing else the panel knows comes out", leaked.length === 0, leaked.join(", "));

    const up = s.projectStatus({ ...rich, open: null, last: { at: now, ok: true } }, now);
    r.check("no outage, no since", up.state === "up" && up.since === null);
    r.check("figures are kept between 0 and 1", s.projectStatus({ ...rich, up24h: 7, up30d: Number.NaN }, now).up24h === 1 && s.projectStatus({ ...rich, up30d: Number.NaN }, now).up30d === null);
  }

  {
    // From another server: rebuilt, not trusted.
    const answer = {
      state: "up",
      since: null,
      up24h: 0.5,
      up30d: 2,
      name: "Billing Interno",
      port: 8443,
      days: [{ day: now, ratio: 1, cause: "refused", path: "/healthz" }, { day: "oggi", ratio: 1 }, null],
      incidents: [{ startedAt: now - MIN, endedAt: null, endUnknown: "yes", cause: "status:502" }, { startedAt: "ieri" }],
      server: "member_x9",
    };
    const status = s.readProjectStatus(answer);
    r.check("a remote status is rebuilt from known fields", status !== null && JSON.stringify(Object.keys(status).sort()) === JSON.stringify(["days", "incidents", "since", "state", "up24h", "up30d"]));
    r.check("its malformed days and incidents are dropped", status.days.length === 1 && status.incidents.length === 1, JSON.stringify(status));
    r.check("its figures are clamped", status.up30d === 1 && status.up24h === 0.5);
    r.check("only a literal true is an unknown end", status.incidents[0].endUnknown === false);
    const leaked = secrets.filter((secret) => JSON.stringify(status).includes(secret));
    r.check("and nothing else from it comes out", leaked.length === 0, leaked.join(", "));
    r.check("an unknown state is not a status", s.readProjectStatus({ ...answer, state: "great" }) === null && s.readProjectStatus("up") === null && s.readProjectStatus(null) === null);
  }

  // --- the page ---------------------------------------------------------------------------------
  {
    const down = s.projectStatus(rich, now);
    const up = s.projectStatus({ ...rich, open: null, last: { at: now, ok: true } }, now);
    const snapshot = s.assembleSnapshot(
      [
        { name: "Sito", outcome: down },
        { name: "Negozio", outcome: up },
        { name: "Eliminato", outcome: "missing" },
        { name: "Lontano", outcome: "unavailable" },
      ],
      now
    );
    r.check(
      "a deleted project is left off, an unreachable one shows no data",
      snapshot.projects.map((p) => `${p.name}:${p.state}`).join(",") === "Sito:down,Negozio:up,Lontano:unknown",
      JSON.stringify(snapshot.projects.map((p) => p.name))
    );
    r.check("no data has no days", snapshot.projects[2].days.length === 0 && snapshot.projects[2].up24h === null);
    r.check("the counts", JSON.stringify(snapshot.counts) === JSON.stringify({ up: 1, down: 1, maintenance: 0, unknown: 1 }));
    r.check("one down among others is partial", snapshot.verdict === "partial");
    r.check(
      "outages carry the public name, newest first",
      snapshot.incidents.length === 4 && snapshot.incidents[0].name === "Sito" && snapshot.incidents.every((i, k, all) => k === 0 || all[k - 1].startedAt >= i.startedAt),
      JSON.stringify(snapshot.incidents)
    );
    r.check(
      "a project on the page has exactly the allowed fields",
      JSON.stringify(Object.keys(snapshot.projects[0]).sort()) === JSON.stringify(["days", "name", "since", "state", "up24h", "up30d"])
    );
    const text = JSON.stringify(snapshot);
    const leaked = secrets.filter((secret) => text.includes(secret));
    r.check("the whole page holds none of what the owner did not choose", leaked.length === 0, leaked.join(", "));

    const flood = s.assembleSnapshot(
      Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, outcome: { ...up, incidents: Array.from({ length: 10 }, (_, k) => ({ startedAt: now - (i * 10 + k) * MIN, endedAt: now, endUnknown: false })) } })),
      now
    );
    r.check("ten outages at most, all projects together", flood.incidents.length === s.PAGE_INCIDENTS);
  }

  {
    r.check("nothing to show", s.overallVerdict([]) === "empty");
    r.check("all up", s.overallVerdict(["up", "up"]) === "up");
    r.check("up and no data is still up", s.overallVerdict(["up", "unknown"]) === "up");
    r.check("all down", s.overallVerdict(["down", "down"]) === "down");
    r.check("a deploy, nothing down", s.overallVerdict(["up", "maintenance"]) === "maintenance");
    r.check("down wins over a deploy", s.overallVerdict(["down", "maintenance"]) === "partial");
    r.check("only no data", s.overallVerdict(["unknown"]) === "unknown");
    const counts = { up: 1, down: 0, maintenance: 0, unknown: 1 };
    r.check("up with a gap says so", s.verdictWords("up", counts).title === "Nessun problema rilevato");
    r.check("all up says so", s.verdictWords("up", { ...counts, unknown: 0 }).title === "Tutti i servizi sono operativi");
    r.check("partial counts the ones down", s.verdictWords("partial", { up: 3, down: 2, maintenance: 0, unknown: 0 }).detail === "2 su 5 non rispondono in questo momento.");
    r.check("every state has words", ["up", "down", "maintenance", "unknown"].every((state) => s.STATE_WORDS[state].label.length > 0));
    r.check("a bad day is not a single miss", s.dayTone(1) === "success" && s.dayTone(0.9996) === "success" && s.dayTone(0.995) === "warning" && s.dayTone(0.5) === "danger" && s.dayTone(null) === "neutral");
  }

  {
    r.check("UTC is no offset", s.zoneOffsetMinutes("UTC", now) === 0);
    r.check("Rome in winter is one hour east", s.zoneOffsetMinutes("Europe/Rome", Date.UTC(2026, 0, 15)) === 60);
    r.check("and two in summer", s.zoneOffsetMinutes("Europe/Rome", Date.UTC(2026, 6, 15)) === 120);
    r.check("New York is west", s.zoneOffsetMinutes("America/New_York", Date.UTC(2026, 0, 15)) === -300);
    r.check("half hours count", s.zoneOffsetMinutes("Asia/Kolkata", now) === 330);
    r.check("a zone nobody knows is UTC", s.zoneOffsetMinutes("Mars/Olympus", now) === 0);
  }

  // --- what the settings route accepts ----------------------------------------------------------
  {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
        const fromTs = context.parentURL?.endsWith(".ts");
        return nextResolve(extensionless && fromTs ? `${specifier}.ts` : specifier, context);
      },
    });
    const { statusPageSchema } = await import(pathToFileURL(join(repoRoot, "lib", "validation.ts")).href);
    const ok = (body) => statusPageSchema.safeParse(body);

    r.check("everything is optional", ok({}).success && ok({ enabled: true }).success);
    r.check("nothing unknown", !ok({ enabled: true, theme: "dark" }).success && !ok({ projects: [{ projectId: "a", name: "A", port: 80 }] }).success);
    r.check("a slug is lower-cased and checked", ok({ slug: " Stato " }).data?.slug === "stato" && !ok({ slug: "st/ato" }).success && !ok({ slug: "ab" }).success);
    r.check("a title is needed and one line", !ok({ title: "   " }).success && ok({ title: "Stato\ndi Acme" }).data?.title === "Stato di Acme");
    r.check("a title has a limit", !ok({ title: "x".repeat(s.TITLE_MAX + 1) }).success && ok({ title: "x".repeat(s.TITLE_MAX) }).success);
    r.check("a message may be empty, not endless", ok({ message: "" }).success && !ok({ message: "x".repeat(s.MESSAGE_MAX + 1) }).success);
    r.check("a public name is needed", !ok({ projects: [{ projectId: "a", name: " \u0000 " }] }).success);
    r.check("and cleaned", ok({ projects: [{ projectId: "a", name: " Sito\twww " }] }).data?.projects[0].name === "Sito www");
    r.check("a public name has a limit", !ok({ projects: [{ projectId: "a", name: "x".repeat(s.PUBLIC_NAME_MAX + 1) }] }).success);
    r.check(
      "the same project twice is refused",
      !ok({ projects: [{ projectId: "a", name: "A" }, { projectId: "a", name: "B" }] }).success &&
        ok({ projects: [{ projectId: "a", name: "A" }, { server: "m1", projectId: "a", name: "B" }] }).success
    );
    r.check("ids are the panel's", !ok({ projects: [{ projectId: "../a", name: "A" }] }).success && !ok({ projects: [{ server: "x y", projectId: "a", name: "A" }] }).success);
    r.check(
      "thirty projects at most",
      !ok({ projects: Array.from({ length: s.MAX_PAGE_PROJECTS + 1 }, (_, i) => ({ projectId: `p${i}`, name: "P" })) }).success
    );
    r.check("the switches are booleans", !ok({ enabled: "true" }).success && !ok({ allowIndexing: 1 }).success);
  }

  return r.result();
}
