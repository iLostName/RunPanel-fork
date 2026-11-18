import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { client, createReporter, SETUP_TOKEN, sleep } from "../harness.mjs";

/**
 * Scheduled tasks through the API, on a native project — nothing is deployed:
 * a native task runs in the project's folder, which the suite creates itself.
 *
 * What it pins is what the unit suite cannot: that a run really starts in the
 * background and ends recorded with its exit code and output, that a second
 * "Esegui ora" during a run is refused, that a stop and a time limit end the
 * command, and that a run that cannot start leaves a record. The scheduler's
 * timer is off in test servers (RUNPANEL_DISABLE_SCHEDULERS); every run here
 * is started by hand.
 */
export const meta = { name: "tasks", needsDocker: false, drivers: ["sqlite", "postgres"] };

const node = JSON.stringify(process.execPath);

export async function run({ base, dataDir }) {
  const r = createReporter("tasks");
  const api = client(base);

  const unauth = await fetch(`${base}/api/projects/whatever/tasks`);
  r.check("the tasks require auth", unauth.status === 401, String(unauth.status));

  await api.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "tasks-suite-pw" }),
  });

  const created = await api.call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Tasks Suite" }) });
  const projectId = created.body?.id;
  const slug = created.body?.slug;
  r.check("project created", created.status === 201 && Boolean(slug), JSON.stringify(created.body));

  const url = `/api/projects/${projectId}/tasks`;
  const post = (body) => api.call(url, { method: "POST", body: JSON.stringify(body) });

  let res = await api.call(url);
  r.check(
    "a new project has no tasks, and its owner may write and run them",
    res.status === 200 && res.body.tasks.length === 0 && res.body.canEdit === true && res.body.canRun === true && res.body.runsIn === "host",
    JSON.stringify(res.body)
  );

  // --- what is refused -----------------------------------------------------------
  for (const [what, body, message] of [
    ["a task without a name", { name: " ", command: "true", cron: "" }, "Dai un nome all'attività"],
    ["a task without a command", { name: "x", command: "  ", cron: "" }, "Scrivi il comando da eseguire"],
    ["a broken schedule", { name: "x", command: "true", cron: "61 * * * *" }, null],
    ["a limit under ten seconds", { name: "x", command: "true", cron: "", timeoutSec: 5 }, null],
    ["a Compose service on a native project", { name: "x", command: "true", cron: "", service: "web" }, null],
  ]) {
    const bad = await post(body);
    r.check(
      `${what} is refused${message ? ", in Italian" : ""}`,
      bad.status === 400 && (!message || bad.body.error === message),
      `${bad.status} ${JSON.stringify(bad.body).slice(0, 160)}`
    );
  }

  // --- saving ----------------------------------------------------------------------
  res = await post({ name: "Pulizia notturna", command: "echo notte", cron: "0 3 * * *" });
  const nightly = res.body.task;
  r.check(
    "a scheduled task is saved with its next run, not run",
    res.status === 201 && nightly.nextRunAt && Date.parse(nightly.nextRunAt) > Date.now() && nightly.lastRun === null,
    JSON.stringify(res.body)
  );
  r.check("its schedule reads in words", nightly.schedule === "ogni giorno alle 03:00", nightly.schedule);

  res = await api.call(`${url}/${nightly.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  r.check("switched off it has no next run", res.status === 200 && res.body.task.nextRunAt === null && res.body.task.enabled === false, JSON.stringify(res.body));
  res = await api.call(`${url}/${nightly.id}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  r.check("switched on again it has one", res.status === 200 && Boolean(res.body.task.nextRunAt), JSON.stringify(res.body));

  res = await post({ name: "Prova", command: `${node} -e "console.log('ciao'); process.exit(3)"`, cron: "" });
  const failing = res.body.task;
  r.check("a task only on request has no next run", res.status === 201 && failing.nextRunAt === null, JSON.stringify(res.body));

  // --- a run that cannot start leaves a record -----------------------------------
  res = await api.call(`${url}/${failing.id}/run`, { method: "POST" });
  r.check("with no project folder yet the run is refused", res.status === 409 && res.body.code === "no-directory", JSON.stringify(res.body));
  res = await api.call(`${url}/${failing.id}`);
  r.check(
    "and the refusal is in the history",
    res.body.runs?.length === 1 && res.body.runs[0].status === "skipped" && res.body.runs[0].trigger === "manual",
    JSON.stringify(res.body.runs)
  );

  mkdirSync(join(dataDir, "repos", slug), { recursive: true });

  // --- a run that fails ------------------------------------------------------------
  const settle = async (taskId, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const got = await api.call(`${url}/${taskId}`);
      const last = got.body.task?.lastRun;
      if (last && last.status !== "running" && last.status !== "skipped") return got.body;
      await sleep(500);
    }
    return null;
  };

  res = await api.call(`${url}/${failing.id}/run`, { method: "POST" });
  r.check("Esegui ora starts it in the background", res.status === 202 && Boolean(res.body.runId), JSON.stringify(res.body));
  let done = await settle(failing.id);
  r.check(
    "it ends recorded as failed, with its exit code",
    done?.task.lastRun.status === "failed" && done?.task.lastRun.exitCode === 3,
    JSON.stringify(done?.task.lastRun)
  );
  const detail = await api.call(`${url}/${failing.id}/runs/${done?.task.lastRun.id}`);
  r.check("its output is kept", detail.status === 200 && detail.body.run.output.includes("ciao"), JSON.stringify(detail.body).slice(0, 300));
  r.check("the failure starts a streak", done?.task.consecutiveFailures === 1, String(done?.task.consecutiveFailures));

  // --- never twice at once, and a stop that ends it ---------------------------------
  res = await post({ name: "Lunga", command: `${node} -e "setTimeout(() => {}, 30000)"`, cron: "" });
  const slow = res.body.task;
  res = await api.call(`${url}/${slow.id}/run`, { method: "POST" });
  r.check("a long task starts", res.status === 202, JSON.stringify(res.body));
  res = await api.call(`${url}/${slow.id}/run`, { method: "POST" });
  r.check("a second run while it goes is refused", res.status === 409 && res.body.code === "running", JSON.stringify(res.body));
  res = await api.call(`${url}/${slow.id}/run`, { method: "DELETE" });
  r.check("Ferma is accepted", res.status === 202, JSON.stringify(res.body));
  done = await settle(slow.id, 30_000);
  r.check("and the run ends as stopped", done?.task.lastRun.status === "cancelled", JSON.stringify(done?.task.lastRun));
  r.check("a stop is not a failure", done?.task.consecutiveFailures === 0, String(done?.task.consecutiveFailures));

  // --- the time limit -----------------------------------------------------------------
  res = await post({ name: "Troppo lunga", command: `${node} -e "setTimeout(() => {}, 60000)"`, cron: "", timeoutSec: 10 });
  const limited = res.body.task;
  await api.call(`${url}/${limited.id}/run`, { method: "POST" });
  done = await settle(limited.id, 45_000);
  r.check("past its limit a run is stopped and counts as failed", done?.task.lastRun.status === "timed_out" && done?.task.consecutiveFailures === 1, JSON.stringify(done?.task.lastRun));

  // --- deleting ---------------------------------------------------------------------------
  res = await api.call(`${url}/${nightly.id}`, { method: "DELETE" });
  r.check("a task is deleted", res.status === 200, JSON.stringify(res.body));
  res = await api.call(`${url}/${nightly.id}`);
  r.check("and is gone", res.status === 404, String(res.status));

  res = await api.call(`/api/projects/${projectId}`, { method: "DELETE" });
  r.check("the project goes with its tasks", res.status === 200, JSON.stringify(res.body).slice(0, 200));

  return r.result();
}
