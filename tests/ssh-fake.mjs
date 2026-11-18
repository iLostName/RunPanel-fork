/**
 * Stands in for `ssh` in the SFTP unit suite, where no SSH server can be
 * started without installing one.
 *
 * It checks the command line the driver builds (the host after `--`, then
 * `sftp`; `-s`; the key file readable and in OpenSSH's format), plays the part
 * of ssh's host key handling against the known_hosts file it is given — accept
 * a new key under `accept-new`, refuse a different one with ssh's own words —
 * and then serves SFTP: OpenSSH's `sftp-server` when FAKE_SFTP_SERVER names
 * one, the folder-backed fake otherwise.
 *
 * FAKE_SSH_MODE=refused|auth|nosftp makes it fail the way ssh does.
 * FAKE_SSH_RECORD appends what it was given, for the suite to inspect.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-o" && args[i + 1].startsWith(`${name}=`)) return args[i + 1].slice(name.length + 1);
  }
  return null;
};
const unquote = (value) => (value ?? "").replace(/^"|"$/g, "").replace(/%%/g, "%");
const fail = (message, code = 255) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const end = args.indexOf("--");
if (end < 1 || args[end - 1] !== "-s" || args[end + 2] !== "sftp" || args.length !== end + 3) {
  fail("fake ssh: unexpected command line", 2);
}
const host = args[end + 1];
const user = args[args.indexOf("-l") + 1];
const port = args[args.indexOf("-p") + 1];
const identity = args[args.indexOf("-i") + 1].replace(/%%/g, "%");
const knownHosts = unquote(option("UserKnownHostsFile"));
const strict = option("StrictHostKeyChecking");

if (process.env.FAKE_SSH_RECORD) {
  fs.appendFileSync(process.env.FAKE_SSH_RECORD, `${JSON.stringify({ args, identity, knownHosts, env: { LC_ALL: process.env.LC_ALL, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? null } })}\n`);
}

const mode = process.env.FAKE_SSH_MODE ?? "ok";
if (mode === "refused") fail(`ssh: connect to host ${host} port ${port}: Connection refused`);

let key = "";
try {
  key = fs.readFileSync(identity, "utf8");
} catch {
  fail(`Warning: Identity file ${identity} not accessible: No such file or directory.\n${user}@${host}: Permission denied (publickey).`);
}
if (!key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) fail(`Load key "${identity}": invalid format`);

const serverKey = process.env.FAKE_SSH_HOST_KEY ?? "";
const known = fs.readFileSync(knownHosts, "utf8").trim();
if (known) {
  const [, type, data] = known.split(/\s+/);
  if (`${type} ${data}` !== serverKey) {
    fail(
      [
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
        "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
        "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
        "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
        `Host key for runpanel-destination has changed and you have requested strict checking.`,
        "Host key verification failed.",
      ].join("\n")
    );
  }
} else if (strict === "accept-new") {
  fs.appendFileSync(knownHosts, `runpanel-destination ${serverKey}\n`);
} else {
  fail("No ED25519 host key is known for runpanel-destination and you have requested strict checking.\nHost key verification failed.");
}

if (mode === "auth") fail(`${user}@${host}: Permission denied (publickey).`);
if (mode === "nosftp") fail("subsystem request failed on channel 0");

const root = process.env.FAKE_SFTP_ROOT ?? process.cwd();
if (process.env.FAKE_SFTP_SERVER) {
  const server = spawn(process.env.FAKE_SFTP_SERVER, [], { cwd: root, stdio: ["pipe", "pipe", "inherit"] });
  process.stdin.pipe(server.stdin);
  server.stdout.pipe(process.stdout);
  server.on("close", (code) => process.exit(code ?? 0));
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const { serveSftp, knobsFromEnv } = await import(pathToFileURL(join(here, "sftp-fake.mjs")).href);
  serveSftp({
    input: process.stdin,
    output: process.stdout,
    root,
    knobs: knobsFromEnv(),
    onDrop: () => setTimeout(() => process.exit(255), 10),
  });
}
