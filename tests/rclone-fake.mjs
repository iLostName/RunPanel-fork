/**
 * Stands in for `rclone` in the unit suite, where rclone is not installed.
 *
 * It answers the five commands the destination uses — version, copyto, cat,
 * deletefile, lsjson (with and without --stat) — on a folder, the way rclone
 * does: JSON log lines on stderr with --use-json-log, the documented exit codes
 * (3 directory not found, 4 file not found), a remote that exists only if its
 * RCLONE_CONFIG_<NAME>_TYPE variable does. It refuses a command line without
 * `--` before the paths, and records what it was given (the names of the
 * RCLONE_* variables, never their values) for the suite to inspect.
 *
 * Its settings come from a JSON file named as its first argument — the
 * destination hands rclone an allow-listed environment, so variables of the
 * suite's own would never arrive (which is the point):
 *   root     the folder that plays the remote (required: never the cwd)
 *   record   where to append what it was given
 *   mode     revoked | quota | slow | truncate-cat | nodelete
 *   version  what `rclone version` prints (default 1.68.2)
 */
import fs from "node:fs";
import path from "node:path";

const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const args = process.argv.slice(3);
const sub = args[0];
const log = (msg, level = "error") => process.stderr.write(`${JSON.stringify({ level, msg, source: "fake", time: new Date().toISOString() })}\n`);
const fail = (msg, code) => {
  log(msg);
  process.exit(code);
};
if (!settings.root || !fs.existsSync(settings.root)) fail("fake rclone: no root folder in the settings", 1);

if (settings.record) {
  fs.appendFileSync(
    settings.record,
    `${JSON.stringify({
      args,
      envNames: Object.keys(process.env).filter((key) => key.startsWith("RCLONE_")).sort(),
      rcloneConfig: process.env.RCLONE_CONFIG ?? null,
      lcAll: process.env.LC_ALL ?? null,
    })}\n`
  );
}

if (sub === "version") {
  process.stdout.write(`rclone v${settings.version ?? "1.68.2"}\n- os/version: fake\n- go/version: go1.23\n`);
  process.exit(0);
}

const end = args.indexOf("--");
if (end < 0 || !args.includes("--use-json-log")) fail("fake rclone: expected --use-json-log and -- before the paths", 1);
const flags = args.slice(1, end);
const positional = args.slice(end + 1);
const root = settings.root;
const mode = settings.mode ?? "";

function remotePath(spec) {
  const at = spec.indexOf(":");
  if (at <= 0) fail(`fake rclone: not a remote path: ${spec}`, 1);
  const name = spec.slice(0, at);
  const envName = `RCLONE_CONFIG_${name}_TYPE`.toUpperCase().replace(/-/g, "_");
  if (!process.env[envName]) fail(`Failed to create file system for "${spec}": didn't find section in config file`, 1);
  if (mode === "revoked") {
    fail(
      `Failed to create file system for "${spec}": couldn't fetch token - maybe it has expired? - refresh with "rclone config reconnect ${name}:": oauth2: cannot fetch token: 400 Bad Request\nResponse: {"error":"invalid_grant","error_description":"Token has been expired or revoked."}`,
      1
    );
  }
  return path.join(root, ...spec.slice(at + 1).split("/").filter(Boolean));
}

switch (sub) {
  case "copyto": {
    const [src, dst] = positional;
    const target = remotePath(dst);
    if (mode === "quota") fail("Failed to copy: googleapi: Error 403: The user's Drive storage quota has been exceeded., storageQuotaExceeded", 7);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (mode === "slow") {
      setTimeout(() => {
        fs.copyFileSync(src, target);
        process.exit(0);
      }, 10_000);
      break;
    }
    fs.copyFileSync(src, target);
    process.exit(0);
    break;
  }
  case "cat": {
    const target = remotePath(positional[0]);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) fail("Failed to cat: directory not found", 3);
    const data = fs.readFileSync(target);
    if (mode === "truncate-cat") {
      process.stdout.write(data.subarray(0, Math.floor(data.length / 2)), () => fail("Failed to cat: unexpected EOF", 5));
      break;
    }
    process.stdout.write(data, () => process.exit(0));
    break;
  }
  case "deletefile": {
    const target = remotePath(positional[0]);
    if (mode === "nodelete") fail("Failed to deletefile: googleapi: Error 403: The user does not have sufficient permissions for this file., insufficientFilePermissions", 1);
    if (!fs.existsSync(target)) fail("Failed to deletefile: object not found", 4);
    fs.rmSync(target);
    process.exit(0);
    break;
  }
  case "lsjson": {
    const target = remotePath(positional[0]);
    if (flags.includes("--stat")) {
      if (!fs.existsSync(target)) fail("error in ListJSON: directory not found", 3);
      const stat = fs.statSync(target);
      process.stdout.write(JSON.stringify({ Path: path.basename(target), Name: path.basename(target), Size: stat.isDirectory() ? -1 : stat.size, IsDir: stat.isDirectory() }));
      process.exit(0);
    }
    if (!fs.existsSync(target)) fail("error in ListJSON: directory not found", 3);
    const files = fs.readdirSync(target).filter((name) => fs.statSync(path.join(target, name)).isFile());
    process.stdout.write(JSON.stringify(files.map((name) => ({ Path: name, Name: name, Size: fs.statSync(path.join(target, name)).size, IsDir: false }))));
    process.exit(0);
    break;
  }
  default:
    fail(`unknown command "${sub}" for "rclone"`, 1);
}
