import { createReporter, client, SETUP_TOKEN } from "../harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startWebdav } from "../webdav-fake.mjs";

/**
 * SFTP, WebDAV and rclone destinations through the panel's API.
 *
 * WebDAV end to end: a WebDAV server runs in this process, and the panel —
 * a real `next start` — checks it, writes a backup run's archive to it,
 * serves the download back from it, and deletes it with the run.
 *
 * SFTP and rclone as far as this machine allows: their validation (a host
 * that is an ssh option, a user name with a quote, a sealed key that was
 * tampered with, an rclone option that runs a program), that no secret ever
 * comes back out of the list or the edit form, that a host key is forgotten
 * when the server changes, that a pasted rclone configuration is the owner's
 * alone, and what "Verifica" says when ssh meets a closed port or rclone is
 * not installed.
 */
export const meta = { name: "backup-remotes", needsDocker: false, drivers: ["sqlite", "postgres"] };

const PASSWORD = "backup-remotes-password";
const TOKEN = JSON.stringify({ access_token: "ya29.accesso-di-prova-123456", token_type: "Bearer", refresh_token: "1//rinnovo-di-prova-654321", expiry: "2026-11-18T12:00:00Z" });

async function waitForRun(api, runId, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const { body } = await api.call(`/api/backups/runs/${runId}`);
    if (body?.status && body.status !== "running") return body;
    if (Date.now() > deadline) throw new Error(`Il backup ${runId} non è finito in tempo`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const json = (method, body) => ({ method, body: JSON.stringify(body) });

export async function run({ base, dataDir }) {
  const r = createReporter("backup-remotes");
  const api = client(base);
  const canDumpStore = fs.existsSync(path.join(dataDir, "runpanel.db"));

  const anonymous = await client(base).call("/api/backups/destinations/ssh-key", { method: "POST" });
  r.check("generating a key needs a session", anonymous.status === 401, String(anonymous.status));

  await api.call(
    "/api/auth/login",
    json("POST", { setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: PASSWORD, confirmPassword: PASSWORD })
  );

  const tools = await api.call("/api/backups/destinations/tools");
  r.check(
    "the tools are reported",
    tools.status === 200 && typeof tools.body?.ssh?.installed === "boolean" && typeof tools.body?.rclone?.minVersion === "string",
    JSON.stringify(tools.body)
  );

  // --- SFTP -------------------------------------------------------------------------
  const key = await api.call("/api/backups/destinations/ssh-key", { method: "POST" });
  r.check(
    "a key pair is generated, the private half sealed",
    key.status === 200 && /^ssh-ed25519 AAAA/.test(key.body?.publicKey ?? "") && /^SHA256:/.test(key.body?.fingerprint ?? "") && typeof key.body?.keyToken === "string",
    JSON.stringify(key.body).slice(0, 200)
  );
  r.check("and never shown in clear", !JSON.stringify(key.body).includes("PRIVATE KEY"));
  const sftpConfig = { host: "127.0.0.1", port: await freePort(), username: "backup", folder: "Backup/run panel", keyToken: key.body?.keyToken };
  const sftp = (config, name = `sftp-${crypto.randomBytes(3).toString("hex")}`) => api.call("/api/backups/destinations", json("POST", { name, type: "sftp", config }));

  for (const [label, config] of [
    ["a host that is an ssh option", { ...sftpConfig, host: "-oProxyCommand=touch /tmp/pwned" }],
    ["a user and host pasted together", { ...sftpConfig, host: "backup@nas.lan" }],
    ["a user name with a quote", { ...sftpConfig, username: "back'up" }],
    ["a port out of range", { ...sftpConfig, port: 70000 }],
    ["a folder that climbs out", { ...sftpConfig, folder: "../etc" }],
    ["no key", { ...sftpConfig, keyToken: undefined }],
    ["a tampered key", { ...sftpConfig, keyToken: `${sftpConfig.keyToken.slice(0, -6)}AAAAAA` }],
    ["an unknown field", { ...sftpConfig, privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }],
  ]) {
    const refused = await sftp(config);
    r.check(`SFTP refused: ${label}`, refused.status === 400, `${refused.status} ${JSON.stringify(refused.body).slice(0, 160)}`);
  }

  const created = await sftp(sftpConfig, "NAS di prova");
  r.check("an SFTP destination is created", created.status === 201, JSON.stringify(created.body));
  const sftpId = created.body?.id;
  {
    const list = await api.call("/api/backups/destinations");
    const row = list.body?.destinations?.find((entry) => entry.id === sftpId);
    r.check("the list says where it writes", row?.target?.host === "127.0.0.1" && row?.target?.folder === "Backup/run panel" && row?.target?.hostKeyFingerprint === null, JSON.stringify(row));
    r.check("never with which key, nor as whom", !JSON.stringify(list.body).includes("PRIVATE KEY") && !JSON.stringify(row).includes("backup\""), JSON.stringify(row));
    const detail = await api.call(`/api/backups/destinations/${sftpId}`);
    r.check("the edit form gets the public key and the user", detail.body?.config?.publicKey === key.body?.publicKey && detail.body?.config?.username === "backup" && detail.body?.config?.hasKey === true, JSON.stringify(detail.body));
    r.check("but not the private one", !JSON.stringify(detail.body).includes("PRIVATE KEY") && !JSON.stringify(detail.body).includes("keyToken"));

    const check = await api.call(`/api/backups/destinations/${sftpId}`, { method: "POST" });
    const expected = tools.body?.ssh?.installed ? "REFUSED" : "SSH_MISSING";
    r.check(`Verifica says what ssh met (${expected})`, check.body?.ok === false && check.body?.code === expected, JSON.stringify(check.body));

    const pin = key.body.publicKey.split(" ").slice(0, 2).join(" ");
    const pinned = await api.call(`/api/backups/destinations/${sftpId}`, json("PATCH", { config: { hostKey: pin } }));
    r.check("a host key learned by a check is kept", pinned.status === 200, JSON.stringify(pinned.body));
    const afterPin = await api.call(`/api/backups/destinations/${sftpId}`);
    r.check("and shown as a fingerprint", afterPin.body?.config?.hostKeyFingerprint === key.body.fingerprint, JSON.stringify(afterPin.body?.config));
    const badPin = await api.call(`/api/backups/destinations/${sftpId}`, json("PATCH", { config: { hostKey: "ssh-ed25519 !!!" } }));
    r.check("a host key that is not one is refused", badPin.status === 400, String(badPin.status));
    const moved = await api.call(`/api/backups/destinations/${sftpId}`, json("PATCH", { config: { host: "127.0.0.2" } }));
    r.check("moving to another server is accepted", moved.status === 200, JSON.stringify(moved.body));
    const afterMove = await api.call(`/api/backups/destinations/${sftpId}`);
    r.check("and forgets the host key of the old one", afterMove.body?.config?.hostKeyFingerprint === null && afterMove.body?.config?.hasKey === true, JSON.stringify(afterMove.body?.config));
    const s3Field = await api.call(`/api/backups/destinations/${sftpId}`, json("PATCH", { config: { endpoint: "https://s3.example.com" } }));
    r.check("another type's fields are refused", s3Field.status === 400, String(s3Field.status));
    const transient = await api.call("/api/backups/destinations/check", json("POST", { type: "sftp", config: { ...sftpConfig, keyToken: key.body.keyToken } }));
    r.check("a check before saving runs ssh too, and stores nothing", transient.body?.ok === false && typeof transient.body?.message === "string", JSON.stringify(transient.body));
  }

  // --- WebDAV, end to end ---------------------------------------------------------------
  const davRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rp-dav-suite-"));
  const dav = await startWebdav({ root: path.join(davRoot, "dav") });
  try {
    const davConfig = { url: dav.url, username: "utente", password: "password-per-app", folder: "RunPanel/notte" };
    const wrong = await api.call("/api/backups/destinations/check", json("POST", { type: "webdav", config: { ...davConfig, password: "sbagliata" } }));
    r.check("a wrong app password fails the check, with the hint", wrong.body?.ok === false && wrong.body?.code === "AUTH" && /password per app/.test(wrong.body?.message ?? ""), JSON.stringify(wrong.body));
    r.check("and the password is not repeated", !JSON.stringify(wrong.body).includes("sbagliata"));

    for (const [label, config] of [
      ["plain http to a public host", { ...davConfig, url: "http://example.com/dav/" }],
      ["credentials in the address", { ...davConfig, url: dav.url.replace("http://", "http://utente:pw@") }],
      ["a query in the address", { ...davConfig, url: `${dav.url}?x=1` }],
      ["no password", { ...davConfig, password: undefined }],
    ]) {
      const refused = await api.call("/api/backups/destinations", json("POST", { name: `dav-${crypto.randomBytes(3).toString("hex")}`, type: "webdav", config }));
      r.check(`WebDAV refused: ${label}`, refused.status === 400, `${refused.status} ${JSON.stringify(refused.body).slice(0, 160)}`);
    }

    const davCreated = await api.call("/api/backups/destinations", json("POST", { name: "Nextcloud di prova", type: "webdav", config: davConfig }));
    r.check("a WebDAV destination is created", davCreated.status === 201, JSON.stringify(davCreated.body));
    const davId = davCreated.body?.id;
    const list = await api.call("/api/backups/destinations");
    const row = list.body?.destinations?.find((entry) => entry.id === davId);
    r.check("the list says where it writes", row?.target?.url === dav.url && row?.target?.folder === "RunPanel/notte", JSON.stringify(row));
    r.check("never with which password", !JSON.stringify(list.body).includes("password-per-app"));
    const detail = await api.call(`/api/backups/destinations/${davId}`);
    r.check("the edit form says one is stored, not which", detail.body?.config?.hasPassword === true && !JSON.stringify(detail.body).includes("password-per-app"), JSON.stringify(detail.body));

    const verified = await api.call(`/api/backups/destinations/${davId}`, { method: "POST" });
    r.check("Verifica writes, moves, reads and deletes on the server", verified.body?.ok === true, JSON.stringify(verified.body));
    const keep = await api.call(`/api/backups/destinations/${davId}`, json("PATCH", { config: { password: "", folder: "RunPanel/notte" } }));
    r.check("an edit with an empty password keeps it", keep.status === 200 && (await api.call(`/api/backups/destinations/${davId}`, { method: "POST" })).body?.ok === true);

    if (canDumpStore) {
      const policy = await api.call("/api/backups/policies", json("POST", { name: "Su WebDAV", cron: "", destinationId: davId, targets: [{ kind: "panel" }] }));
      r.check("a policy can write to it", policy.status === 201, JSON.stringify(policy.body));
      const started = await api.call(`/api/backups/policies/${policy.body?.id}/run`, { method: "POST" });
      const finished = await waitForRun(api, started.body?.runId);
      r.check("the run succeeds", finished.status === "success", JSON.stringify(finished.errorMessage));
      r.check("the log says where the archive went", (finished.log ?? "").includes("Carico l'archivio su «Nextcloud di prova»"), finished.log?.slice(-400));
      const folder = path.join(davRoot, "dav", "RunPanel", "notte");
      const files = fs.readdirSync(folder);
      r.check("the server has the archive under its final name, nothing provisional", files.length === 1 && /^runpanel-.*\.zip(\.enc)?$/.test(files[0]), files.join(","));
      const onServer = fs.readFileSync(path.join(folder, files[0]));
      r.check("of the size the run recorded", onServer.length === finished.archiveBytes, `${onServer.length} vs ${finished.archiveBytes}`);
      const put = dav.requests.filter((req) => req.method === "PUT" && !decodeURIComponent(req.path).includes("write-test")).at(-1);
      r.check("uploaded under a provisional name, then moved", /\.partial$/.test(decodeURIComponent(put?.path ?? "")) && dav.requests.some((req) => req.method === "MOVE"), put?.path);

      const download = await fetch(`${base}/api/backups/runs/${started.body?.runId}/download`, { headers: { cookie: api.cookie } });
      const bytes = Buffer.from(await download.arrayBuffer());
      r.check("the download is streamed back from the server", download.status === 200 && bytes.equals(onServer), `${download.status} ${bytes.length}`);
      r.check("with the digest the run recorded", download.headers.get("x-checksum-sha256") === crypto.createHash("sha256").update(bytes).digest("hex"));

      const verify = await api.call(`/api/backups/runs/${started.body?.runId}/verify`, { method: "POST" });
      r.check("an integrity check can start on it", verify.status === 202, `${verify.status} ${JSON.stringify(verify.body).slice(0, 160)}`);
      let verification = null;
      for (let i = 0; i < 60; i++) {
        verification = (await api.call(`/api/backups/runs/${started.body?.runId}/verify`)).body?.verification;
        if (verification && verification.status !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      r.check("and reads it back from the server intact", verification?.status === "ok", JSON.stringify(verification));

      const removed = await api.call(`/api/backups/runs/${started.body?.runId}`, { method: "DELETE" });
      r.check("deleting the run", removed.status === 200, JSON.stringify(removed.body));
      r.check("deletes the archive on the server", fs.readdirSync(folder).length === 0, fs.readdirSync(folder).join(","));
      await api.call(`/api/backups/policies/${policy.body?.id}`, { method: "DELETE" });
    } else {
      r.note("store Postgres: il backup di prova su WebDAV gira solo con SQLite");
    }
    await api.call(`/api/backups/destinations/${davId}`, { method: "DELETE" });
  } finally {
    await dav.close();
    fs.rmSync(davRoot, { recursive: true, force: true });
  }

  // --- rclone ------------------------------------------------------------------------------
  const rclone = (config, who = api, name = `rclone-${crypto.randomBytes(3).toString("hex")}`) =>
    who.call("/api/backups/destinations", json("POST", { name, type: "rclone", config }));
  const garbage = await rclone({ provider: "drive", token: "non è un token" });
  r.check("a token that is not one is refused, saying what to paste", garbage.status === 400 && /rclone authorize/.test(garbage.body?.error ?? ""), JSON.stringify(garbage.body));
  const drive = await rclone({ provider: "drive", token: `Paste the following into your remote machine --->\n${TOKEN}\n<---End paste`, folder: "RunPanel" });
  r.check("Google Drive with the token rclone authorize printed", drive.status === 201, JSON.stringify(drive.body));
  {
    const detail = await api.call(`/api/backups/destinations/${drive.body?.id}`);
    r.check("the edit form says a token is stored, not which", detail.body?.config?.hasToken === true && detail.body?.config?.provider === "drive" && !JSON.stringify(detail.body).includes("accesso-di-prova"), JSON.stringify(detail.body));
    const list = await api.call("/api/backups/destinations");
    const row = list.body?.destinations?.find((entry) => entry.id === drive.body?.id);
    r.check("the list says Google Drive and the folder", row?.target?.service === "Google Drive" && row?.target?.folder === "RunPanel", JSON.stringify(row));
    r.check("never the token", !JSON.stringify(list.body).includes("accesso-di-prova") && !JSON.stringify(list.body).includes("rinnovo-di-prova"));
    const check = await api.call(`/api/backups/destinations/${drive.body?.id}`, { method: "POST" });
    r.check(
      tools.body?.rclone?.installed ? "Verifica fails with a fake token, in words" : "Verifica says rclone is missing and how to install it",
      check.body?.ok === false && (tools.body?.rclone?.installed || (check.body?.code === "RCLONE_MISSING" && /install\.sh/.test(check.body?.message ?? ""))),
      JSON.stringify(check.body)
    );
    r.check("without the token in the answer", !JSON.stringify(check.body).includes("accesso-di-prova"));
  }
  const commandOption = await rclone({ provider: "expert", sections: "[nas]\ntype = sftp\nhost = nas.lan\nssh = sh -c 'touch /tmp/pwned'\n" });
  r.check("an rclone option that runs a program is refused, even to the owner", commandOption.status === 400 && /eseguire un programma/.test(commandOption.body?.error ?? ""), JSON.stringify(commandOption.body));
  const expert = await rclone({ provider: "expert", sections: "[nas]\ntype = sftp\nhost = nas.lan\nuser = backup\n\n[cifrato]\ntype = crypt\nremote = nas:archivi\npassword = offuscata\n", remote: "cifrato" });
  r.check("the owner can paste a configuration", expert.status === 201, JSON.stringify(expert.body));
  {
    const detail = await api.call(`/api/backups/destinations/${expert.body?.id}`);
    r.check("whose remotes are listed by name and type only", JSON.stringify(detail.body?.config?.remotes) === JSON.stringify([{ name: "nas", type: "sftp" }, { name: "cifrato", type: "crypt" }]) && !JSON.stringify(detail.body).includes("offuscata"), JSON.stringify(detail.body?.config));
  }

  // A member holding `backup`, not the owner.
  const invited = await api.call("/api/users", json("POST", { email: "backup@remotes.test", hours: 1 }));
  const memberId = invited.body?.user?.id;
  await api.call(`/api/users/${memberId}`, json("PATCH", { access: { permissions: ["backup"], grants: [] } }));
  const member = client(base);
  const accepted = await member.call("/api/auth/invite", json("POST", { token: invited.body?.invitePath?.split("/").pop(), password: "member-password-1" }));
  r.check("a member with the backup permission signs in", accepted.status === 200, JSON.stringify(accepted.body));
  const memberExpert = await rclone({ provider: "expert", sections: "[nas]\ntype = sftp\nhost = nas.lan\n" }, member);
  r.check("a pasted rclone configuration is the owner's alone", memberExpert.status === 403, `${memberExpert.status} ${JSON.stringify(memberExpert.body)}`);
  const memberCheck = await member.call("/api/backups/destinations/check", json("POST", { type: "rclone", config: { provider: "expert", sections: "[x]\ntype = local\n" } }));
  r.check("even just to check it: a check would run it", memberCheck.status === 403, `${memberCheck.status} ${JSON.stringify(memberCheck.body)}`);
  const memberDrive = await rclone({ provider: "dropbox", token: TOKEN }, member);
  r.check("the guided services are open to the member", memberDrive.status === 201, JSON.stringify(memberDrive.body));
  const memberKey = await member.call("/api/backups/destinations/ssh-key", { method: "POST" });
  r.check("and so is an SFTP key", memberKey.status === 200);
  const memberDetail = await member.call(`/api/backups/destinations/${sftpId}`);
  r.check("but the edit form stays the owner's", memberDetail.status === 403, String(memberDetail.status));

  for (const id of [sftpId, drive.body?.id, expert.body?.id, memberDrive.body?.id].filter(Boolean)) {
    await api.call(`/api/backups/destinations/${id}`, { method: "DELETE" });
  }

  return r.result();
}
