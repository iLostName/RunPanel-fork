import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";
import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An app's output outlives the run that printed it.
 *
 * PM2 empties its files at every start; the panel's copy must not. Driven
 * through the API with no PM2 at all: the suite writes the files PM2 would
 * write, where it would write them, and reads them back through the routes —
 * the same read a request makes when the background collector is off, as it is
 * under the test harness.
 */
export const meta = { name: "app-logs", needsDocker: false, drivers: ["sqlite"] };

export async function run({ base, dataDir }) {
  const r = createReporter("app-logs");
  const api = client(base);

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "app-logs-pw" }),
  });
  const created = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Log Suite" }) });
  const projectId = created.body.id;
  const slug = created.body.slug;
  await api.call(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ runtimeType: "node" }) });

  const pm2Dir = join(dataDir, "logs", "pm2");
  mkdirSync(pm2Dir, { recursive: true });
  const out = join(pm2Dir, `${slug}-out.log`);
  const err = join(pm2Dir, `${slug}-error.log`);
  writeFileSync(out, "server listening on 3000\nGET / 200\n");
  writeFileSync(err, "Error: database unreachable\n");

  const read = (query = "") => api.call(`/api/projects/${projectId}/logs/app${query}`);

  // --- first read ---------------------------------------------------------------
  let page = await read();
  r.check("the saved log answers", page.status === 200, JSON.stringify(page.body).slice(0, 300));
  const texts = () => (page.body.entries ?? []).map((e) => e.text);
  r.check("it holds what the app printed", texts().includes("server listening on 3000") && texts().includes("Error: database unreachable"));
  r.check("each line knows its stream", page.body.entries?.find((e) => e.text.startsWith("Error"))?.stream === "stderr");
  r.check("each line has a time", page.body.entries?.every((e) => typeof e.at === "string"));
  r.check("the store says how much it keeps", page.body.retention?.files > 0 && page.body.stored?.files === 1);

  // --- filters ------------------------------------------------------------------
  page = await read("?q=DATABASE");
  r.check("search ignores case", texts().length === 1 && texts()[0].includes("database"));
  page = await read("?stream=stdout");
  r.check("one stream only", texts().length === 2 && !texts().some((t) => t.startsWith("Error")));
  page = await read("?lines=1");
  r.check("the last lines only, and says there are more", texts().length === 1 && page.body.more === true);
  r.check("too many lines are refused", (await read("?lines=9999")).status === 400);

  // --- a restart empties the files; the saved log keeps the old run ---------------
  truncateSync(out, 0);
  truncateSync(err, 0);
  appendFileSync(out, "second run up\n");
  page = await read();
  r.check("the old run is still there", texts().includes("GET / 200"));
  r.check("the new run is there", texts().at(-1) === "second run up", texts().join(" | "));
  r.check("with a marker between the two", texts().some((t) => t.startsWith("[RunPanel]")));
  page = await read();
  r.check("reading twice stores nothing twice", texts().filter((t) => t === "second run up").length === 1);

  // --- download -----------------------------------------------------------------
  const res = await fetch(`${base}/api/projects/${projectId}/logs/app/download`, { headers: { cookie: api.cookie } });
  const body = await res.text();
  r.check("the download is a file", res.ok && (res.headers.get("content-disposition") ?? "").startsWith("attachment;"));
  r.check("named after the project", (res.headers.get("content-disposition") ?? "").includes(slug));
  r.check("with every run in it", body.includes("GET / 200") && body.includes("second run up"));
  r.check("with the stream on each line", /stderr {2}Error: database unreachable/.test(body));

  // --- who may read it ------------------------------------------------------------
  const anonymous = await fetch(`${base}/api/projects/${projectId}/logs/app`);
  r.check("nobody signed out reads it", anonymous.status === 401);

  // --- variables: a repeated name comes back on its row -----------------------------
  const twice = await api.call(`/api/projects/${projectId}/env`, {
    method: "PUT",
    body: JSON.stringify({ vars: [{ key: "A", value: "1" }, { key: "A", value: "2" }] }),
  });
  r.check("a repeated name is a 400, not a 500", twice.status === 400, String(twice.status));
  r.check("on the row that repeats it", twice.body.details?.[0]?.path?.join(".") === "vars.1.key");

  return r.result();
}
