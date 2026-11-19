import { client, createReporter, sleep, waitForDeploy, SETUP_TOKEN } from "../harness.mjs";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Previews of pull requests through the real webhook route: opened,
 * synchronize, closed, a fork that waits for approval, the ceiling, the
 * actions, turning previews off — and production never modified.
 *
 * Deploys are real and fail fast, as in `deploy-commit`: the repository does
 * not exist, so each records the commit it was asked for and stops at the
 * clone. Previews are turned on in the store rather than through the
 * settings, which would register a webhook on GitHub; the settings' refusal
 * without a token is checked on its own.
 *
 * Not exercised without Docker, nginx and GitHub: a preview container
 * answering, its address served (`pr-<n>.<domain>` or sslip.io), the hook
 * GitHub would call, the poller's pull request list and the commit status.
 */
export const meta = { name: "previews", needsDocker: false, drivers: ["sqlite", "postgres"] };

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const REPO = "https://github.com/runpanel-test/does-not-exist";
const SHA = (c) => c.repeat(40);

async function storeHandle(dataDir) {
  const require = createRequire(import.meta.url);
  const file = join(dataDir, "runpanel.db");
  if (existsSync(file)) {
    const db = new (require("better-sqlite3"))(file);
    return { run: async (sql, params = []) => db.prepare(sql).run(...params), close: async () => db.close() };
  }
  const url = process.env.RUNPANEL_TEST_PG_URL;
  if (!url) return null;
  const { Client } = require("pg");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  return {
    run: async (sql, params = []) => {
      let n = 0;
      return pg.query(sql.replace(/\?/g, () => `$${++n}`), params);
    },
    close: async () => pg.end(),
  };
}

function pullRequest(number, { sha, action = "opened", base = "main", fork = false, state = "open", title = `Change ${number}` }) {
  return {
    action,
    number,
    pull_request: {
      number,
      state,
      title,
      html_url: `https://github.com/runpanel-test/does-not-exist/pull/${number}`,
      user: { login: fork ? "mallory" : "ada" },
      merged: false,
      head: { sha, ref: `feature/${number}`, repo: { full_name: fork ? "mallory/does-not-exist" : "runpanel-test/does-not-exist" } },
      base: { ref: base, repo: { full_name: "runpanel-test/does-not-exist" } },
    },
  };
}

function facts(row) {
  return JSON.stringify({ branch: row.source_branch, pinned: row.pinned_sha, port: row.port, config: row.builder_config, deploys: row.deploy_count, status: row.status });
}

