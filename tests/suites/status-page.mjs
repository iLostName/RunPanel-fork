import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The public status page over HTTP, end to end on a real server.
 *
 * What `status-page-unit` cannot see: that the page is really served without
 * a session, that off and a wrong address are the same 404 as a path that
 * never existed — status and title — while the owner, signed in, gets a
 * preview; that the HTML carries the owner's title, message and names and
 * none of the project's own (name, slug, id); that `noindex` follows the
 * switch; that only the owner may change it, the cluster lookup answers no
 * user, and the activity log says when the page went public. The test
 * servers run with the timers off, so the projects have no checks: their
 * figures are `uptime-unit`'s business. On Postgres too when configured.
 */
export const meta = { name: "status-page", needsDocker: false, drivers: ["sqlite", "postgres"] };

const NOINDEX = /<meta name="robots" content="noindex/;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const titleOf = (html) => /<title>([^<]*)<\/title>/.exec(typeof html === "string" ? html : "")?.[1] ?? null;
/** The page's text as a reader gets it: no scripts, no tags, single spaces. */
function visible(html) {
  const page = typeof html === "string" ? html : "";
  return page
    .slice(Math.max(0, page.indexOf("<main")))
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
/** Everything a visitor of a page reads, head excluded: what two 404s are compared by. */
function bodyText(html) {
  const page = typeof html === "string" ? html : "";
  return page
    .slice(Math.max(0, page.indexOf("<body")))
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const iso = (ms) => new Date(ms).toISOString();

export async function run({ base, dataDir }) {
  const r = createReporter("status-page");
  const owner = client(base);
  const anon = client(base);
  const json = (method, body) => ({ method, body: JSON.stringify(body) });
  const text = (res) => (typeof res.body === "string" ? res.body : JSON.stringify(res.body));

  let res = await owner.call(
    "/api/auth/login",
    json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "status-pw-1" })
  );
  r.check("setup", res.status === 200, JSON.stringify(res.body));

  // --- nothing set up -----------------------------------------------------------------------
  const missing = await anon.call("/questa-pagina-non-esiste");
  r.check("a path that never existed is not found", missing.status === 404 && bodyText(missing.body).includes("Pagina non trovata"), String(missing.status));
  // The same status, title and words as that, and not Next's error shell: nothing to tell them apart by.
  const like404 = (res) =>
    res.status === 404 &&
    titleOf(res.body) === titleOf(missing.body) &&
    bodyText(res.body) === bodyText(missing.body) &&
    !text(res).includes("__next_error__");
  res = await anon.call("/status/abcdefghjkmn");
  r.check("with no page, any address under /status is the same", like404(res), `${res.status} ${titleOf(res.body)}`);

  res = await anon.call("/api/status-page");
  r.check("no session, no settings", res.status === 401, String(res.status));
  res = await owner.call("/api/status-page");
  const proposed = res.body?.slug;
  r.check(
    "the owner reads a proposal: off, not saved, a random address",
    res.status === 200 && res.body.enabled === false && res.body.saved === false && /^[a-z0-9]{12}$/.test(proposed ?? "") && res.body.path === `/status/${proposed}`,
    JSON.stringify(res.body).slice(0, 300)
  );

  res = await owner.call("/api/projects", json("POST", { name: "Fatturazione Interna" }));
  const billing = res.body;
  r.check("a project", res.status === 201 && Boolean(billing?.id), JSON.stringify(res.body).slice(0, 200));
  res = await owner.call("/api/projects", json("POST", { name: "Altro Progetto" }));
  const otherId = res.body?.id;
  res = await owner.call("/api/projects", json("POST", { name: "Progetto Escluso" }));
  const leftOutId = res.body?.id;
  // The successful changes that are neither switching on nor off, to hold the log to.
  let updates = 0;

  // --- saved, still off ---------------------------------------------------------------------
  res = await owner.call(
    "/api/status-page",
    json("PUT", { slug: proposed, title: "Stato di Acme", message: "Manutenzione sabato sera", projects: [{ projectId: billing.id, name: "Sito pubblico" }] })
  );
  if (res.status === 200) updates++;
  r.check("saved, still off", res.status === 200 && res.body.saved === true && res.body.enabled === false && res.body.projects?.length === 1, JSON.stringify(res.body).slice(0, 300));
  r.check(
    "and it says the check does not ask that project, and why",
    res.body.checks?.[billing.id]?.active === false && res.body.checks?.[billing.id]?.skip === "not-running",
    JSON.stringify(res.body.checks)
  );
  r.check("with the address to hand out", typeof res.body.url === "string" && res.body.url.endsWith(`/status/${proposed}`), res.body.url);

  res = await anon.call(`/status/${proposed}`);
  r.check("off, its own address is not found", like404(res), `${res.status} ${titleOf(res.body)}`);
  r.check("and says nothing of what is behind it", !text(res).includes("Stato di Acme") && !text(res).includes("Sito pubblico"));
  res = await owner.call(`/status/${proposed}`);
  r.check("the owner, signed in, gets a preview", res.status === 200 && text(res).includes("Anteprima") && text(res).includes("Sito pubblico"), String(res.status));
  r.check("which is never indexed", NOINDEX.test(text(res)));

  // --- public -------------------------------------------------------------------------------
  res = await owner.call("/api/status-page", json("PUT", { enabled: true }));
  r.check("switched on, the rest kept", res.status === 200 && res.body.enabled === true && res.body.title === "Stato di Acme" && res.body.projects?.[0]?.name === "Sito pubblico", JSON.stringify(res.body).slice(0, 300));

  res = await anon.call(`/status/${proposed}`);
  const html = text(res);
  r.check("anyone gets the page, without a session", res.status === 200, String(res.status));
  r.check("under the owner's title, not the panel's", titleOf(html) === "Stato di Acme", titleOf(html));
  r.check("with the message and the public name", html.includes("Manutenzione sabato sera") && html.includes("Sito pubblico"));
  r.check(
    "and nothing of the project's own",
    !html.includes("Fatturazione Interna") && !html.includes(billing.id) && !html.includes(billing.slug) && !html.includes("Altro Progetto") && !html.includes("Progetto Escluso"),
    [billing.id, billing.slug].filter((needle) => html.includes(needle)).join(", ")
  );
  r.check("a project that is not running does not answer", visible(html).includes("Sito pubblico Non risponde"), visible(html).slice(0, 300));
  r.check("no preview banner for the public", !html.includes("Anteprima"));
  r.check("not indexed unless the owner allows it", NOINDEX.test(html));

  for (const [what, wrong] of [
    ["a character more", `/status/${proposed}x`],
    ["a character less", `/status/${proposed.slice(0, -1)}`],
    ["in capitals", `/status/${proposed.toUpperCase()}`],
    ["below it", `/status/${proposed}/x`],
    ["no path at all", "/status"],
  ]) {
    res = await anon.call(wrong);
    r.check(`the address with ${what} is not found`, like404(res), `${res.status} ${titleOf(res.body)}`);
  }

  res = await owner.call("/api/status-page", json("PUT", { allowIndexing: true }));
  if (res.status === 200) updates++;
  res = await anon.call(`/status/${proposed}`);
  r.check("indexed once allowed", res.status === 200 && !NOINDEX.test(text(res)) && /<meta name="robots" content="index/.test(text(res)), /<meta name="robots"[^>]*>/.exec(text(res))?.[0]);

  // --- with figures ---------------------------------------------------------------------------
  // The timers are off here, so the checks are written into the store the way
  // the checker writes them, with every detail the page must not repeat: the
  // ports, the causes. SQLite only, where the store is a file in reach.
  const dbFile = join(dataDir, "runpanel.db");
  if (existsSync(dbFile)) {
    const SQLite = createRequire(import.meta.url)("better-sqlite3");
    const db = new SQLite(dbFile);
    const now = Date.now();
    try {
      db.prepare("UPDATE projects SET status = 'running', port = ? WHERE id = ?").run(58231, billing.id);
      db.prepare("UPDATE projects SET status = 'running', port = ? WHERE id = ?").run(58232, otherId);
      const sample = db.prepare("INSERT INTO metric_samples (scope, subject_id, tier, ts, n, up, latency) VALUES ('uptime', ?, 0, ?, 1, ?, ?)");
      for (let i = 1; i <= 5; i++) sample.run(billing.id, now - i * MIN, 1, 12);
      for (let i = 1; i <= 5; i++) sample.run(otherId, now - i * MIN, i <= 3 ? 0 : 1, i <= 3 ? null : 15);
      const incident = db.prepare("INSERT INTO uptime_incidents (id, project_id, started_at, ended_at, cause, resolution) VALUES (?, ?, ?, ?, ?, ?)");
      incident.run("inc-old", billing.id, iso(now - 40 * DAY), iso(now - 40 * DAY + 5 * MIN), "timeout", "recovered");
      incident.run("inc-recovered", billing.id, iso(now - 2 * DAY), iso(now - 2 * DAY + 7 * MIN), "status:502", "recovered");
      incident.run("inc-paused", billing.id, iso(now - DAY), iso(now - DAY + 3 * MIN), "refused", "paused");
      incident.run("inc-open", otherId, iso(now - 3 * MIN), null, "status:503", null);
    } finally {
      db.close();
    }

    // Saving drops the cached figures, as it does for the owner in the browser.
    res = await owner.call(
      "/api/status-page",
      json("PUT", { projects: [{ projectId: billing.id, name: "Sito pubblico" }, { projectId: otherId, name: "Negozio" }] })
    );
    if (res.status === 200) updates++;
    r.check("a second project on the page", res.status === 200 && res.body.projects?.length === 2, JSON.stringify(res.body).slice(0, 200));
    res = await anon.call(`/status/${proposed}`);
    const page = visible(res.body);
    r.check("one answering, one not: the verdict says which", page.includes("Un servizio non risponde") && page.includes("1 su 2 non risponde"), page.slice(0, 300));
    r.check("the one answering is up, over the last day too", page.includes("Sito pubblico Operativo Ultime 24 ore 100%"), page.slice(0, 600));
    r.check("the one in an outage says since when", page.includes("Negozio Non risponde da 3 minuti"), page.slice(0, 600));
    r.check("the outage going on is listed", /Negozio [^|]*→ in corso/.test(page), page.slice(page.indexOf("Interruzioni recenti"), page.indexOf("Interruzioni recenti") + 500));
    r.check("one the check stopped watching is a floor", page.includes("almeno 3 min, poi il controllo è stato sospeso"), page.slice(page.indexOf("Interruzioni recenti"), page.indexOf("Interruzioni recenti") + 500));
    r.check("one older than thirty days is not", (page.match(/Sito pubblico [0-9]{1,2} [a-z]{3},/g) ?? []).length === 2, JSON.stringify(page.match(/Sito pubblico [0-9]{1,2} [a-z]{3},[^·]*/g)));
    const raw = text(res);
    const leaked = ["58231", "58232", "status:502", "status:503", "HTTP 50", "Nessuno risponde sulla porta", "Risponde con un errore", "Non ha risposto entro", "Fatturazione Interna", "Altro Progetto", "Progetto Escluso", billing.id, otherId, leftOutId, billing.slug].filter((needle) =>
      raw.includes(needle)
    );
    r.check("none of the ports, causes, names or ids reach the page", leaked.length === 0, leaked.join(", "));

    // Back as they were: deleting a project the store thinks is running would
    // ask a process manager this machine may not have.
    const restore = new SQLite(dbFile);
    try {
      restore.prepare("UPDATE projects SET status = 'stopped', port = NULL WHERE id IN (?, ?)").run(billing.id, otherId);
    } finally {
      restore.close();
    }
  } else {
    r.note("figures written into the store: SQLite only, skipped on this driver");
  }

  // --- the uptime card links to it ----------------------------------------------------------
  res = await owner.call(`/api/projects/${billing.id}/uptime`);
  r.check(
    "the card of a project on the page links to it, under its public name",
    res.status === 200 && res.body?.publicPage?.name === "Sito pubblico" && res.body.publicPage.path === `/status/${proposed}` && res.body.publicPage.url?.endsWith(`/status/${proposed}`),
    JSON.stringify(res.body?.publicPage)
  );
  res = await owner.call(`/api/projects/${leftOutId}/uptime`);
  r.check("the card of one that is not, does not", res.status === 200 && res.body?.publicPage === null, JSON.stringify(res.body?.publicPage));

  // --- what is refused ------------------------------------------------------------------------
  res = await owner.call("/api/status-page", json("PUT", { slug: "a/b" }));
  r.check("a path that is not one", res.status === 400 && typeof res.body?.error === "string", JSON.stringify(res.body).slice(0, 200));
  res = await owner.call("/api/status-page", json("PUT", { projects: [{ projectId: "nonesiste123", name: "X" }] }));
  r.check("a project this server does not have", res.status === 400 && /non esiste/.test(res.body?.error ?? ""), JSON.stringify(res.body));
  res = await owner.call("/api/status-page", json("PUT", { projects: [{ server: "altroserver1", projectId: otherId, name: "X" }] }));
  r.check("a server outside the cluster", res.status === 400 && /cluster/.test(res.body?.error ?? ""), JSON.stringify(res.body));
  res = await owner.call("/api/status-page", json("PUT", { enabled: true, colour: "red" }));
  r.check("a field nobody knows", res.status === 400, String(res.status));
  res = await owner.call("/api/status-page", { method: "PUT", body: "{non è json" });
  r.check("a body that is not JSON", res.status === 400, String(res.status));
  res = await owner.call("/api/status-page", json("PUT", { projects: [{ projectId: billing.id, name: "  " }] }));
  r.check("a project with no public name", res.status === 400, JSON.stringify(res.body).slice(0, 200));
  res = await anon.call(`/status/${proposed}`);
  r.check("and the page is as it was", res.status === 200 && text(res).includes("Sito pubblico"), String(res.status));

  // --- a new address --------------------------------------------------------------------------
  res = await owner.call("/api/status-page", json("PUT", { slug: "Stato-Acme" }));
  if (res.status === 200) updates++;
  r.check("a memorable address, lower-cased", res.status === 200 && res.body.slug === "stato-acme" && res.body.path === "/status/stato-acme", JSON.stringify(res.body).slice(0, 200));
  res = await anon.call(`/status/${proposed}`);
  r.check("the old one stops working", res.status === 404, String(res.status));
  res = await anon.call("/status/stato-acme");
  r.check("the new one works", res.status === 200 && text(res).includes("Sito pubblico"), String(res.status));

  // --- who may change it ----------------------------------------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "admin@runpanel.test", hours: 1 }));
  const adminId = res.body?.user?.id;
  const token = res.body?.invitePath?.split("/").pop();
  const admin = client(base);
  res = await admin.call("/api/auth/invite", json("POST", { token, password: "admin-pw-12" }));
  r.check("a second account", res.status === 200, JSON.stringify(res.body));
  res = await owner.call(
    `/api/users/${adminId}`,
    json("PATCH", {
      access: {
        permissions: ["projects.create", "monitor", "notifications", "users.manage", "audit.view", "host", "nodes"],
        grants: [{ scope: "all", scopeId: null, level: "manage", terminal: true }],
      },
    })
  );
  r.check("with every project and most permissions", res.status === 200, JSON.stringify(res.body).slice(0, 200));
  res = await admin.call("/api/status-page");
  r.check("it cannot read the settings: they are the owner's", res.status === 403, String(res.status));
  res = await admin.call("/api/status-page", json("PUT", { enabled: false }));
  r.check("nor change them", res.status === 403, String(res.status));
  res = await anon.call("/status/stato-acme");
  r.check("and the page stays on", res.status === 200, String(res.status));
  res = await admin.call(`/api/projects/${billing.id}/uptime`);
  r.check("who can see a project on the page sees its link", res.status === 200 && res.body?.publicPage?.name === "Sito pubblico", JSON.stringify(res.body?.publicPage));

  res = await owner.call(`/api/cluster/status-page?ids=${billing.id}`);
  r.check("the cluster lookup answers no user, not even the owner", res.status === 401 || res.status === 403, String(res.status));

  // --- off again ------------------------------------------------------------------------------
  res = await owner.call("/api/status-page", json("PUT", { enabled: false }));
  r.check("switched off", res.status === 200 && res.body.enabled === false, JSON.stringify(res.body).slice(0, 200));
  res = await anon.call("/status/stato-acme");
  r.check("off at once: not found", like404(res), `${res.status} ${titleOf(res.body)}`);
  res = await admin.call("/status/stato-acme");
  r.check("signed in, but not the owner: the same 404, no preview", like404(res), `${res.status} ${titleOf(res.body)}`);
  res = await owner.call("/status/stato-acme");
  r.check("the owner still gets the preview", res.status === 200 && text(res).includes("Anteprima"), String(res.status));
  res = await owner.call(`/api/projects/${billing.id}/uptime`);
  r.check("and the card no longer links to it", res.body?.publicPage === null, JSON.stringify(res.body?.publicPage));

  res = await owner.call("/api/audit?limit=200");
  const actions = (res.body?.entries ?? []).map((e) => e.action);
  r.check(
    "the log says when it went public, changed and went dark",
    ["status-page.enable", "status-page.update", "status-page.disable"].every((action) => actions.includes(action)),
    JSON.stringify(actions.filter((a) => a.startsWith("status-page")))
  );
  r.check("and not the refused attempts", actions.filter((a) => a === "status-page.update").length === updates, JSON.stringify(actions.filter((a) => a.startsWith("status-page"))));

  // --- a project that goes away -------------------------------------------------------------
  res = await owner.call(`/api/projects/${billing.id}`, { method: "DELETE" });
  r.check("a project on the page is deleted", res.status === 200, JSON.stringify(res.body).slice(0, 200));
  res = await owner.call("/api/status-page");
  r.check("the settings say it no longer exists", res.status === 200 && res.body.missing?.includes(billing.id), JSON.stringify(res.body?.missing));
  res = await owner.call("/api/status-page", json("PUT", { projects: [] }));
  r.check("and it can be taken off", res.status === 200 && res.body.projects?.length === 0 && res.body.missing?.length === 0, JSON.stringify(res.body).slice(0, 200));

  return r.result();
}
