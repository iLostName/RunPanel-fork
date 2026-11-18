import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whichSync } from "../../toolchain";
import { SftpClient, SftpProtocolError, SftpStatusError } from "./sftp-client";
import { HOST_KEY_ALIAS, knownHostsFor, learnedHostKey } from "./ssh-keys";
import { describeProtocol, describeSftpStatus, describeSshExit, type SshContext } from "./ssh-errors";
import { DestinationFailure, problem, type DestinationProblem } from "./problem";

/**
 * One SFTP session: the system's `ssh`, started with the subsystem `sftp`, and
 * the protocol client on its stdin and stdout.
 *
 * Why the system's OpenSSH and not a library: it is the most reviewed SSH
 * implementation there is, it is already on essentially every Linux server,
 * and it is kept current by the operating system's security updates instead of
 * by this repository's lockfile. It speaks every key type and algorithm a
 * modern server wants, and refuses the ones it should.
 *
 * Everything that could come from elsewhere is switched off: no config file
 * (`-F none`), no agent, no password or keyboard prompts (`BatchMode`), no
 * forwarding, only the destination's own key. The host key lives in a
 * known_hosts file written for this session alone, under a fixed alias:
 *
 *  - pinned → `StrictHostKeyChecking=yes`: any other key is refused, and ssh
 *    says so in words `describeSshExit` recognises;
 *  - not yet → `accept-new`: ssh accepts the key the server proved it holds,
 *    writes it into that file, and the caller reads it back to pin it.
 *
 * The private key is written to a 0600 file in a 0700 folder under the data
 * directory, next to the panel's own `.secret`, because `ssh -i` reads a
 * file. It exists only until the session is authenticated — the folder is
 * removed as soon as the SFTP conversation starts — and a crash in between
 * leaves it to the sweep at the next boot (`removeStaleSshFolders`).
 */

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
}

export interface SshCommand {
  file: string;
  /** Arguments before ours: how the unit suite puts a stand-in where `ssh` would be. */
  args: string[];
}

export interface SessionOptions {
  /** Where the private key may be written: the panel's `data/tmp`. */
  tmpDir: string;
  privateKey: string;
  /** `type base64`, or null on first contact. */
  hostKey: string | null;
  folder: string;
  step: SshContext["step"];
  command?: SshCommand;
  connectTimeoutSec?: number;
  /** Silence after which an operation in flight is given up. */
  stallMs?: number;
  signal?: AbortSignal;
}

export const SSH_FOLDER_PREFIX = "rp-ssh-";

/**
 * The default when nothing says otherwise: the `ssh` on the panel's PATH, as
 * the toolchain module rebuilds it — a panel started by systemd gets a narrow
 * one.
 */
function defaultCommand(): SshCommand {
  return { file: whichSync("ssh") ?? "ssh", args: [] };
}

let cachedSsh: { at: number; tool: { installed: boolean; path: string | null; version: string | null } } | null = null;

/** Whether `ssh` is installed and which, for the form; remembered for a minute. */
export async function detectSsh(): Promise<{ installed: boolean; path: string | null; version: string | null }> {
  if (cachedSsh && Date.now() - cachedSsh.at < 60_000) return cachedSsh.tool;
  const file = whichSync("ssh");
  let tool: { installed: boolean; path: string | null; version: string | null } = { installed: false, path: null, version: null };
  if (file) {
    // `ssh -V` prints to stderr: "OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024".
    const version = await new Promise<string | null>((resolve) => {
      let out = "";
      const child = spawn(file, ["-V"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: sshEnvironment() });
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(/OpenSSH_[^\s,]+/.exec(out)?.[0] ?? (out.trim().split("\n")[0] || null)));
      setTimeout(() => child.kill(), 10_000).unref();
    });
    tool = { installed: version !== null, path: file, version };
  }
  cachedSsh = { at: Date.now(), tool };
  return tool;
}

/** stderr kept for the explanation: the end of it is where ssh says why. */
const STDERR_LIMIT = 16 * 1024;

/**
 * A path as a value of an `ssh -o` option.
 *
 * `-o` takes a configuration line, which ssh splits on spaces and expands `%`
 * tokens in, so a data directory with a space would become two files. Quoted,
 * with `%` doubled and forward slashes (which Windows' ssh also reads).
 */
export function sshOptionPath(value: string): string {
  return `"${value.replace(/\\/g, "/").replace(/%/g, "%%")}"`;
}

