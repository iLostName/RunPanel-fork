import { createReporter } from "../harness.mjs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadTs } from "../ts-modules.mjs";
import { serveSftp } from "../sftp-fake.mjs";

/**
 * The SFTP destination, without an SSH server.
 *
 * None can be started here without installing one, so the layers are checked
 * where they can be:
 *
 *  - the key pair and the host key, against the real `ssh-keygen` when it is
 *    installed (it reads the private key and derives the same public key and
 *    fingerprint);
 *  - the command line given to ssh, and the environment: the host after `--`,
 *    a host that looks like an option staying a host, paths with spaces;
 *  - every sentence ssh and an SFTP server answer with, mapped to its cause;
 *  - the protocol client against OpenSSH's own `sftp-server` when one is
 *    installed (Git for Windows ships it, Debian has it in openssh-sftp-server),
 *    and against tests/sftp-fake.mjs for what a real server will not do on
 *    request — replies out of order, short reads, a chatty login script, a
 *    server that goes silent, a connection that drops mid-upload;
 *  - the destination end to end — put, stat, open, remove, "Verifica" — with
 *    tests/ssh-fake.mjs where `ssh` would be: it checks the command line, plays
 *    ssh's part with the known_hosts file (accepting a new key, refusing a
 *    changed one in ssh's words) and serves SFTP from a folder.
 *
 * What is NOT covered here: a real SSH handshake and authentication. That is
 * OpenSSH's own code, and "Verifica" on a real server exercises it.
 */
export const meta = { name: "backup-sftp-unit", needsDocker: false, drivers: [], standalone: true };

const HERE = dirname(fileURLToPath(import.meta.url));

function findSftpServer() {
  const candidates = [
    process.env.RUNPANEL_TEST_SFTP_SERVER,
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/libexec/sftp-server",
    "C:/Program Files/Git/usr/lib/ssh/sftp-server.exe",
  ].filter(Boolean);
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function hasSshKeygen() {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // `-?` exits 1 after printing the usage: present.
    return err.code !== "ENOENT";
  }
}

