import { createReporter, SETUP_TOKEN } from "../harness.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Two-step sign-in, end to end, against a real server.
 *
 * The password step must not open a session for an account with the second
 * factor on; the code step must refuse a code twice and a recovery code twice;
 * "remember this device" must skip only the code, only for that account; a
 * password reset link must not stand in for the code; and turning it off must
 * need more than an open session. Each of these was a way round the second
 * factor in some product, and each is a separate check here.
 *
 * Its own cookie jar: the harness client keeps one cookie, and this flow sets
 * two (the session and the remembered device).
 */
export const meta = { name: "two-factor", needsDocker: false, drivers: ["sqlite", "postgres"] };

const OWNER = "owner@runpanel.test";
const OWNER_PW = "two-factor-pw-1";
const MEMBER = "member@runpanel.test";
const MEMBER_PW = "member-pw-1";

function jar(base) {
  const cookies = new Map();
  return {
    has: (name) => cookies.has(name),
    drop: (name) => cookies.delete(name),
    async call(path, init = {}) {
      const res = await fetch(base + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          ...(init.headers ?? {}),
        },
      });
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(";");
        const at = pair.indexOf("=");
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
        if (gone) cookies.delete(name);
        else cookies.set(name, value);
      }
      // `text()` drops a leading byte order mark; the export's is checked on the bytes.
      if (init.raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
      const text = await res.text();
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, body, headers: res.headers };
    },
  };
}

const post = (body) => ({ method: "POST", body: JSON.stringify(body) });

