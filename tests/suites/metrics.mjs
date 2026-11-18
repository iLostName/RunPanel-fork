import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * The metrics history and the uptime check over HTTP: who may read what, and
 * the shape a chart is handed.
 *
 * The guard is the part that needs a real server. The host's history is the
 * Monitor's, behind its permission; a project's is visible to whoever may see
 * the project, which is what lets a project page draw its charts for an account
 * that has no business on the Monitor — and must not let it read a project it
 * was never granted. The test servers run with the timers off, so the series
 * are empty: the arithmetic behind them is `metrics-unit` and `uptime-unit`.
 * Run on Postgres too when it is configured, for migrations 033 and 034.
 */
export const meta = { name: "metrics", needsDocker: false, drivers: ["sqlite", "postgres"] };

export async function run({ base }) {
  const r = createReporter("metrics");
  const owner = client(base);
  const json = (method, body) => ({ method, body: JSON.stringify(body) });

  let res = await owner.call(
    "/api/auth/login",
    json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "metrics-pw-1" })
  );
  r.check("setup", res.status === 200, JSON.stringify(res.body));

  res = await client(base).call("/api/metrics/history?scope=host");
  r.check("no session, no history", res.status === 401, String(res.status));

  // --- the host ------------------------------------------------------------------
  res = await owner.call("/api/metrics/history?scope=host&range=24h");
  r.check("the owner reads the host", res.status === 200, JSON.stringify(res.body).slice(0, 200));
  r.check(
    "in columns, with its range",
    res.body?.range === "24h" && Array.isArray(res.body?.t) && typeof res.body?.series === "object" && res.body.from < res.body.to,
    JSON.stringify(res.body).slice(0, 200)
  );
  r.check("with what the percentages are of", res.body?.context?.cores >= 1 && res.body?.context?.memTotal > 0);
  r.check("and says nothing is being collected here", res.body?.sampling?.collecting === false, JSON.stringify(res.body?.sampling));

  res = await owner.call("/api/metrics/history?scope=disk");
  r.check("an unknown scope is refused, in Italian", res.status === 400 && /scope/.test(res.body?.error ?? ""), JSON.stringify(res.body));
  res = await owner.call("/api/metrics/history?scope=host&range=2h");
  r.check("an unknown range is refused", res.status === 400, String(res.status));
  res = await owner.call("/api/metrics/history?scope=project");
  r.check("a project needs its id", res.status === 400, String(res.status));
  res = await owner.call("/api/metrics/history?scope=project&id=nope");
  r.check("an unknown project is not found", res.status === 404, String(res.status));

  // --- a project -----------------------------------------------------------------
  res = await owner.call("/api/projects", json("POST", { name: "Metrics Project" }));
  const projectId = res.body?.id;
  r.check("a project", res.status === 201 && Boolean(projectId), JSON.stringify(res.body));
  res = await owner.call("/api/projects", json("POST", { name: "Other Project" }));
  const otherId = res.body?.id;

  res = await owner.call(`/api/metrics/history?scope=project&id=${projectId}&range=7d`);
  r.check("its history, empty", res.status === 200 && res.body?.t?.length === 0, JSON.stringify(res.body).slice(0, 200));

  res = await owner.call(`/api/projects/${projectId}/uptime?tz=-60`);
  r.check("its uptime card", res.status === 200, JSON.stringify(res.body).slice(0, 200));
  r.check(
    "is not watched without a port, and says why",
    res.body?.watch?.active === false && res.body?.watch?.skip === "no-port",
    JSON.stringify(res.body?.watch)
  );
  r.check(
    "with nothing measured yet",
    res.body?.up24h === null && res.body?.days?.length === 30 && Array.isArray(res.body?.incidents) && res.body?.open === null,
    JSON.stringify(res.body).slice(0, 300)
  );

  // --- an account granted one project --------------------------------------------
  res = await owner.call("/api/users", json("POST", { email: "viewer@runpanel.test", hours: 1 }));
  const viewerId = res.body?.user?.id;
  const token = res.body?.invitePath?.split("/").pop();
  const viewer = client(base);
  res = await viewer.call("/api/auth/invite", json("POST", { token, password: "viewer-pw-1" }));
  r.check("a second account", res.status === 200, JSON.stringify(res.body));
  res = await owner.call(
    `/api/users/${viewerId}`,
    json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: projectId, level: "read", terminal: false }] } })
  );
  r.check("granted one project, read only", res.status === 200, JSON.stringify(res.body));

  res = await viewer.call("/api/metrics/history?scope=host");
  r.check("the host is the Monitor's", res.status === 403, String(res.status));
  res = await viewer.call(`/api/metrics/history?scope=project&id=${projectId}`);
  r.check("its project is readable", res.status === 200, String(res.status));
  res = await viewer.call(`/api/projects/${projectId}/uptime`);
  r.check("and so is its uptime", res.status === 200, String(res.status));
  res = await viewer.call(`/api/metrics/history?scope=project&id=${otherId}`);
  r.check("another project does not exist for it", res.status === 404, String(res.status));
  res = await viewer.call(`/api/projects/${otherId}/uptime`);
  r.check("nor its uptime", res.status === 404, String(res.status));

  // --- the Monitor's additions -----------------------------------------------------
  res = await owner.call("/api/monitor");
  r.check(
    "the Monitor lists the other containers and the cores",
    res.status === 200 && Array.isArray(res.body?.others) && res.body?.server?.cores >= 1,
    JSON.stringify(res.body).slice(0, 200)
  );

  return r.result();
}