/** A client and the fake server on two in-memory pipes. */
function fakePair(SftpClient, root, knobs = {}, clientOpts = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  serveSftp({ input: toServer, output: toClient, root, knobs });
  return new SftpClient({ input: toClient, output: toServer }, clientOpts);
}

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
  const r = createReporter("backup-sftp-unit");
  const remote = await loadTs(repoRoot, "lib", "backup-remote.ts");
  const keys = await loadTs(repoRoot, "services", "backup", "destinations", "ssh-keys.ts");
  const { SftpClient, SftpStatusError, SftpProtocolError, FX } = await loadTs(repoRoot, "services", "backup", "destinations", "sftp-client.ts");
  const transport = await loadTs(repoRoot, "services", "backup", "destinations", "ssh-transport.ts");
  const errors = await loadTs(repoRoot, "services", "backup", "destinations", "ssh-errors.ts");
  const { sftpDestination } = await loadTs(repoRoot, "services", "backup", "destinations", "sftp.ts");
  const { DestinationFailure } = await loadTs(repoRoot, "services", "backup", "destinations", "problem.ts");

  const scratch = fs.mkdtempSync(join(os.tmpdir(), "rp-sftp-unit-"));
  const fresh = (name) => {
    const dir = join(scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  try {
    // --- hosts, users and folders ---------------------------------------------
    for (const host of ["nas.casa.lan", "192.168.1.20", "u123456.your-storagebox.de", "fe80::1", "[2001:db8::1]", "backup-01"]) {
      r.check(`host accepted: ${host}`, remote.sshHostProblem(host) === null, remote.sshHostProblem(host));
    }
    for (const host of ["-oProxyCommand=touch /tmp/x", "utente@nas.lan", "nas.lan:22", "sftp://nas.lan", "", "nas lan", "nas;reboot", "-p"]) {
      r.check(`host refused: ${JSON.stringify(host)}`, remote.sshHostProblem(host) !== null);
    }
    r.check("a bracketed IPv6 address is stored bare", remote.normalizeSshHost(" [2001:db8::1] ") === "2001:db8::1");
    for (const user of ["backup", "u123456-sub1", "nome.cognome@dominio", "user_1"]) {
      r.check(`user accepted: ${user}`, remote.sshUserProblem(user) === null, remote.sshUserProblem(user));
    }
    for (const user of ["-oProxyCommand=x", "a b", "a;b", "a'b", "a$(id)", ""]) {
      r.check(`user refused: ${JSON.stringify(user)}`, remote.sshUserProblem(user) !== null);
    }
    for (const folder of ["Backup/run panel", "it's \"quoted\"", "/volume1/backup", "città/ü"]) {
      r.check(`folder accepted: ${folder}`, remote.remoteFolderProblem(folder, { allowAbsolute: true }) === null);
    }
    for (const folder of ["../etc", "a/../b", "a/./b", "a\\b", "a\u0000b", "a\nb"]) {
      r.check(`folder refused: ${JSON.stringify(folder)}`, remote.remoteFolderProblem(folder, { allowAbsolute: true }) !== null);
    }
    r.check("a leading slash is refused where it means nothing", remote.remoteFolderProblem("/x", { allowAbsolute: false }) !== null);
    r.check("folders are tidied", remote.normalizeRemoteFolder(" /a//b c/ ", { allowAbsolute: true }) === "/a/b c");
    r.check("and lose the leading slash where it means nothing", remote.normalizeRemoteFolder("/a/b/", { allowAbsolute: false }) === "a/b");
    r.check("the provisional name is hidden and says partial", remote.partialName("f/x.zip", "ab12") === "f/.x.zip.ab12.partial");
    r.check("also at the top", remote.partialName("x.zip", "ab12") === ".x.zip.ab12.partial");

    // --- the key pair -----------------------------------------------------------
    const pair = keys.generateSshKeyPair(keys.keyComment("pannello di prova"));
    r.check("the public key is an ed25519 line", /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* runpanel-backup@pannellodiprova$/.test(pair.publicKey), pair.publicKey);
    r.check("the private key is in OpenSSH's format", pair.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n") && pair.privateKey.trim().endsWith("-----END OPENSSH PRIVATE KEY-----"));
    r.check("the fingerprint is SHA256 and unpadded", /^SHA256:[A-Za-z0-9+/]{43}$/.test(pair.fingerprint), pair.fingerprint);
    r.check("the fingerprint is read back from the line", keys.fingerprintOf(pair.publicKey) === pair.fingerprint);
    r.check("two pairs are never the same", keys.generateSshKeyPair("x").publicKey.split(" ")[1] !== pair.publicKey.split(" ")[1]);
    if (hasSshKeygen()) {
      const dir = fresh("keygen");
      const file = join(dir, "id");
      fs.writeFileSync(file, pair.privateKey, { mode: 0o600 });
      fs.writeFileSync(`${file}.pub`, `${pair.publicKey}\n`);
      const derived = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();
      r.check("ssh-keygen reads the private key and derives the same public key", derived.split(" ").slice(0, 2).join(" ") === pair.publicKey.split(" ").slice(0, 2).join(" "), derived);
      const listed = execFileSync("ssh-keygen", ["-l", "-f", `${file}.pub`], { encoding: "utf8" });
      r.check("and prints the same fingerprint", listed.includes(pair.fingerprint), listed.trim());
      fs.writeFileSync(join(dir, "known_hosts"), keys.knownHostsFor(pair.publicKey));
      const found = execFileSync("ssh-keygen", ["-F", keys.HOST_KEY_ALIAS, "-f", join(dir, "known_hosts")], { encoding: "utf8" });
      r.check("the known_hosts file written for a pinned key is one ssh finds", found.includes(pair.publicKey.split(" ")[1]));
    } else {
      r.note("ssh-keygen non installato: il formato della chiave non è confrontato con OpenSSH");
    }

    // --- host keys ----------------------------------------------------------------
    const hostKey = pair.publicKey.split(" ").slice(0, 2).join(" ");
    r.check("a pinned key round-trips through known_hosts", keys.learnedHostKey(keys.knownHostsFor(hostKey)) === hostKey);
    r.check(
      "only the alias line counts",
      keys.learnedHostKey(`# commento\n@revoked runpanel-destination ${hostKey}\nother.host ${hostKey}\n`) === null
    );
    const other = keys.generateSshKeyPair("y").publicKey;
    const [, otherData] = other.split(" ");
    r.check("a key whose blob is another type is refused", keys.parsePublicKey(`ssh-rsa ${otherData}`) === null);
    r.check("garbage is not a key", keys.parsePublicKey("ssh-ed25519 !!!") === null && keys.parsePublicKey("hello") === null);
    r.check("an authorized_keys option prefix is not a key", keys.parsePublicKey(`restrict ${hostKey}`) === null);

    // --- the command line -----------------------------------------------------------
    {
      const files = { identity: "/data dir/tmp/rp-ssh-x/id", knownHosts: "/data dir/tmp/rp-ssh-x/known_hosts" };
      const args = transport.sshArguments({ host: "nas.lan", port: 23, username: "u123", }, files, { pinned: true, connectTimeoutSec: 20 });
      const end = args.indexOf("--");
      r.check("the host comes after --, then the subsystem", end > 0 && args[end + 1] === "nas.lan" && args[end + 2] === "sftp" && args.length === end + 3, args.slice(-4).join(" "));
      r.check("as a subsystem", args[end - 1] === "-s");
      r.check("no config file, no agent, no prompts", args.includes("none") && args.includes("BatchMode=yes") && args.includes("IdentityAgent=none") && args.includes("PasswordAuthentication=no"));
      r.check("only the destination's key", args.includes("IdentitiesOnly=yes") && args[args.indexOf("-i") + 1] === files.identity);
      r.check("a pinned key is checked strictly", args.includes("StrictHostKeyChecking=yes"));
      r.check("under the alias", args.includes(`HostKeyAlias=${keys.HOST_KEY_ALIAS}`));
      r.check("a known_hosts path with a space is quoted", args.includes('UserKnownHostsFile="/data dir/tmp/rp-ssh-x/known_hosts"'));
      r.check("port and user are values of their options", args[args.indexOf("-p") + 1] === "23" && args[args.indexOf("-l") + 1] === "u123");
      const first = transport.sshArguments({ host: "nas.lan", port: 22, username: "u" }, files, { pinned: false, connectTimeoutSec: 20 });
      r.check("an unknown key is accepted once, not always", first.includes("StrictHostKeyChecking=accept-new") && !first.includes("StrictHostKeyChecking=no"));
      const hostile = transport.sshArguments({ host: "-oProxyCommand=touch pwned", port: 22, username: "-oProxyCommand=x" }, files, { pinned: true, connectTimeoutSec: 20 });
      const hostileEnd = hostile.indexOf("--");
      r.check(
        "a host that looks like an option stays a host",
        hostile[hostileEnd + 1] === "-oProxyCommand=touch pwned" && hostile.slice(0, hostileEnd).every((arg, i) => hostile[i - 1] === "-l" || !arg.startsWith("-oProxyCommand"))
          && hostile[hostile.indexOf("-l") + 1] === "-oProxyCommand=x"
      );
      r.check("a % in a path is not a token", transport.sshOptionPath("/data/100%/kh") === '"/data/100%%/kh"');
      r.check("windows paths get forward slashes", transport.sshOptionPath("C:\\Users\\a b\\kh") === '"C:/Users/a b/kh"');
      const env = transport.sshEnvironment({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent", DISPLAY: ":0", LANG: "it_IT.UTF-8" });
      r.check("ssh runs without the agent and in the C locale", env.SSH_AUTH_SOCK === undefined && env.DISPLAY === undefined && env.LC_ALL === "C" && env.PATH === "/usr/bin");
    }

    // --- what ssh says ------------------------------------------------------------
    {
      const ctx = { host: "nas.lan", port: 22, username: "backup", folder: "runpanel-backups", pinned: false, step: "check" };
      const said = (stderr, extra = {}) => errors.describeSshExit({ stderr, exitCode: 255, connected: false, ...extra }, { ...ctx, ...(extra.ctx ?? {}) });
      const cases = [
        ["ssh: Could not resolve hostname nas.lan: Name or service not known", "DNS"],
        ["ssh: Could not resolve hostname nas.lan: Temporary failure in name resolution", "DNS_UNAVAILABLE"],
        ["ssh: connect to host 10.0.0.5 port 22: Connection refused", "REFUSED"],
        ["ssh: connect to host 10.0.0.5 port 22: Connection timed out", "TIMEOUT"],
        ["ssh: connect to host 10.0.0.5 port 22: No route to host", "UNREACHABLE"],
        ["backup@nas.lan: Permission denied (publickey).", "AUTH"],
        ["backup@nas.lan: Permission denied (publickey,password).", "AUTH"],
        ["backup@nas.lan: Permission denied (password,keyboard-interactive).", "AUTH_NO_KEYS"],
        ["subsystem request failed on channel 0", "NO_SFTP"],
        ["Unable to negotiate with 10.0.0.5 port 22: no matching host key type found. Their offer: ssh-rsa,ssh-dss", "OLD_SERVER"],
        ["kex_exchange_identification: read: Connection reset by peer", "CLOSED"],
        ["banner exchange: Connection to 10.0.0.5 port 443: invalid format", "NOT_SSH"],
        ['Load key "/data/tmp/rp-ssh-x/id": invalid format', "KEY_INVALID"],
        ["Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures", "AUTH"],
      ];
      for (const [stderr, code] of cases) {
        const p = said(stderr);
        r.check(`ssh "${stderr.slice(0, 48)}…" → ${code}`, p.code === code, `${p.code}: ${p.cause}`);
      }
      const changed = said("@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@\nHost key verification failed.", { ctx: { pinned: true } });
      r.check("a changed host key is refused, in words", changed.code === "HOST_KEY_CHANGED" && /chiave diversa/.test(changed.cause) && /Dimentica l'impronta/.test(changed.fix), changed.cause);
      r.check("the banner of @ signs does not reach the detail", !(changed.detail ?? "").includes("@@@"), changed.detail);
      const otherType = said("No ED25519 host key is known for runpanel-destination and you have requested strict checking.\nHost key verification failed.", { ctx: { pinned: true } });
      r.check("a key of another type counts as changed", otherType.code === "HOST_KEY_CHANGED");
      const missing = errors.describeSshExit({ stderr: "", exitCode: null, connected: false, spawnError: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) }, ctx);
      r.check("no ssh at all says how to install it, without running sudo", missing.code === "SSH_MISSING" && /apt install openssh-client/.test(missing.fix));
      const lost = errors.describeSshExit({ stderr: "client_loop: send disconnect: Broken pipe", exitCode: 255, connected: true }, ctx);
      r.check("a connection lost after the start is not a refusal", lost.code === "CONNECTION_LOST" && /\.partial/.test(lost.fix));
      const banner = errors.describeProtocol(new SftpProtocolError("BANNER", "x", "Benvenuto sul NAS di casa"), ctx);
      r.check("text from a login script is explained", banner.code === "BANNER" && /bashrc/.test(banner.fix) && banner.cause.includes("Benvenuto"));
    }

    // --- what an SFTP server says ------------------------------------------------
    {
      const ctx = { host: "nas.lan", port: 22, username: "backup", folder: "/volume1/backup", pinned: true, step: "upload" };
      const status = (code, operation, message = "") => new SftpStatusError(code, message, operation, "/volume1/backup/x");
      r.check("a missing archive", errors.describeSftpStatus(status(FX.NO_SUCH_FILE, "stat"), { ...ctx, step: "stat" }).code === "NOT_FOUND");
      r.check("a missing folder on upload", errors.describeSftpStatus(status(FX.NO_SUCH_FILE, "mkdir"), ctx).code === "NO_FOLDER");
      const denied = errors.describeSftpStatus(status(FX.PERMISSION_DENIED, "write", "Permission denied"), ctx);
      r.check("a refused write names the user, the folder and the verb", denied.code === "PERMISSION" && denied.cause.includes("«backup»") && denied.cause.includes("scrivere") && denied.cause.includes("/volume1/backup"), denied.cause);
      const reading = errors.describeSftpStatus(status(FX.PERMISSION_DENIED, "read"), ctx);
      r.check("a refused read says reading", reading.cause.includes("leggere"));
      const full = errors.describeSftpStatus(status(FX.FAILURE, "write", "Failure"), ctx, { available: 1024 });
      r.check("a generic failure with no space left is a full disk", full.code === "DISK_FULL" && /finito/.test(full.cause), full.cause);
      const vague = errors.describeSftpStatus(status(FX.FAILURE, "write", "Failure"), ctx, null);
      r.check("without the number it says what it usually is", vague.code === "WRITE_REFUSED" && /spazio/.test(vague.fix));
      r.check("a quota is a quota", errors.describeSftpStatus(status(FX.QUOTA_EXCEEDED, "write"), ctx).code === "QUOTA");
      r.check("a refused rename says why it is needed", /nome provvisorio/.test(errors.describeSftpStatus(status(FX.FAILURE, "rename"), ctx).fix));
    }

    // --- the protocol client, against the fake ------------------------------------
    {
      // NTFS refuses a double quote in a name; everywhere else it is part of the test.
      const quoted = process.platform === "win32" ? "c 'd" : "c 'd\"";
      const deep = `a b/${quoted}/é`;
      const root = fresh("fake-root");
      const client = fakePair(SftpClient, root);
      await client.init();
      r.check("version 3 is negotiated", client.version === 3);
      r.check("posix-rename is picked up", client.extensions.has("posix-rename@openssh.com"));
      await client.ensureDir(deep);
      r.check("nested folders with spaces, quotes and accents are created", fs.statSync(join(root, "a b", quoted, "é")).isDirectory());
      await client.ensureDir(deep);
      r.check("and creating them again is not an error", true);
      const local = join(scratch, "upload.bin");
      const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
      fs.writeFileSync(local, data);
      const sent = await client.upload(local, `${deep}/.up.partial`);
      r.check("an upload sends every byte", sent === data.length && fs.readFileSync(join(root, "a b", quoted, "é", ".up.partial")).equals(data));
      await client.rename(`${deep}/.up.partial`, `${deep}/up.zip`);
      const back = await collect(await client.download(`${deep}/up.zip`));
      r.check("a download gives the same bytes back", back.equals(data));
      const missing = await rejects(client.download("nope.zip"));
      r.check("a missing file fails when opened, not on the first read", missing instanceof SftpStatusError && missing.status === FX.NO_SUCH_FILE);
      client.end();

      const reordered = fakePair(SftpClient, root, { reorder: true });
      await reordered.init();
      const backReordered = await collect(await reordered.download(`${deep}/up.zip`));
      r.check("replies out of order still give the bytes in order", backReordered.equals(data));
      const local2 = join(scratch, "upload2.bin");
      const data2 = crypto.randomBytes(2 * 1024 * 1024 + 5);
      fs.writeFileSync(local2, data2);
      await reordered.upload(local2, "reordered.bin");
      r.check("and writes acknowledged out of order land where they belong", fs.readFileSync(join(root, "reordered.bin")).equals(data2));
      reordered.end();

      const short = fakePair(SftpClient, root, { shortReads: true });
      await short.init();
      const backShort = await collect(await short.download(`${deep}/up.zip`));
      r.check("short reads are completed before what follows", backShort.equals(data));
      short.end();

      const chatty = fakePair(SftpClient, root, { banner: "Benvenuto sul NAS di casa!\n" });
      const bannerError = await rejects(chatty.init());
      r.check("text printed before the protocol is recognised", bannerError instanceof SftpProtocolError && bannerError.code === "BANNER" && bannerError.sample.includes("Benvenuto"), String(bannerError));

      const silent = fakePair(SftpClient, root, { silent: true }, { stallMs: 300 });
      await silent.init();
      // The watchdog does not hold the process open (in the panel, ssh does):
      // with two in-memory pipes something else has to.
      const keepAlive = setInterval(() => {}, 1000);
      const stalled = await rejects(silent.stat("a b"));
      clearInterval(keepAlive);
      r.check("a server that stops answering is given up on", stalled instanceof SftpProtocolError && stalled.code === "STALLED", String(stalled));

      const dropping = fakePair(SftpClient, root, { dropAfterBytes: 512 * 1024 });
      await dropping.init();
      const dropped = await rejects(dropping.upload(local, "dropped.partial"));
      r.check("a connection that drops mid-upload fails the upload", dropped instanceof SftpProtocolError && dropped.code === "CLOSED", String(dropped));

      const truncatedRoot = fresh("truncated");
      fs.writeFileSync(join(truncatedRoot, "f.bin"), crypto.randomBytes(200_000));
      const truncating = fakePair(SftpClient, truncatedRoot);
      await truncating.init();
      const stream = await truncating.download("f.bin");
      fs.truncateSync(join(truncatedRoot, "f.bin"), 1000);
      const cut = await rejects(collect(stream));
      r.check("a file that turns out shorter than it said is an error, not a short archive", cut instanceof SftpStatusError, String(cut));
      truncating.end();
    }

    // --- the protocol client, against OpenSSH's sftp-server ------------------------
    const sftpServer = findSftpServer();
    if (sftpServer) {
      const { spawn } = await import("node:child_process");
      const root = fresh("real-root");
      const child = spawn(sftpServer, [], { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
      const client = new SftpClient({ input: child.stdout, output: child.stdin });
      await client.init();
      r.check("OpenSSH's sftp-server: version 3", client.version === 3);
      await client.ensureDir("run panel/«archivi»/it's");
      const local = join(scratch, "real.bin");
      const data = crypto.randomBytes(4 * 1024 * 1024 + 3);
      fs.writeFileSync(local, data);
      await client.upload(local, "run panel/«archivi»/it's/.r.partial");
      const kept = await client.stat("run panel/«archivi»/it's/.r.partial");
      r.check("OpenSSH's sftp-server: the size is kept", kept.size === data.length);
      await client.rename("run panel/«archivi»/it's/.r.partial", "run panel/«archivi»/it's/r.zip");
      const back = await collect(await client.download("run panel/«archivi»/it's/r.zip"));
      r.check("OpenSSH's sftp-server: the same bytes come back", back.equals(data));
      const space = await client.space(".");
      r.check("OpenSSH's sftp-server: free space is read", space === null || space.available > 0);
      const gone = await rejects(client.stat("run panel/missing"));
      r.check("OpenSSH's sftp-server: a missing file is NO_SUCH_FILE", gone instanceof SftpStatusError && gone.status === FX.NO_SUCH_FILE);
      await client.remove("run panel/«archivi»/it's/r.zip");
      r.check("OpenSSH's sftp-server: removed", !fs.existsSync(join(root, "run panel", "«archivi»", "it's", "r.zip")));
      client.end();
    } else {
      r.note("sftp-server di OpenSSH non trovato: il client è provato solo contro il server finto");
    }

    // --- the destination, end to end, with the stand-in for ssh ---------------------
    const passes = [{ label: "fake server", server: null }, ...(sftpServer ? [{ label: "OpenSSH sftp-server", server: sftpServer }] : [])];
    for (const pass of passes) {
      const root = fresh(`dest-${pass.server ? "real" : "fake"}`);
      const tmpDir = fresh(`dest-tmp-${pass.server ? "real" : "fake"}`);
      const record = join(scratch, `record-${pass.server ? "real" : "fake"}.jsonl`);
      const serverKey = keys.generateSshKeyPair("server").publicKey.split(" ").slice(0, 2).join(" ");
      const command = { file: process.execPath, args: [join(HERE, "..", "ssh-fake.mjs")] };
      const setEnv = (extra = {}) => {
        process.env.FAKE_SSH_HOST_KEY = serverKey;
        process.env.FAKE_SFTP_ROOT = root;
        process.env.FAKE_SSH_RECORD = record;
        if (pass.server) process.env.FAKE_SFTP_SERVER = pass.server;
        else delete process.env.FAKE_SFTP_SERVER;
        for (const key of ["FAKE_SSH_MODE", "FAKE_SFTP_DROP_AFTER", "FAKE_SFTP_NO_REMOVE", "FAKE_SFTP_NO_RENAME", "FAKE_SFTP_READ_ONLY"]) delete process.env[key];
        Object.assign(process.env, extra);
      };
      const config = { host: "nas.lan", port: 22, username: "backup", folder: "Backup/run panel", privateKey: pair.privateKey, publicKey: pair.publicKey, hostKey: null };
      const pinnedKeys = [];
      const destination = (overrides = {}, deps = {}) =>
        sftpDestination({ id: "d1", name: "NAS", type: "sftp" }, { ...config, ...overrides }, {
          tmpDir,
          command,
          pinHostKey: async (key) => {
            pinnedKeys.push(key);
          },
          ...deps,
        });
      const tag = (text) => `${pass.label}: ${text}`;

      setEnv();
      const first = await destination().test();
      r.check(tag("Verifica works on first contact"), first.ok === true, JSON.stringify(first));
      r.check(tag("it learns the host key and says its fingerprint"), first.learned?.hostKey === serverKey && first.message.includes(keys.fingerprintOf(serverKey)), first.message);
      r.check(tag("and pins it"), pinnedKeys.includes(serverKey));
      r.check(tag("the probe file is gone"), fs.readdirSync(join(root, "Backup", "run panel")).length === 0);

      const archive = join(scratch, "archive.zip");
      const payload = crypto.randomBytes(1024 * 1024 + 99);
      fs.writeFileSync(archive, payload);
      const pinnedDestination = destination({ hostKey: serverKey });
      const stored = await pinnedDestination.put(archive, "runpanel-20261118-030000-notte-abc123.zip");
      r.check(tag("put returns the path under the folder"), stored.ref === "Backup/run panel/runpanel-20261118-030000-notte-abc123.zip" && stored.bytes === payload.length, JSON.stringify(stored));
      const listing = fs.readdirSync(join(root, "Backup", "run panel"));
      r.check(tag("only the final name is left, no .partial"), listing.length === 1 && listing[0] === "runpanel-20261118-030000-notte-abc123.zip", listing.join(","));
      r.check(tag("with every byte"), fs.readFileSync(join(root, "Backup", "run panel", listing[0])).equals(payload));

      const st = await pinnedDestination.stat(stored.ref);
      r.check(tag("stat sees it"), st.exists && st.bytes === payload.length, JSON.stringify(st));
      const none = await pinnedDestination.stat("Backup/run panel/nope.zip");
      r.check(tag("and not what is not there"), none.exists === false);
      const opened = await collect(await pinnedDestination.open(stored.ref));
      r.check(tag("open streams it back"), opened.equals(payload));
      const missingOpen = await rejects(pinnedDestination.open("Backup/run panel/nope.zip"));
      r.check(tag("opening a missing archive says so"), missingOpen instanceof DestinationFailure && missingOpen.problem.code === "NOT_FOUND", String(missingOpen));

      const records = fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      r.check(tag("every session got a key file"), records.length >= 4 && records.every((entry) => entry.identity.includes(transport.SSH_FOLDER_PREFIX)));
      r.check(tag("which no longer exists"), records.every((entry) => !fs.existsSync(entry.identity)));
      r.check(tag("no key folder is left in tmp"), fs.readdirSync(tmpDir).filter((name) => name.startsWith(transport.SSH_FOLDER_PREFIX)).length === 0);
      r.check(tag("ssh ran in the C locale without the agent"), records.every((entry) => entry.env.LC_ALL === "C" && entry.env.SSH_AUTH_SOCK === null));

      await pinnedDestination.remove(stored.ref);
      r.check(tag("remove deletes it"), fs.readdirSync(join(root, "Backup", "run panel")).length === 0);
      await pinnedDestination.remove(stored.ref);
      r.check(tag("and removing it again is not an error"), true);

      // A changed host key: refused, with the reason, for a check and for a backup.
      const impostor = destination({ hostKey: keys.generateSshKeyPair("impostor").publicKey.split(" ").slice(0, 2).join(" ") });
      const refusedCheck = await impostor.test();
      r.check(tag("a changed host key fails Verifica in words"), refusedCheck.ok === false && refusedCheck.code === "HOST_KEY_CHANGED" && /chiave diversa/.test(refusedCheck.message), JSON.stringify(refusedCheck));
      const refusedPut = await rejects(impostor.put(archive, "x.zip"));
      r.check(tag("and a backup to it"), refusedPut instanceof DestinationFailure && refusedPut.problem.code === "HOST_KEY_CHANGED");

      if (!pass.server) {
        setEnv({ FAKE_SFTP_DROP_AFTER: String(256 * 1024) });
        const cut = await rejects(pinnedDestination.put(archive, "cut.zip"));
        r.check(tag("a connection cut mid-upload fails the backup"), cut instanceof DestinationFailure && cut.problem.code === "CONNECTION_LOST", cut ? `${cut.problem?.code}: ${cut.message}` : "no error");
        const after = fs.readdirSync(join(root, "Backup", "run panel"));
        r.check(tag("and leaves no file with the final name"), !after.includes("cut.zip") && after.every((name) => name.endsWith(".partial")), after.join(","));
        for (const name of after) fs.rmSync(join(root, "Backup", "run panel", name));

        setEnv({ FAKE_SFTP_NO_RENAME: "1" });
        const noRename = await destination({ hostKey: serverKey }).test();
        r.check(tag("an account that cannot rename fails Verifica, saying why it matters"), noRename.ok === false && noRename.code === "RENAME" && /rinomina/.test(noRename.message), JSON.stringify(noRename));
        r.check(tag("and its probe does not stay behind"), fs.readdirSync(join(root, "Backup", "run panel")).length === 0, fs.readdirSync(join(root, "Backup", "run panel")).join(","));

        setEnv({ FAKE_SFTP_NO_REMOVE: "1" });
        const noRemove = await destination({ hostKey: serverKey }).test();
        r.check(tag("an account that cannot delete passes with a warning about retention"), noRemove.ok === true && noRemove.warning === true && /retention/.test(noRemove.message), JSON.stringify(noRemove));
        for (const name of fs.readdirSync(join(root, "Backup", "run panel"))) fs.rmSync(join(root, "Backup", "run panel", name));

        setEnv({ FAKE_SFTP_READ_ONLY: "1" });
        const readOnly = await destination({ hostKey: serverKey, folder: "Backup/run panel" }).test();
        r.check(tag("a read-only account fails Verifica on the write"), readOnly.ok === false && readOnly.code === "PERMISSION" && readOnly.message.includes("scrivere"), JSON.stringify(readOnly));

        setEnv({ FAKE_SSH_MODE: "refused" });
        const refused = await destination({ hostKey: serverKey }).test();
        r.check(tag("a refused connection is explained"), refused.ok === false && refused.code === "REFUSED" && refused.message.includes("porta 22"), JSON.stringify(refused));

        setEnv({ FAKE_SSH_MODE: "auth" });
        const auth = await destination({ hostKey: serverKey }).test();
        r.check(tag("a key the server does not know is explained"), auth.ok === false && auth.code === "AUTH" && /authorized_keys/.test(auth.message), JSON.stringify(auth));

        setEnv({ FAKE_SSH_MODE: "nosftp" });
        const noSftp = await destination({ hostKey: serverKey }).test();
        r.check(tag("a server without SFTP is explained"), noSftp.ok === false && noSftp.code === "NO_SFTP", JSON.stringify(noSftp));

        setEnv();
        const noSsh = await sftpDestination({ id: "d2", name: "NAS", type: "sftp" }, { ...config, hostKey: serverKey }, { tmpDir, command: { file: "runpanel-no-such-ssh-binary", args: [] } }).test();
        r.check(tag("no ssh on this server is explained"), noSsh.ok === false && noSsh.code === "SSH_MISSING", JSON.stringify(noSsh));

        const incomplete = await sftpDestination({ id: "d3", name: "NAS", type: "sftp" }, { host: "nas.lan" }, { tmpDir }).test();
        r.check(tag("an incomplete configuration says what is missing"), incomplete.ok === false && /incompleta/.test(incomplete.message));

        const controller = new AbortController();
        setEnv();
        const big = join(scratch, "big.zip");
        fs.writeFileSync(big, crypto.randomBytes(8 * 1024 * 1024));
        const pending = pinnedDestination.put(big, "aborted.zip", { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const aborted = await rejects(pending);
        r.check(tag("an upload can be cancelled"), aborted instanceof DestinationFailure && ["ABORTED", "CONNECTION_LOST"].includes(aborted.problem.code), aborted ? `${aborted.problem?.code}` : "finished");
        r.check(tag("and leaves no final name"), !fs.readdirSync(join(root, "Backup", "run panel")).includes("aborted.zip"));
      }
      setEnv();
    }

    // --- the real ssh, where there is one --------------------------------------------
    //
    // No server to log into, but enough to know that OpenSSH accepts every
    // option the driver gives it (an unknown one would be "Bad configuration
    // option", not the sentences below) and that its real words are recognised.
    const { whichSync } = await loadTs(repoRoot, "services", "toolchain.ts");
    if (whichSync("ssh")) {
      const net = await import("node:net");
      const tmpDir = fresh("real-ssh-tmp");
      const listen = (handler) =>
        new Promise((resolve) => {
          const server = net
            .createServer((socket) => {
              // ssh hangs up abruptly once it has seen enough.
              socket.on("error", () => {});
              handler(socket);
            })
            .listen(0, "127.0.0.1", () => resolve(server));
        });
      const closedPort = await new Promise((resolve) => {
        const probe = net.createServer().listen(0, "127.0.0.1", () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
      });
      const realDestination = (port) =>
        sftpDestination({ id: "real", name: "NAS", type: "sftp" }, { host: "127.0.0.1", port, username: "backup", folder: "x", privateKey: pair.privateKey, hostKey: null }, { tmpDir });

      const refused = await realDestination(closedPort).test();
      r.check("real ssh: every option is accepted, and a closed port is explained", refused.ok === false && refused.code === "REFUSED", JSON.stringify(refused));

      const http = await listen((socket) => socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"));
      const notSsh = await realDestination(http.address().port).test();
      r.check("real ssh: a web server on that port is not taken for SSH", notSsh.ok === false && ["NOT_SSH", "CLOSED"].includes(notSsh.code), JSON.stringify(notSsh));
      http.close();

      const silent = await listen(() => {});
      const started = Date.now();
      const quiet = await sftpDestination(
        { id: "real", name: "NAS", type: "sftp" },
        { host: "127.0.0.1", port: silent.address().port, username: "backup", folder: "x", privateKey: pair.privateKey },
        { tmpDir, connectTimeoutSec: 3 }
      ).test();
      r.check("real ssh: a server that never speaks is given up on", quiet.ok === false && ["TIMEOUT", "CLOSED"].includes(quiet.code), `${JSON.stringify(quiet)} after ${Date.now() - started} ms`);
      silent.close();
      r.check("real ssh: no key folder left behind", fs.readdirSync(tmpDir).filter((name) => name.startsWith(transport.SSH_FOLDER_PREFIX)).length === 0, fs.readdirSync(tmpDir).join(","));
    } else {
      r.note("ssh non installato: le opzioni non sono provate con OpenSSH");
    }

    transport.removeStaleSshFolders(join(scratch, "nothing-here"));
    const staleTmp = fresh("stale");
    fs.mkdirSync(join(staleTmp, `${transport.SSH_FOLDER_PREFIX}left`));
    fs.writeFileSync(join(staleTmp, `${transport.SSH_FOLDER_PREFIX}left`, "id"), "secret");
    fs.writeFileSync(join(staleTmp, "unrelated"), "keep");
    transport.removeStaleSshFolders(staleTmp);
    r.check("the boot sweep removes key folders a crash left", !fs.existsSync(join(staleTmp, `${transport.SSH_FOLDER_PREFIX}left`)) && fs.existsSync(join(staleTmp, "unrelated")));
  } finally {
    for (const key of ["FAKE_SSH_HOST_KEY", "FAKE_SFTP_ROOT", "FAKE_SSH_RECORD", "FAKE_SFTP_SERVER", "FAKE_SSH_MODE", "FAKE_SFTP_DROP_AFTER", "FAKE_SFTP_NO_REMOVE", "FAKE_SFTP_NO_RENAME", "FAKE_SFTP_READ_ONLY"]) {
      delete process.env[key];
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return r.result();
}