export async function run({ base, repoRoot }) {
  const r = createReporter("two-factor");
  const totp = await import(pathToFileURL(join(repoRoot, "lib", "totp.ts")).href);

  const owner = jar(base);
  await owner.call("/api/auth/login", post({ setup: true, email: OWNER, password: OWNER_PW, setupToken: SETUP_TOKEN }));
  r.check("the owner is signed in", (await owner.call("/api/projects")).status === 200);

  // --- turning it on ----------------------------------------------------------------
  let status = await owner.call("/api/auth/two-factor");
  r.check("off to begin with", status.status === 200 && status.body.enabled === false, JSON.stringify(status.body));

  const crossOrigin = await owner.call("/api/auth/two-factor", { ...post({ action: "setup", password: OWNER_PW }), headers: { origin: "http://evil.example" } });
  r.check("a page on another origin cannot start a setup", crossOrigin.status === 403);

  r.check("the setup asks for the password", (await owner.call("/api/auth/two-factor", post({ action: "setup", password: "wrong" }))).status === 401);
  const setup = await owner.call("/api/auth/two-factor", post({ action: "setup", password: OWNER_PW }));
  r.check("the setup hands out a seed and an otpauth URI", setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.body.secret) && String(setup.body.uri).startsWith("otpauth://totp/"), JSON.stringify(setup.body));
  const key = totp.base32Decode(setup.body.secret);
  const step = () => totp.totpStep(Date.now());

  r.check("a wrong first code does not turn it on", (await owner.call("/api/auth/two-factor", post({ action: "enable", code: "000000" === totp.hotp(key, step()) ? "111111" : "000000" }))).status === 400);
  const enabledAt = step();
  const enabled = await owner.call("/api/auth/two-factor", post({ action: "enable", code: totp.hotp(key, enabledAt) }));
  r.check("the first right code turns it on and returns ten recovery codes", enabled.status === 200 && enabled.body.recoveryCodes?.length === 10, JSON.stringify(enabled.body).slice(0, 200));
  const recovery = enabled.body.recoveryCodes ?? [];
  status = await owner.call("/api/auth/two-factor");
  r.check("it reads as on, with ten codes left", status.body.enabled === true && status.body.recoveryCodesLeft === 10, JSON.stringify(status.body));
  r.check("a second setup over a working one is refused", (await owner.call("/api/auth/two-factor", post({ action: "setup", password: OWNER_PW }))).status === 409);
  r.check("the seed is never shown again", !JSON.stringify(status.body).includes(setup.body.secret));

  // --- the password alone no longer signs in -----------------------------------------
  const laptop = jar(base);
  const first = await laptop.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  r.check("the right password asks for the code", first.status === 200 && first.body.twoFactorRequired === true && typeof first.body.challenge === "string", JSON.stringify(first.body));
  r.check("and opens no session", (await laptop.call("/api/projects")).status === 401);
  const wrongPw = await laptop.call("/api/auth/login", post({ email: OWNER, password: "nope-nope" }));
  r.check("a wrong password still reads as a wrong password", wrongPw.status === 401 && !wrongPw.body.twoFactorRequired);

  const challenge = first.body.challenge;
  const replay = await laptop.call("/api/auth/login/two-factor", post({ challenge, code: totp.hotp(key, enabledAt) }));
  r.check("the code that turned it on cannot sign in again", replay.status === 401 && replay.body.code !== "challenge_expired", JSON.stringify(replay.body));
  const forged = await laptop.call("/api/auth/login/two-factor", post({ challenge: "x".repeat(43), code: totp.hotp(key, enabledAt + 1) }));
  r.check("a made-up challenge is refused", forged.status === 401 && forged.body.code === "challenge_expired");
  const signedIn = await laptop.call("/api/auth/login/two-factor", post({ challenge, code: totp.hotp(key, enabledAt + 1) }));
  r.check("a fresh code completes the sign-in", signedIn.status === 200 && signedIn.body.success === true, JSON.stringify(signedIn.body));
  r.check("and the session works", (await laptop.call("/api/projects")).status === 200);
  r.check("a spent challenge cannot be used again", (await laptop.call("/api/auth/login/two-factor", post({ challenge, code: totp.hotp(key, enabledAt + 1) }))).body.code === "challenge_expired");

  // --- recovery codes ----------------------------------------------------------------------
  const phone = jar(base);
  let c = await phone.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  const viaRecovery = await phone.call("/api/auth/login/two-factor", post({ challenge: c.body.challenge, code: recovery[0].toUpperCase() }));
  r.check("a recovery code signs in, and says how many are left", viaRecovery.status === 200 && viaRecovery.body.recoveryCodesLeft === 9, JSON.stringify(viaRecovery.body));
  c = await phone.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  r.check("the same recovery code does not work twice", (await phone.call("/api/auth/login/two-factor", post({ challenge: c.body.challenge, code: recovery[0] }))).status === 401);

  // --- remembering a device ------------------------------------------------------------------
  const desk = jar(base);
  c = await desk.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  const remembered = await desk.call("/api/auth/login/two-factor", post({ challenge: c.body.challenge, code: recovery[1], remember: true }));
  r.check("remember sets a device cookie", remembered.status === 200 && desk.has("runpanel_device"));
  await desk.call("/api/auth/logout", post({}));
  const again = await desk.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  r.check("a remembered browser signs in with the password alone", again.status === 200 && again.body.success === true && !again.body.twoFactorRequired, JSON.stringify(again.body));
  status = await owner.call("/api/auth/two-factor");
  r.check("the account counts one remembered device", status.body.rememberedDevices === 1, JSON.stringify(status.body));
  r.check("forgetting the devices works", (await owner.call("/api/auth/two-factor", post({ action: "forget-devices" }))).status === 200);
  await desk.call("/api/auth/logout", post({}));
  const forgotten = await desk.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  r.check("after forgetting, the code is asked again", forgotten.body.twoFactorRequired === true);

  // --- other devices -------------------------------------------------------------------------
  const others = await owner.call("/api/sessions?others=1", { method: "DELETE" });
  r.check("signing out every other device closes them", others.status === 200 && others.body.closed >= 2, JSON.stringify(others.body));
  r.check("the laptop is signed out", (await laptop.call("/api/projects")).status === 401);
  r.check("the device that asked is not", (await owner.call("/api/projects")).status === 200);

  // --- a second account ----------------------------------------------------------------------
  const invited = await owner.call("/api/users", post({ email: MEMBER, hours: 24 }));
  const memberId = invited.body.user?.id;
  const inviteToken = String(invited.body.invitePath ?? "").split("/").pop();
  const member = jar(base);
  const joined = await member.call("/api/auth/invite", post({ token: inviteToken, password: MEMBER_PW }));
  r.check("an invitation without two-step sign-in still signs in", joined.status === 200 && joined.body.signedIn === true, JSON.stringify(joined.body));
  const memberSetup = await member.call("/api/auth/two-factor", post({ action: "setup", password: MEMBER_PW }));
  const memberKey = totp.base32Decode(memberSetup.body.secret ?? "");
  await member.call("/api/auth/two-factor", post({ action: "enable", code: totp.hotp(memberKey, step()) }));
  r.check("the member turned it on", (await member.call("/api/auth/two-factor")).body.enabled === true);

  r.check("the member's status is visible to who manages users", (await owner.call(`/api/users/${memberId}/two-factor`)).body.enabled === true);
  r.check("the member cannot read the log export without the permission", (await member.call("/api/audit/export")).status === 403);

  const resetLink = await owner.call(`/api/users/${memberId}/invite`, post({ hours: 1 }));
  const resetToken = String(resetLink.body.invitePath ?? "").split("/").pop();
  const stranger = jar(base);
  const redeemed = await stranger.call("/api/auth/invite", post({ token: resetToken, password: "member-pw-2" }));
  r.check("a reset link sets the password but does not sign in past the second step", redeemed.status === 200 && redeemed.body.signedIn === false, JSON.stringify(redeemed.body));
  r.check("so whoever holds the link has no session", (await stranger.call("/api/projects")).status === 401);
  const memberLogin = await stranger.call("/api/auth/login", post({ email: MEMBER, password: "member-pw-2" }));
  r.check("the new password still asks for the code", memberLogin.body.twoFactorRequired === true);

  r.check("the owner's second step cannot be reset through the users API", (await owner.call(`/api/users/${(await owner.call("/api/account")).body.id}/two-factor`, { method: "DELETE" })).status === 403);
  r.check("the member's can, by who manages users", (await owner.call(`/api/users/${memberId}/two-factor`, { method: "DELETE" })).status === 200);
  const plain = await stranger.call("/api/auth/login", post({ email: MEMBER, password: "member-pw-2" }));
  r.check("after the reset the password alone signs the member in", plain.status === 200 && plain.body.success === true && !plain.body.twoFactorRequired, JSON.stringify(plain.body));

  // --- tokens never reach it ---------------------------------------------------------------------
  await owner.call("/api/api-tokens", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  const minted = await owner.call("/api/api-tokens", post({ name: "ci", access: "full", expiresInDays: 30 }));
  const bearer = { authorization: `Bearer ${minted.body.token}` };
  const viaToken = await fetch(`${base}/api/auth/two-factor`, { headers: bearer });
  r.check("an API token is not a session for two-step sign-in", viaToken.status === 401, String(viaToken.status));
  const tokenReset = await fetch(`${base}/api/users/${memberId}/two-factor`, { method: "DELETE", headers: bearer });
  r.check("nor can a token turn off someone else's", tokenReset.status === 403, String(tokenReset.status));

  // --- the export ----------------------------------------------------------------------------------
  const csv = await owner.call("/api/audit/export?action=account.two-factor.enable", { raw: true });
  const bytes = csv.bytes ?? Buffer.alloc(0);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  r.check("the log exports as CSV", csv.status === 200 && (csv.headers.get("content-type") ?? "").startsWith("text/csv"), csv.headers.get("content-type") ?? "");
  r.check("it starts with a byte order mark, for Excel", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);
  r.check("then a header row and only the filtered entries", text.includes("Codice azione") && text.split("\r\n").filter((l) => l.includes("account.two-factor.enable")).length === 2, text.slice(0, 300));
  r.check("as a download", /attachment; filename="registro-attivita-\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers.get("content-disposition") ?? ""));

  // --- turning it off ------------------------------------------------------------------------------
  r.check("turning it off needs the password", (await owner.call("/api/auth/two-factor", post({ action: "disable", password: "wrong", code: recovery[2] }))).status === 401);
  r.check("and a code", (await owner.call("/api/auth/two-factor", post({ action: "disable", password: OWNER_PW, code: "123456" === totp.hotp(key, step()) ? "654321" : "123456" }))).status === 401);
  const off = await owner.call("/api/auth/two-factor", post({ action: "disable", password: OWNER_PW, code: recovery[2] }));
  r.check("with both, it turns off", off.status === 200 && off.body.status?.enabled === false, JSON.stringify(off.body));
  const back = jar(base);
  const passwordOnly = await back.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  r.check("and the password alone signs in again", passwordOnly.status === 200 && passwordOnly.body.success === true);

  // --- guessing is limited (last: it locks the account's codes for a while) -----------------------
  const setup2 = await owner.call("/api/auth/two-factor", post({ action: "setup", password: OWNER_PW }));
  const key2 = totp.base32Decode(setup2.body.secret);
  await owner.call("/api/auth/two-factor", post({ action: "enable", code: totp.hotp(key2, step()) }));
  const guesser = jar(base);
  const g = await guesser.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  const right = new Set([-1, 0, 1].map((d) => totp.hotp(key2, step() + d)));
  const guesses = ["111111", "222222", "333333", "444444", "555555", "666666", "777777"].filter((code) => !right.has(code));
  const statuses = [];
  for (const code of guesses.slice(0, 6)) statuses.push((await guesser.call("/api/auth/login/two-factor", post({ challenge: g.body.challenge, code }))).status);
  r.check("five wrong codes end the challenge", statuses.slice(0, 5).every((s) => s === 401) && statuses[5] === 401, statuses.join(","));
  const fresh = await guesser.call("/api/auth/login", post({ email: OWNER, password: OWNER_PW }));
  const limited = await guesser.call("/api/auth/login/two-factor", post({ challenge: fresh.body.challenge, code: totp.hotp(key2, step() + 1) }));
  r.check("and the account takes no more codes for a while, even a right one", limited.status === 429, `${limited.status} ${JSON.stringify(limited.body)}`);

  return r.result();
}