/** A path is usable by ssh as it is: no quote, dollar or line break to escape. */
function plainPath(value: string): boolean {
  return !/["$\r\n`]/.test(value);
}

/**
 * Everything that reaches ssh's command line, in order.
 *
 * The host comes after `--`, so even a value that slipped past validation and
 * started with `-` would be read as a host and never as an option. The user is
 * the value of `-l`, which getopt takes whatever it looks like.
 */
export function sshArguments(
  endpoint: SshEndpoint,
  files: { identity: string; knownHosts: string },
  opts: { pinned: boolean; connectTimeoutSec: number }
): string[] {
  const option = (value: string) => ["-o", value];
  return [
    "-F",
    "none",
    "-T",
    "-x",
    "-a",
    ...option("BatchMode=yes"),
    ...option("IdentitiesOnly=yes"),
    ...option("IdentityAgent=none"),
    ...option("PubkeyAuthentication=yes"),
    ...option("PasswordAuthentication=no"),
    ...option("KbdInteractiveAuthentication=no"),
    ...option("HostbasedAuthentication=no"),
    ...option("GSSAPIAuthentication=no"),
    ...option(`StrictHostKeyChecking=${opts.pinned ? "yes" : "accept-new"}`),
    ...option(`UserKnownHostsFile=${sshOptionPath(files.knownHosts)}`),
    ...option(`GlobalKnownHostsFile=${sshOptionPath(files.knownHosts)}`),
    ...option(`HostKeyAlias=${HOST_KEY_ALIAS}`),
    ...option("HashKnownHosts=no"),
    ...option("UpdateHostKeys=no"),
    ...option("CheckHostIP=no"),
    ...option("VerifyHostKeyDNS=no"),
    ...option(`ConnectTimeout=${opts.connectTimeoutSec}`),
    ...option("ServerAliveInterval=15"),
    ...option("ServerAliveCountMax=4"),
    ...option("ControlMaster=no"),
    ...option("ControlPath=none"),
    ...option("ForwardAgent=no"),
    ...option("ClearAllForwardings=yes"),
    ...option("PermitLocalCommand=no"),
    ...option("RequestTTY=no"),
    // INFO, ssh's own default: below it, "Connection closed by …" — how a
    // server that is not SSH, or that drops strangers, shows up — goes unsaid.
    ...option("LogLevel=INFO"),
    "-i",
    files.identity.replace(/%/g, "%%"),
    "-p",
    String(endpoint.port),
    "-l",
    endpoint.username,
    "-s",
    "--",
    endpoint.host,
    "sftp",
  ];
}

/**
 * The environment ssh runs with: the panel's, minus anything that would make
 * it use another key or ask a question, and in the C locale, so the system's
 * part of its messages ("Connection refused") reads the same on every server.
 */
export function sshEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: "C", LANG: "C" };
  for (const key of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE", "DISPLAY"]) delete env[key];
  return env;
}

/**
 * At boot, where no session of this panel can be running: key folders a killed
 * process never removed. In the system's temporary folder — used only when the
 * data directory's path cannot be given to ssh — another panel may share it,
 * so only folders older than an hour go: a session's folder lives seconds.
 */