export async function run({ base, dataDir }) {
  const r = createReporter("previews");
  const owner = client(base);
  await owner.call("/api/auth/login", json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "previews-suite-pw" }));
  const store = await storeHandle(dataDir);
  if (!store) {
    r.check("the store can be reached to turn previews on", false, "no handle on the store");
    return r.result();
  }

  let res = await owner.call("/api/projects", json("POST", { name: "Shop" }));
  const prod = res.body;
  await owner.call(`/api/projects/${prod.id}`, json("PATCH", { sourceType: "github", sourceUrl: REPO, sourceBranch: "main", runtimeType: "docker", port: 3000 }));
  await owner.call(`/api/projects/${prod.id}/env`, json("PUT", { vars: [{ key: "API_URL", value: "https://api.prod" }, { key: "BANNER", value: "produzione" }] }));

  // --- the settings -------------------------------------------------------------------
  res = await owner.call(`/api/projects/${prod.id}/previews`);
  r.check("previews start off", res.status === 200 && res.body?.settings?.enabled === false && res.body?.previews?.length === 0, JSON.stringify(res.body));
  r.check("and say why events could not arrive yet", typeof res.body?.transport?.problem === "string", JSON.stringify(res.body?.transport));
  res = await owner.call(`/api/projects/${prod.id}/previews`, json("PUT", { enabled: true, maxPreviews: 2, idleDays: 7, domainId: null, commitStatus: false }));
  r.check("they are not turned on without GitHub connected", res.status === 409 && /Collega GitHub/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${prod.id}/previews`, json("PUT", { enabled: true, maxPreviews: 11, idleDays: 7, domainId: null, commitStatus: false }));
  r.check("a ceiling over ten is refused", res.status === 400, String(res.status));

  res = await owner.call(`/api/projects/${prod.id}/previews/env`, json("PUT", { vars: [{ key: "BANNER", value: "anteprima" }, { key: "PAYMENTS", value: "test" }] }));
  r.check("the previews' variables are saved", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${prod.id}/previews/env`);
  r.check("and read back masked", res.body?.vars?.length === 2 && res.body.vars.every((v) => v.value === "••••••••"), JSON.stringify(res.body));

  await store.run("UPDATE projects SET preview_settings = ? WHERE id = ?", [
    JSON.stringify({ enabled: true, maxPreviews: 2, idleDays: 7, domainId: null, commitStatus: false }),
    prod.id,
  ]);

  const prodBefore = (await owner.call(`/api/projects/${prod.id}`)).body;
  const prodEnvBefore = JSON.stringify((await owner.call(`/api/projects/${prod.id}/env`)).body);
  const secret = prodBefore.webhook_secret;
  const deliver = (payload, event = "pull_request") => {
    const body = JSON.stringify(payload);
    return owner.call(`/api/webhooks/github/${prod.id}`, {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") },
      body,
    });
  };
  const previews = async () => (await owner.call(`/api/projects/${prod.id}/previews`)).body?.previews ?? [];
  const preview = async (n) => (await previews()).find((p) => p.prNumber === n);

  // --- opened ---------------------------------------------------------------------------
  res = await deliver(pullRequest(7, { sha: SHA("1") }));
  r.check("an opened pull request creates its preview", res.status === 200 && res.body?.message === "Preview created", `${res.status} ${JSON.stringify(res.body)}`);
  let p7 = await preview(7);
  r.check("listed with number, title, author and commit", p7?.title === "Change 7" && p7?.author === "ada" && p7?.headSha === SHA("1") && p7?.fork === false, JSON.stringify(p7));
  const p7Id = p7?.project?.id;
  let row7 = (await owner.call(`/api/projects/${p7Id}`)).body;
  r.check("as an environment of production, held at the head commit", row7?.environment_of === prod.id && row7?.environment === "preview" && row7?.pinned_sha === SHA("1"), JSON.stringify(row7).slice(0, 300));
  r.check("with its own slug and port", row7?.slug === "shop-pr-7" && row7?.port !== 3000, `${row7?.slug} :${row7?.port}`);
  r.check("without an address here, saying why", typeof p7?.addressProblem === "string" && p7.addressProblem.length > 0, JSON.stringify(p7));
  await waitForDeploy(owner, p7Id, 120_000);
  let history = (await owner.call(`/api/projects/${p7Id}/logs`)).body;
  r.check("its deploy ran with the pull request's commit", Array.isArray(history) && history[0]?.commit_sha === SHA("1") && history[0]?.trigger_type === "webhook", JSON.stringify(history));

  res = await owner.call(`/api/projects/${p7Id}/env/effective?reveal=true`);
  const eff = (key) => res.body?.vars?.find((v) => v.key === key);
  r.check("the previews' variables win over production's", eff("BANNER")?.value === "anteprima" && eff("BANNER")?.source?.environment === "previews", JSON.stringify(eff("BANNER")));
  r.check("and production's come along under them", eff("API_URL")?.value === "https://api.prod" && eff("API_URL")?.source?.environment === "production", JSON.stringify(eff("API_URL")));

  res = await deliver(pullRequest(7, { sha: SHA("1") }));
  r.check("the same delivery again deploys nothing", /already deployed/.test(res.body?.message ?? ""), JSON.stringify(res.body));

  // --- synchronize ---------------------------------------------------------------------
  res = await deliver(pullRequest(7, { sha: SHA("2"), action: "synchronize" }));
  r.check("a push to the pull request redeploys its preview", res.body?.message === "Preview redeployed", JSON.stringify(res.body));
  row7 = (await owner.call(`/api/projects/${p7Id}`)).body;
  r.check("at the new head", row7?.pinned_sha === SHA("2"), String(row7?.pinned_sha));
  await waitForDeploy(owner, p7Id, 120_000);
  history = (await owner.call(`/api/projects/${p7Id}/logs`)).body;
  r.check("with a deploy of it", history?.[0]?.commit_sha === SHA("2"), JSON.stringify(history?.map?.((d) => d.commit_sha)));

  res = await deliver(pullRequest(10, { sha: SHA("3"), base: "develop" }));
  r.check("a pull request against another branch is not production's", /base develop/.test(res.body?.message ?? "") && !(await preview(10)), JSON.stringify(res.body));
  res = await deliver(pullRequest(7, { sha: SHA("2"), action: "labeled" }));
  r.check("a label changes nothing", /not handled/.test(res.body?.message ?? ""), JSON.stringify(res.body));

  // --- a fork ------------------------------------------------------------------------------
  const projectsBefore = (await owner.call("/api/projects")).body.length;
  res = await deliver(pullRequest(8, { sha: SHA("4"), fork: true }));
  r.check("a fork's pull request waits for approval", /waiting for approval/.test(res.body?.message ?? ""), JSON.stringify(res.body));
  let p8 = await preview(8);
  r.check("listed as needing it, with no preview made", p8?.needsApproval === true && p8?.fork === true && p8?.project === null && p8?.state === "waiting", JSON.stringify(p8));
  r.check("and nothing deployed", (await owner.call("/api/projects")).body.length === projectsBefore);
  res = await owner.call(`/api/projects/${prod.id}/previews/${p8.id}`, json("POST", { action: "redeploy" }));
  r.check("a redeploy cannot get past the gate", res.status === 409, `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${prod.id}/previews/${p8.id}`, json("POST", { action: "approve", commitSha: SHA("5") }));
  r.check("approving a commit that is not the head is refused", res.status === 409, `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${prod.id}/previews/${p8.id}`, json("POST", { action: "approve", commitSha: SHA("4") }));
  r.check("approving the head deploys it", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  p8 = await preview(8);
  r.check("as a preview held at the approved commit", p8?.project?.pinnedSha === SHA("4") && p8?.needsApproval === false, JSON.stringify(p8));
  res = await deliver(pullRequest(8, { sha: SHA("6"), action: "synchronize", fork: true }));
  p8 = await preview(8);
  r.check("a new push to the fork waits again", /waiting for approval/.test(res.body?.message ?? "") && p8?.needsApproval === true && p8?.project?.pinnedSha === SHA("4"), JSON.stringify(p8));
  const approved = (await owner.call(`/api/audit?action=project.preview.approve&scope=project&scopeId=${prod.id}`)).body;
  r.check("the approval is in the activity log", approved?.entries?.length === 1 && /4444444/.test(approved.entries[0].detail ?? ""), JSON.stringify(approved));

  // --- the ceiling -----------------------------------------------------------------------------
  await waitForDeploy(owner, p8.project.id, 120_000);
  await store.run("UPDATE projects SET status = 'running' WHERE id = ? OR id = ?", [p7Id, p8.project.id]);
  await sleep(50);
  res = await deliver(pullRequest(9, { sha: SHA("7") }));
  r.check("a third preview past a ceiling of two is created", res.body?.message === "Preview created" && JSON.stringify(res.body?.message), JSON.stringify(res.body));
  p7 = await preview(7);
  p8 = await preview(8);
  r.check("by stopping the one idle the longest", p7?.state === "stopped" && p7?.stoppedReason === "limit" && p8?.state === "active", JSON.stringify([p7?.state, p7?.stoppedReason, p8?.state]));
  r.check("whose app is stopped", (await owner.call(`/api/projects/${p7Id}`)).body?.status === "stopped");
  let p9 = await preview(9);
  await waitForDeploy(owner, p9.project.id, 120_000);

  // --- actions ------------------------------------------------------------------------------------
  res = await owner.call(`/api/projects/${prod.id}/previews/${p9.id}`, json("POST", { action: "stop" }));
  p9 = await preview(9);
  r.check("a preview can be stopped by hand", res.status === 200 && p9?.state === "stopped" && p9?.stoppedReason === "manual", `${res.status} ${JSON.stringify(p9)}`);
  res = await owner.call(`/api/projects/${prod.id}/previews/${p9.id}`, { method: "DELETE" });
  r.check("and deleted, project and all", res.status === 200 && !(await preview(9)) && (await owner.call(`/api/projects/${p9.project.id}`)).status === 404, `${res.status} ${JSON.stringify(res.body)}`);

  // --- closed ----------------------------------------------------------------------------------------
  res = await deliver(pullRequest(7, { sha: SHA("2"), action: "closed", state: "closed" }));
  r.check("a closed pull request removes its preview", res.body?.message === "Preview removed", JSON.stringify(res.body));
  r.check("its project goes with it", (await owner.call(`/api/projects/${p7Id}`)).status === 404 && !(await preview(7)));
  r.check("and so does it from the family", !(await owner.call(`/api/projects/${prod.id}/environments`)).body?.family?.previews?.some((m) => m.id === p7Id));

  // --- production, through all of it ---------------------------------------------------------------------
  const prodAfter = (await owner.call(`/api/projects/${prod.id}`)).body;
  r.check("production was never modified", facts(prodAfter) === facts(prodBefore), `${facts(prodBefore)} -> ${facts(prodAfter)}`);
  r.check("nor its variables", JSON.stringify((await owner.call(`/api/projects/${prod.id}/env`)).body) === prodEnvBefore);
  r.check("nor deployed", ((await owner.call(`/api/projects/${prod.id}/logs`)).body ?? []).length === 0);

  // --- deleting production, then turning previews off ---------------------------------------------------
  res = await owner.call(`/api/projects/${prod.id}`, { method: "DELETE" });
  r.check("production does not go while it has previews", res.status === 409 && res.body?.code === "has_environments", `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(`/api/projects/${prod.id}/previews`, json("PUT", { enabled: false, maxPreviews: 2, idleDays: 7, domainId: null, commitStatus: false }));
  r.check("turning previews off removes the ones left", res.status === 200 && res.body?.removed === 1 && res.body?.previews?.length === 0, `${res.status} ${JSON.stringify(res.body)}`);
  r.check("with their projects", (await owner.call(`/api/projects/${p8.project.id}`)).status === 404);
  res = await deliver(pullRequest(12, { sha: SHA("8") }));
  r.check("and a pull request makes none any more", /previews are off/.test(res.body?.message ?? "") && !(await preview(12)), JSON.stringify(res.body));
  res = await deliver({ ref: "refs/heads/main", head_commit: { id: SHA("9"), message: "x" } }, "push");
  r.check("pushes to production are still auto-deploy's business", /Auto-deploy disabled/.test(res.body?.message ?? ""), JSON.stringify(res.body));

  res = await owner.call(`/api/projects/${prod.id}`, { method: "DELETE" });
  r.check("without previews, production goes as always", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  await store.close();
  return r.result();
}
