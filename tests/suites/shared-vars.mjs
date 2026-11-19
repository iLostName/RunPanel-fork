import { client, createReporter, SETUP_TOKEN, waitForDeploy } from "../harness.mjs";
import { createCipheriv, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared variables and references, over HTTP: groups, attaching them, who may
 * do which, a deploy that stops on a reference, and the env file a deploy
 * writes.
 *
 * `env-refs-unit` holds the rules as data. This holds the routes to them, and
 * the one promise that matters most end to end: a reference that does not
 * resolve stops the deploy — and the restart — before anything is touched,
 * with a sentence that names the variable, and never reaches the app as an
 * empty value.
 *
 * No Docker and no PM2: the projects that deploy are native ones whose build
 * fails on purpose, right after the env file is written. A database is a row
 * written into the store (SQLite only), since a real one needs Docker.
 */
export const meta = { name: "shared-vars", needsDocker: false, drivers: ["sqlite", "postgres"] };

const json = (method, body) => ({ method, body: JSON.stringify(body) });
const MARKER = "# Written by RunPanel: project variables in clear. Not part of the repository.";

/** The panel's own sealing, for a row written straight into the store. */
function seal(secretHex, text) {
  const key = Buffer.from(secretHex, "hex").subarray(0, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

async function lastDeployment(api, projectId) {
  const history = await api.call(`/api/projects/${projectId}/logs`);
  const newest = (history.body ?? [])[0];
  if (!newest) return { row: null, log: "" };
  const full = await api.call(`/api/deployments/${newest.id}?tail=400`);
  return { row: newest, log: String(full.body?.build_log ?? "") };
}

async function invite(owner, base, email, password) {
  const res = await owner.call("/api/users", json("POST", { email, hours: 1 }));
  const id = res.body?.user?.id;
  const token = res.body?.invitePath?.split("/").pop();
  const account = client(base);
  await account.call("/api/auth/invite", json("POST", { token, password }));
  await account.call("/api/auth/login", json("POST", { email, password }));
  return { id, account };
}

export async function run({ base, dataDir }) {
  const r = createReporter("shared-vars");
  const owner = client(base);
  await owner.call("/api/auth/login", json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "shared-vars-pw" }));

  // --- groups ---------------------------------------------------------------
  let res = await owner.call("/api/env-groups", json("POST", { name: "Smtp Live" }));
  r.check("a name a reference cannot spell is refused", res.status === 400, `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(
    "/api/env-groups",
    json("POST", {
      name: "smtp",
      description: "Posta",
      vars: [
        { key: "HOST", value: "mail.example.com" },
        { key: "SMTP_PORT", value: "587" },
        { key: "URL", value: "smtp://${{ shared.smtp.HOST }}:${{ shared.smtp.SMTP_PORT }}" },
        { key: "PICK_ME", value: "x" },
        { key: "REGION", value: "eu" },
      ],
    })
  );
  r.check("a group is created with its variables", res.status === 201 && res.body?.count === 5, `${res.status} ${JSON.stringify(res.body)}`);
  const smtpId = res.body?.id;

  res = await owner.call("/api/env-groups", json("POST", { name: "smtp" }));
  r.check("a second group with the same name is refused", res.status === 409, String(res.status));

  res = await owner.call("/api/env-groups", json("POST", { name: "live", vars: [{ key: "HOST", value: "live.example.com" }, { key: "ONLY_LIVE", value: "1" }, { key: "REGION", value: "us" }] }));
  const liveId = res.body?.id;
  r.check("a second group is created", res.status === 201 && Boolean(liveId), JSON.stringify(res.body));

  res = await owner.call("/api/env-groups");
  const listed = Array.isArray(res.body) ? res.body.find((g) => g.id === smtpId) : null;
  r.check("the list names the variables, not their values", listed?.keys?.includes("SMTP_PORT") && !JSON.stringify(res.body).includes("mail.example.com"), JSON.stringify(res.body));

  res = await owner.call(`/api/env-groups/${smtpId}`);
  r.check("a group's values are masked by default", res.body?.vars?.every((v) => v.value === "••••••••"), JSON.stringify(res.body?.vars));
  res = await owner.call(`/api/env-groups/${smtpId}?reveal=true`);
  r.check("and open on request", res.body?.vars?.find((v) => v.key === "HOST")?.value === "mail.example.com");

  // The pages render; what they show is their API's, asserted here.
  res = await owner.call("/shared-variables");
  r.check("the page of shared variables opens", res.status === 200 && String(res.body).includes("<html"), String(res.status));
  res = await owner.call(`/shared-variables/${smtpId}`);
  r.check("and so does a group's", res.status === 200, String(res.status));

  res = await owner.call("/api/env-groups", json("POST", { name: "loop", vars: [{ key: "A", value: "${{ shared.loop.B }}" }, { key: "B", value: "x${{ shared.loop.A }}" }] }));
  r.check("a group that loops on itself is refused", res.status === 400 && /circolare/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(`/api/env-groups/${liveId}/vars`, json("PUT", { vars: [{ key: "HOST", value: "live.example.com" }, { key: "X", value: "${{ shared.nope.Y }}" }] }));
  r.check("a reference to a group that does not exist is refused on its row", res.status === 400 && res.body?.details?.[0]?.path?.join(".") === "vars.1.value" && /«nope»/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);

  // --- a native project: precedence, references, the env file ---------------
  res = await owner.call("/api/projects", json("POST", { name: "Mailer" }));
  const mailer = res.body;
  const repo = join(dataDir, "repos", mailer.slug);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "server.js"), "console.log('never started')\n");
  // The build writes what it saw and fails: the env file is written before it, and nothing after it runs.
  const build = `node -e "require('fs').writeFileSync('seen.txt', String(process.env.MAIL_URL));process.exit(3)"`;
  res = await owner.call(
    `/api/projects/${mailer.id}`,
    json("PATCH", {
      runtimeType: "custom",
      sourceType: "upload",
      builderConfig: { version: 1, commands: { install: "", build, start: "node server.js" }, envFile: { enabled: true, path: ".env" } },
    })
  );
  r.check("a native project is set up", res.status === 200, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);

  res = await owner.call(`/api/projects/${mailer.id}/env-groups`, json("PUT", { groupIds: [smtpId, liveId] }));
  r.check("two groups are attached, in order", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  const mailerVars = [
    { key: "HOST", value: "own.example.com" },
    { key: "MAIL_URL", value: "${{ shared.smtp.URL }}" },
    { key: "LITERAL", value: "$${{ not.a.ref }}" },
    { key: "PICK", value: "${{ shared.smtp.PICK_ME }}" },
  ];
  res = await owner.call(`/api/projects/${mailer.id}/env`, json("PUT", { vars: mailerVars }));
  r.check("variables with references are saved", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(`/api/projects/${mailer.id}/env`, json("PUT", { vars: [...mailerVars, { key: "BROKEN", value: "${{ shared.nope.X }}" }] }));
  r.check(
    "a new reference that does not resolve is refused, naming the variable",
    res.status === 400 && /La variabile BROKEN usa \$\{\{ shared\.nope\.X \}\}/.test(res.body?.error ?? "") && res.body?.details?.[0]?.path?.join(".") === "vars.4.value",
    `${res.status} ${JSON.stringify(res.body)}`
  );
  res = await owner.call(`/api/projects/${mailer.id}/env`, json("PUT", { vars: [...mailerVars, { key: "WRONG", value: "${{ shared.smtp" }] }));
  r.check("so is one written wrong", res.status === 400 && /scritto male/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(`/api/projects/${mailer.id}/env/effective?reveal=true`);
  const eff = (key) => res.body?.vars?.find((v) => v.key === key);
  r.check("the project's own value wins over both groups", eff("HOST")?.source?.kind === "own" && eff("HOST")?.value === "own.example.com", JSON.stringify(eff("HOST")));
  r.check("and the groups it replaces are listed, the closest first", eff("HOST")?.overridden?.map((s) => s.name).join() === "live,smtp", JSON.stringify(eff("HOST")?.overridden));
  r.check("a later group wins over an earlier one, shown as a conflict", eff("REGION")?.source?.name === "live" && eff("REGION")?.value === "us" && eff("REGION")?.conflict?.[0] === "smtp", JSON.stringify(eff("REGION")));
  r.check("a reference reads the group's own value", eff("MAIL_URL")?.value === "smtp://mail.example.com:587" && eff("MAIL_URL")?.refs?.length === 3, JSON.stringify(eff("MAIL_URL")));
  r.check("an escaped reference stays text", eff("LITERAL")?.value === "${{ not.a.ref }}", JSON.stringify(eff("LITERAL")));
  r.check("the panel's own are listed as such", eff("PORT")?.source?.kind === "panel" && eff("NODE_ENV")?.source?.kind === "panel");
  r.check("nothing to fix", res.body?.problems === 0, JSON.stringify(res.body?.problems));

  res = await owner.call(`/api/projects/${mailer.id}/deploy`, json("POST", {}));
  r.check("the deploy starts", res.status === 202, `${res.status} ${JSON.stringify(res.body)}`);
  await waitForDeploy(owner, mailer.id, 120_000);
  const envFile = join(repo, ".env");
  const written = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  r.check("the env file is written, marked as the panel's", written.startsWith(MARKER), written.slice(0, 120));
  for (const line of ["HOST=own.example.com", "MAIL_URL=smtp://mail.example.com:587", 'LITERAL="${{ not.a.ref }}"', "ONLY_LIVE=1", "REGION=us", "SMTP_PORT=587", "PICK=x"]) {
    r.check(`the env file has ${line}`, written.split(/\r?\n/).includes(line), written);
  }
  r.check("no reference reaches the file unexpanded", !/\$\{\{ shared\./.test(written));
  const seen = join(repo, "seen.txt");
  r.check("the build was handed the resolved value", existsSync(seen) && readFileSync(seen, "utf8") === "smtp://mail.example.com:587", existsSync(seen) ? readFileSync(seen, "utf8") : "no file");

  // --- a reference that stops resolving stops the deploy, before anything ---
  res = await owner.call(`/api/env-groups/${smtpId}/vars`, json("PUT", { vars: [{ key: "HOST", value: "mail.example.com" }, { key: "SMTP_PORT", value: "587" }, { key: "URL", value: "smtp://${{ shared.smtp.HOST }}:${{ shared.smtp.SMTP_PORT }}" }, { key: "REGION", value: "eu" }] }));
  r.check("a name a project still reads cannot be removed", res.status === 409 && res.body?.code === "var_referenced" && /PICK_ME/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(`/api/env-groups/${smtpId}/vars`, json("PUT", { vars: [{ key: "HOST", value: "mail.example.com" }, { key: "SMTP_PORT", value: "587" }, { key: "URL", value: "smtp://${{ shared.smtp.HOST }}:${{ shared.smtp.SMTP_PORT }}" }, { key: "PICK_ME", value: "" }, { key: "REGION", value: "eu" }] }));
  r.check("emptying it is allowed, and says how many projects it reaches", res.status === 200 && res.body?.affected >= 1, `${res.status} ${JSON.stringify(res.body)}`);

  rmSync(seen, { force: true });
  res = await owner.call(`/api/projects/${mailer.id}/deploy`, json("POST", {}));
  await waitForDeploy(owner, mailer.id, 120_000);
  const failed = await lastDeployment(owner, mailer.id);
  r.check("the deploy fails", failed.row?.status === "failed", JSON.stringify(failed.row));
  r.check(
    "with a sentence that names the variable and why",
    /^Variabile non risolta — La variabile PICK usa \$\{\{ shared\.smtp\.PICK_ME \}\}, ma PICK_ME del gruppo «smtp» è vuota\./.test(failed.row?.error_message ?? ""),
    failed.row?.error_message
  );
  r.check("before anything ran: no build, no one-time phase", !failed.log.includes("--- Building ---") && !existsSync(seen), failed.log.slice(-600));
  r.check("and the env file was not rewritten", readFileSync(envFile, "utf8").split(/\r?\n/).includes("PICK=x"));

  res = await owner.call(`/api/projects/${mailer.id}/env/effective`);
  r.check("the Variables tab reports it", res.body?.problems === 1 && /vuota/.test(res.body?.vars?.find((v) => v.key === "PICK")?.problem ?? ""), JSON.stringify(res.body?.vars?.find((v) => v.key === "PICK")));

  // The restart reads the variables before it stops or starts anything too.
  const dbFile = join(dataDir, "runpanel.db");
  const sqlite = existsSync(dbFile) ? new (createRequire(import.meta.url)("better-sqlite3"))(dbFile) : null;
  if (sqlite) {
    try {
      sqlite
        .prepare("INSERT INTO deployments (id, project_id, trigger_type, status, started_at, start_cmd, artifact_dir) VALUES (?, ?, 'manual', 'running', ?, 'node server.js', ?)")
        .run("fake-good-deploy", mailer.id, new Date(Date.now() - 60_000).toISOString(), repo);
    } catch (err) {
      r.check("a deployment row can be written for the restart", false, String(err));
    }
    res = await owner.call(`/api/projects/${mailer.id}/control`, json("POST", { action: "restart" }));
    r.check("the restart refuses too, with the same sentence", res.status === 400 && /^Variabile non risolta — La variabile PICK/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);
  }

  res = await owner.call(`/api/env-groups/${smtpId}/vars`, json("PUT", { vars: [{ key: "HOST", value: "mail.example.com" }, { key: "SMTP_PORT", value: "587" }, { key: "URL", value: "smtp://${{ shared.smtp.HOST }}:${{ shared.smtp.SMTP_PORT }}" }, { key: "PICK_ME", value: "y" }, { key: "REGION", value: "eu" }] }));
  res = await owner.call(`/api/projects/${mailer.id}/env/effective`);
  r.check("filled again, it resolves", res.body?.problems === 0, JSON.stringify(res.body?.problems));

  // --- permissions ----------------------------------------------------------
  res = await owner.call("/api/projects", json("POST", { name: "Plain Box" }));
  const box = res.body;
  await owner.call(`/api/projects/${box.id}`, json("PATCH", { runtimeType: "docker" }));
  await owner.call(`/api/projects/${box.id}/env-groups`, json("PUT", { groupIds: [smtpId] }));
  res = await owner.call(`/api/projects/${box.id}/env`, json("PUT", { vars: [{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }] }));
  r.check("the owner writes a reference into a plain container", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  const dev = await invite(owner, base, "dev@runpanel.test", "dev-password-1");
  await owner.call(`/api/users/${dev.id}`, json("PATCH", { access: { permissions: [], grants: [{ scope: "project", scopeId: box.id, level: "manage", terminal: false }] } }));

  res = await dev.account.call("/api/env-groups");
  r.check("without the permission the groups are not listed", res.status === 403, String(res.status));
  res = await dev.account.call(`/api/env-groups/${smtpId}?reveal=true`);
  r.check("nor opened", res.status === 403, String(res.status));
  res = await dev.account.call(`/api/projects/${box.id}/env-groups`);
  r.check("a project's own groups are named to who may read the project", res.status === 200 && res.body?.[0]?.name === "smtp" && !JSON.stringify(res.body).includes("mail.example.com"), JSON.stringify(res.body));

  res = await dev.account.call(`/api/projects/${box.id}/env-groups`, json("PUT", { groupIds: [smtpId, liveId] }));
  r.check("attaching a group needs the permission", res.status === 403 && res.body?.code === "variables_required", `${res.status} ${JSON.stringify(res.body)}`);

  res = await dev.account.call(`/api/projects/${box.id}/env`, json("PUT", { vars: [{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }, { key: "STEAL", value: "${{ shared.live.HOST }}" }] }));
  r.check("so does a reference to a group, refused on its row", res.status === 403 && /Variabili condivise/.test(res.body?.details?.[0]?.message ?? "") && res.body?.details?.[0]?.path?.join(".") === "vars.1.value", `${res.status} ${JSON.stringify(res.body)}`);

  res = await dev.account.call(`/api/projects/${box.id}/env`, json("PUT", { vars: [{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }, { key: "MINE", value: "plain" }] }));
  r.check("a reference somebody else wrote can be kept as it is", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);

  res = await dev.account.call(`/api/projects/${box.id}/env/effective?reveal=true`);
  const devEff = (key) => res.body?.vars?.find((v) => v.key === key);
  r.check("its own literal value can be shown", devEff("MINE")?.revealable === true && devEff("MINE")?.value === "plain", JSON.stringify(devEff("MINE")));
  r.check("one built from a group cannot", devEff("MAIL")?.revealable === false && devEff("MAIL")?.value === "••••••••", JSON.stringify(devEff("MAIL")));
  r.check("nor a group's own", devEff("SMTP_PORT")?.revealable === false && devEff("SMTP_PORT")?.value === "••••••••", JSON.stringify(devEff("SMTP_PORT")));

  if (sqlite) {
    const secret = readFileSync(join(dataDir, ".secret"), "utf8").trim();
    try {
      sqlite
        .prepare(
          "INSERT INTO services (id, name, type, version, status, port, credentials, config, project_id, created_at, updated_at, container_name) VALUES (?, 'cache', 'redis', '7', 'running', 56379, ?, '{}', NULL, ?, ?, 'runpanel-svc-cache-suite')"
        )
        .run("svc-cache-suite", seal(secret, JSON.stringify({ password: "redis-secret" })), new Date().toISOString(), new Date().toISOString());
    } catch (err) {
      r.check("a database row can be written", false, String(err));
    }
    res = await dev.account.call(`/api/projects/${box.id}/env`, json("PUT", { vars: [{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }, { key: "MINE", value: "plain" }, { key: "PW", value: "${{ db.cache.password }}" }] }));
    r.check(
      "a database it may not see is a reference to nothing, in the words of a missing one",
      res.status === 400 && /non porta a niente/.test(res.body?.details?.[0]?.message ?? "") && res.body?.details?.[0]?.path?.join(".") === "vars.2.value",
      `${res.status} ${JSON.stringify(res.body)}`
    );

    res = await owner.call(`/api/projects/${box.id}/env`, json("PUT", { vars: [{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }, { key: "MINE", value: "plain" }, { key: "REDIS", value: "${{ db.cache.url }}" }] }));
    r.check("the owner references a database with no project", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
    res = await owner.call(`/api/projects/${box.id}/env/effective?reveal=true`);
    const redis = res.body?.vars?.find((v) => v.key === "REDIS");
    r.check("a container is handed the database by name, on its inner port", redis?.value === "redis://:redis-secret@runpanel-svc-cache-suite:6379/0", JSON.stringify(redis));

    // The URL the project already reads holds the password: naming it again hands over nothing new.
    res = await dev.account.call(`/api/projects/${box.id}/env`, json("PUT", { vars: [{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }, { key: "MINE", value: "plain" }, { key: "REDIS", value: "${{ db.cache.url }}" }, { key: "PW", value: "${{ db.cache.password }}" }] }));
    r.check("another field of a database the project already reads is allowed", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  }

  res = await dev.account.call(`/api/projects/${box.id}/env-groups`, json("PUT", { groupIds: [] }));
  r.check("taking a group off needs only the project", res.status === 200, `${res.status} ${JSON.stringify(res.body)}`);
  await owner.call(`/api/projects/${box.id}/env-groups`, json("PUT", { groupIds: [smtpId] }));

  // The permission does not reach past the host rule: a native project's variables are code.
  const ops = await invite(owner, base, "ops@runpanel.test", "ops-password-1");
  await owner.call(`/api/users/${ops.id}`, json("PATCH", { access: { permissions: ["variables"], grants: [] } }));
  res = await ops.account.call(`/api/env-groups/${smtpId}/vars`, json("PUT", { vars: [{ key: "NODE_OPTIONS", value: "--require /tmp/x.js" }] }));
  r.check("changing a group that reaches a native project needs the host permission", res.status === 403 && res.body?.code === "host_required", `${res.status} ${JSON.stringify(res.body)}`);
  res = await ops.account.call("/api/env-groups", json("POST", { name: "solo", vars: [{ key: "A", value: "1" }] }));
  r.check("a group nothing uses is theirs to make", res.status === 201, `${res.status} ${JSON.stringify(res.body)}`);
  res = await ops.account.call(`/api/projects/${box.id}/env-groups`, json("PUT", { groupIds: [smtpId] }));
  r.check("but not to attach to a project they cannot manage", res.status === 404 || res.status === 403, String(res.status));

  // --- who uses a group, and taking it away ---------------------------------
  res = await owner.call(`/api/env-groups/${smtpId}`);
  r.check("a group says which projects receive it", res.body?.usage?.attached?.map((p) => p.id).sort().join() === [mailer.id, box.id].sort().join(), JSON.stringify(res.body?.usage));

  res = await owner.call(`/api/env-groups/${smtpId}`, { method: "DELETE" });
  r.check("a group a reference names cannot be deleted", res.status === 409 && res.body?.code === "group_referenced", `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/env-groups/${smtpId}`, json("PATCH", { name: "mail" }));
  r.check("nor renamed", res.status === 409 && /nei riferimenti del progetto «Mailer»/.test(res.body?.error ?? ""), `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/env-groups/${smtpId}`, json("PATCH", { description: "Posta in uscita" }));
  r.check("its description can change all the same", res.status === 200 && res.body?.description === "Posta in uscita", `${res.status} ${JSON.stringify(res.body)}`);

  res = await owner.call(`/api/env-groups/${liveId}`, { method: "DELETE" });
  r.check("one only attached is deleted, and detached", res.status === 200 && res.body?.detached === 1, `${res.status} ${JSON.stringify(res.body)}`);
  res = await owner.call(`/api/projects/${mailer.id}/env-groups`);
  r.check("the project no longer has it", Array.isArray(res.body) && res.body.length === 1 && res.body[0].id === smtpId, JSON.stringify(res.body));

  res = await owner.call(`/api/env-groups/${smtpId}/redeploy`, { method: "POST" });
  r.check(
    "redeploying skips what is stopped or never deployed, and says why",
    res.status === 200 && res.body?.started?.length === 0 && res.body?.skipped?.length === 2 && res.body.skipped.every((s) => typeof s.reason === "string"),
    `${res.status} ${JSON.stringify(res.body)}`
  );

  sqlite?.close();
  return r.result();
}