export function removeStaleSshFolders(tmpDir: string): void {
  const sweep = (base: string, olderThanMs: number) => {
    try {
      for (const name of fs.readdirSync(base)) {
        if (!name.startsWith(SSH_FOLDER_PREFIX)) continue;
        const full = path.join(base, name);
        if (olderThanMs > 0 && Date.now() - fs.statSync(full).mtimeMs < olderThanMs) continue;
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      /* no folder yet */
    }
  };
  sweep(tmpDir, 0);
  if (path.resolve(tmpDir) !== path.resolve(os.tmpdir())) sweep(os.tmpdir(), 60 * 60 * 1000);
}

export interface SftpSession {
  client: SftpClient;
  /** On first contact: the host key ssh accepted, to pin. Null when one was pinned already. */
  learnedHostKey: string | null;
  /** Done: the server sees the end of its input, ssh exits. */
  close(): void;
  /** Now, whatever is in flight. */
  kill(): void;
  /** Any error from this session, as the sentence a person acts on. */
  explain(err: unknown): Promise<DestinationProblem>;
}

/**
 * Connect, authenticate and start SFTP; throws a `DestinationFailure` that
 * already says why when any of it fails.
 */
export async function openSftpSession(endpoint: SshEndpoint, opts: SessionOptions): Promise<SftpSession> {
  const connectTimeoutSec = opts.connectTimeoutSec ?? 20;
  const ctx: SshContext = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    folder: opts.folder,
    pinned: Boolean(opts.hostKey),
    step: opts.step,
  };

  /** Cancelled, or out of time: the two read differently. */
  const stopped = (): DestinationProblem => {
    const reason = opts.signal?.reason as { name?: string } | undefined;
    if (reason?.name === "TimeoutError") {
      return problem(
        "TIMEOUT",
        `${endpoint.host} non ha completato l'operazione in tempo.`,
        "Riprova; se succede sempre, controlla la rete tra i due server e il carico di quello di destinazione.",
        null
      );
    }
    return describeProtocol(new SftpProtocolError("ABORTED", "aborted"), ctx);
  };

  if (opts.signal?.aborted) throw new DestinationFailure(stopped());

  const base = plainPath(opts.tmpDir) ? opts.tmpDir : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, SSH_FOLDER_PREFIX));
  let removed = false;
  const removeFolder = () => {
    if (removed) return;
    removed = true;
    fs.rmSync(dir, { recursive: true, force: true });
  };

  const identity = path.join(dir, "id");
  const knownHosts = path.join(dir, "known_hosts");
  let child: ChildProcessWithoutNullStreams;
  try {
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(identity, opts.privateKey.endsWith("\n") ? opts.privateKey : `${opts.privateKey}\n`, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(knownHosts, opts.hostKey ? knownHostsFor(opts.hostKey) : "", { mode: 0o600, flag: "wx" });
    const command = opts.command ?? defaultCommand();
    child = spawn(
      command.file,
      [...command.args, ...sshArguments(endpoint, { identity, knownHosts }, { pinned: Boolean(opts.hostKey), connectTimeoutSec })],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: sshEnvironment() }
    );
  } catch (err) {
    removeFolder();
    throw new DestinationFailure(
      problem("SSH_SPAWN", "Il pannello non riesce ad avviare il programma ssh.", "Controlla che sia installato e che l'utente del pannello possa eseguirlo.", err instanceof Error ? err.message : String(err))
    );
  }

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
  });
  let spawnError: NodeJS.ErrnoException | null = null;
  let exitCode: number | null = null;
  const exited = new Promise<void>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
  });

  const client = new SftpClient({ input: child.stdout, output: child.stdin }, { stallMs: opts.stallMs });
  let connected = false;
  void exited.then(() => {
    removeFolder();
    client.fail(new SftpProtocolError("CLOSED", "ssh è terminato"));
  });

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  const onAbort = () => {
    client.fail(new SftpProtocolError("ABORTED", "Operazione annullata"));
    kill();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  async function explain(err: unknown): Promise<DestinationProblem> {
    if (err instanceof DestinationFailure) return err.problem;
    if (opts.signal?.aborted) return stopped();
    if (err instanceof SftpStatusError) {
      const space = ["write", "close", "fsync", "open"].includes(err.operation) && !client.closedWith
        ? await client.space(opts.folder || ".").catch(() => null)
        : null;
      return describeSftpStatus(err, ctx, space);
    }
    if (err instanceof SftpProtocolError && (err.code === "BANNER" || err.code === "STALLED" || err.code === "ABORTED")) {
      return describeProtocol(err, ctx);
    }
    // The connection went away: ssh's own words, once it has finished saying them.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    if (spawnError || exitCode === 255 || stderr.trim() || !connected) {
      return describeSshExit({ stderr, exitCode, spawnError, connected }, ctx);
    }
    return err instanceof SftpProtocolError
      ? describeProtocol(err, ctx)
      : describeSshExit({ stderr, exitCode, spawnError, connected }, ctx);
  }

  // The handshake has its own clock: ConnectTimeout covers the TCP connection
  // only, and a server can accept it and then say nothing.
  const handshake = setTimeout(() => {
    client.fail(new SftpProtocolError("CLOSED", "handshake timeout"));
    stderr += `\nConnection timed out during handshake`;
    kill();
  }, (connectTimeoutSec + 25) * 1000);
  handshake.unref?.();

  try {
    await client.init();
    connected = true;
  } catch (err) {
    const found = await explain(err);
    kill();
    removeFolder();
    opts.signal?.removeEventListener("abort", onAbort);
    throw new DestinationFailure(found);
  } finally {
    clearTimeout(handshake);
  }

  // Authenticated: the key file has done its job, and the host key ssh
  // accepted is in the file it wrote.
  let learned: string | null = null;
  if (!opts.hostKey) {
    try {
      learned = learnedHostKey(fs.readFileSync(knownHosts, "utf8"));
    } catch {
      learned = null;
    }
  }
  removeFolder();

  return {
    client,
    learnedHostKey: learned,
    close() {
      opts.signal?.removeEventListener("abort", onAbort);
      client.end();
      // A server that does not exit on EOF is not kept waiting for.
      setTimeout(kill, 5000).unref?.();
    },
    kill() {
      opts.signal?.removeEventListener("abort", onAbort);
      kill();
    },
    explain,
  };
}
