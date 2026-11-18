import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { DEFAULT_REMOTE_FOLDER, joinRemote } from "@/lib/backup-remote";
import {
  RCLONE_PROVIDER_LABEL,
  accessTokenOf,
  parseRcloneSections,
  rclonePath,
  rcloneRemoteEnv,
  rcloneSecrets,
  type RcloneConfig,
} from "@/lib/rclone-config";
import { toolchainPath, whichSync } from "../../toolchain";
import {
  MIN_RCLONE,
  RCLONE_INSTALL_HINT,
  describeRcloneFailure,
  parseRcloneVersion,
  rcloneTooOld,
  type RcloneContext,
  type RcloneStep,
} from "./rclone-errors";
import { DestinationFailure, failedCheck, problem } from "./problem";
import type { Destination, DestinationCheck } from "../types";

/**
 * Backups through rclone: Google Drive, OneDrive, Dropbox, Mega, Box, pCloud
 * and the seventy-odd other services rclone speaks — one destination type for
 * all of them, used only when the `rclone` program is installed. The panel
 * never installs it: it says how, and stops.
 *
 * The remote is defined by environment variables built from the stored,
 * encrypted config, and `RCLONE_CONFIG` points at the null device, which
 * rclone treats as "keep the configuration in memory": no `rclone.conf` with a
 * token in it is ever written. A refreshed access token lives as long as the
 * process; the refresh token, which is what is stored, keeps working as long
 * as the destination is used (see docs/en/backups.md for the services that
 * expire an unused one).
 *
 * Four commands, each its own process: `copyto` with the staged archive,
 * `cat` to stream it back, `deletefile`, and `lsjson --stat` for its size.
 * rclone checks size and, where the service has one, hash after every upload,
 * and the services rclone is used for here commit a file only once it is
 * complete — a cut upload never shows up as a finished archive. The panel
 * still asks the size back afterwards, like it does with S3.
 */

export interface RcloneCommand {
  file: string;
  /** Arguments before ours: how the unit suite puts a stand-in where rclone would be. */
  args: string[];
}

export interface RcloneDeps {
  /** Where the probe file of "Verifica" is written: the panel's `data/tmp`. */
  tmpDir: string;
  command?: RcloneCommand;
}

export interface RcloneTool {
  installed: boolean;
  /** Where it was found, for the form. */
  path: string | null;
  version: string | null;
  supported: boolean;
  minVersion: string;
}

/** rclone keeps talking for a while on a failure; its end is where the reason is. */
const STDERR_LIMIT = 32 * 1024;
const STAT_LIMIT = 64 * 1024;
/** A check is a few small commands. */
const CHECK_STEP_MS = 90_000;
const SHORT_MS = 90_000;

/**
 * Flags every command gets: JSON log lines, so a message is read without
 * guessing where it starts; never a prompt; and the network clocks rclone
 * already has — 30 seconds to connect, 5 minutes of silence in a transfer —
 * stated, not left to a version's defaults.
 */
const COMMON_FLAGS = ["--use-json-log", "--ask-password=false", "--contimeout", "30s", "--timeout", "5m", "--low-level-retries", "10"];

/**
 * The environment rclone runs with: an allow-list of the panel's (the proxy
 * settings and the certificate store matter), never any `RCLONE_*` it
 * inherited, the configuration in memory, and the remote's variables.
 */
export function rcloneEnvironment(remoteEnv: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = [
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (base[key] !== undefined) env[key] = base[key];
  env.PATH = toolchainPath(base.PATH ?? base.Path ?? "");
  env.LC_ALL = "C";
  env.LANG = "C";
  env.RCLONE_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";
  return { ...env, ...remoteEnv };
}

/** `[subcommand, flags…, "--", positional…]`: a positional that starts with `-` stays a positional. */
export function rcloneArgs(subcommand: string, positional: string[], flags: string[] = []): string[] {
  return [subcommand, ...COMMON_FLAGS, ...flags, "--", ...positional];
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
  timedOut: boolean;
}

function run(command: RcloneCommand, args: string[], env: NodeJS.ProcessEnv, opts: { timeoutMs: number | null; signal?: AbortSignal; stdoutLimit?: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | null = null;
    let timedOut = false;
    const child = spawn(command.file, [...command.args, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < (opts.stdoutLimit ?? STAT_LIMIT)) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
    });
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ exitCode: code, stdout, stderr, spawnError, timedOut });
    });
  });
}

let cachedTool: { at: number; tool: RcloneTool; command: RcloneCommand | null } | null = null;

/**
 * Whether rclone is here, where, and which version — asked of the program
 * itself, and remembered for a minute so a page that shows it does not start
 * a process at every render.
 */
export async function detectRclone(opts: { command?: RcloneCommand; fresh?: boolean } = {}): Promise<{ tool: RcloneTool; command: RcloneCommand | null }> {
  if (!opts.command && !opts.fresh && cachedTool && Date.now() - cachedTool.at < 60_000) {
    return { tool: cachedTool.tool, command: cachedTool.command };
  }
  const minVersion = `${MIN_RCLONE.major}.${MIN_RCLONE.minor}`;
  const found = opts.command ?? (() => {
    const file = whichSync("rclone");
    return file ? { file, args: [] } : null;
  })();
  let tool: RcloneTool = { installed: false, path: null, version: null, supported: false, minVersion };
  if (found) {
    const result = await run(found, ["version"], rcloneEnvironment({}), { timeoutMs: 15_000 });
    const version = result.exitCode === 0 ? parseRcloneVersion(result.stdout) : null;
    if (!result.spawnError) {
      tool = {
        installed: true,
        path: found.file,
        version: version?.text ?? null,
        supported: version ? !rcloneTooOld(version) : false,
        minVersion,
      };
    }
  }
  if (!opts.command) cachedTool = { at: Date.now(), tool, command: tool.installed ? found : null };
  return { tool, command: tool.installed ? found : null };
}

/**
 * Which OneDrive the token belongs to, asked of Microsoft Graph with the
 * access token rclone authorize just printed.
 *
 * rclone needs `drive_id` and `drive_type` and finds them only in its
 * interactive setup; here they are looked up once, when the token is pasted,
 * and stored with it. The access token lasts an hour: an old paste is said to
 * be old, not mistaken for a wrong one.
 */
export async function lookupOneDrive(token: string, fetchImpl: typeof fetch = fetch): Promise<{ driveId: string; driveType: string } | { error: string }> {
  const access = accessTokenOf(token);
  if (!access) return { error: "Il token non contiene un access_token: rilancia rclone authorize \"onedrive\"" };
  let res: Response;
  try {
    res = await fetchImpl("https://graph.microsoft.com/v1.0/me/drive", {
      headers: { authorization: `Bearer ${access}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { error: "Non riesco a raggiungere Microsoft per sapere quale unità OneDrive usare: controlla la connessione del server e riprova." };
  }
  if (res.status === 401) {
    return { error: "Il token incollato è già scaduto (vale un'ora) o non è di OneDrive: rilancia rclone authorize \"onedrive\" e incollalo subito." };
  }
  if (!res.ok) return { error: `Microsoft non ha detto quale unità OneDrive usare (HTTP ${res.status}): riprova tra poco.` };
  const body = (await res.json().catch(() => null)) as { id?: unknown; driveType?: unknown } | null;
  const driveId = typeof body?.id === "string" ? body.id : "";
  const driveType = typeof body?.driveType === "string" ? body.driveType : "";
  if (!driveId || !["personal", "business", "documentLibrary"].includes(driveType)) {
    return { error: "Microsoft ha risposto senza un'unità OneDrive utilizzabile per questo account." };
  }
  return { driveId, driveType };
}

/** "Google Drive", or "rclone («nas», sftp)" for a pasted remote. */
export function rcloneServiceLabel(config: Partial<RcloneConfig>): string {
  if (config.provider && config.provider !== "expert") return RCLONE_PROVIDER_LABEL[config.provider];
  const parsed = parseRcloneSections(config.sections ?? "");
  if ("error" in parsed) return "rclone";
  const remote = config.remote || parsed.sections[parsed.sections.length - 1].name;
  const type = parsed.sections.find((section) => section.name === remote)?.options.type;
  return type ? `rclone («${remote}», ${type})` : `rclone («${remote}»)`;
}

export function rcloneDestination(row: { id: string; name: string; type: string }, raw: Record<string, unknown>, deps: RcloneDeps): Destination {
  const config = raw as unknown as Partial<RcloneConfig>;
  const folder = typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER;
  const service = rcloneServiceLabel(config);
  const secrets = rcloneSecrets(config);
  const ctx = (step: RcloneStep): RcloneContext => ({
    service,
    folder,
    step,
    authorize: config.provider && config.provider !== "expert" ? `rclone authorize "${config.provider}"` : null,
    secrets,
  });

  /** The program, its environment and the remote's name, or the sentence that says what is missing. */
  async function prepare(): Promise<{ command: RcloneCommand; env: NodeJS.ProcessEnv; remote: string; version: string | null }> {
    const { tool, command } = await detectRclone({ command: deps.command });
    if (!tool.installed || !command) throw new DestinationFailure(problem("RCLONE_MISSING", "rclone non è installato su questo server.", RCLONE_INSTALL_HINT, null));
    if (!tool.supported) {
      throw new DestinationFailure(
        problem(
          "RCLONE_TOO_OLD",
          `La versione di rclone installata (${tool.version ?? "sconosciuta"}) è troppo vecchia: serve almeno la ${tool.minVersion}.`,
          `Le distribuzioni ne hanno spesso una vecchia. ${RCLONE_INSTALL_HINT}`,
          tool.version
        )
      );
    }
    const remote = rcloneRemoteEnv(config);
    if ("error" in remote) {
      throw new DestinationFailure(problem("CONFIG", `Configurazione di ${service} incompleta: ${remote.error}.`, "Modifica la destinazione e completala.", null));
    }
    return { command, env: rcloneEnvironment(remote.env), remote: remote.remote, version: tool.version };
  }

  async function exec(build: (remote: string) => string[], opts: { timeoutMs: number | null; signal?: AbortSignal }): Promise<RunResult> {
    const prepared = await prepare();
    return run(prepared.command, build(prepared.remote), prepared.env, opts);
  }

  function failure(step: RcloneStep, result: RunResult, signal?: AbortSignal): DestinationFailure {
    if (signal?.aborted) {
      return new DestinationFailure(problem("ABORTED", "L'operazione è stata annullata prima di finire.", "Riprova quando vuoi.", null));
    }
    if (result.timedOut) {
      return new DestinationFailure(problem("TIMEOUT", `${service} non ha completato l'operazione in tempo.`, "Riprova; se succede sempre, controlla la connessione di questo server.", null));
    }
    return new DestinationFailure(describeRcloneFailure(result, ctx(step)));
  }

  const notFound = (result: RunResult) =>
    result.exitCode === 3 || result.exitCode === 4 || /directory not found|object not found|file not found/i.test(result.stderr);

  async function statRef(ref: string): Promise<{ bytes: number; exists: boolean }> {
    const result = await exec((remote) => rcloneArgs("lsjson", [rclonePath(remote, ref)], ["--stat"]), { timeoutMs: SHORT_MS });
    if (result.exitCode === 0) {
      try {
        const entry = JSON.parse(result.stdout) as { Size?: number; IsDir?: boolean };
        if (entry.IsDir) return { bytes: 0, exists: false };
        return { bytes: typeof entry.Size === "number" ? entry.Size : 0, exists: true };
      } catch {
        throw new DestinationFailure(problem("RCLONE_OUTPUT", "rclone ha risposto in un modo che il pannello non capisce.", "Aggiorna rclone all'ultima versione.", result.stdout.slice(0, 200)));
      }
    }
    if (notFound(result) && !result.spawnError) return { bytes: 0, exists: false };
    throw failure("stat", result);
  }

  /** `cat` as a stream, resolved once the first bytes arrive — or rejected with the reason when none do. */
  async function catStream(ref: string, signal?: AbortSignal): Promise<Readable> {
    const prepared = await prepare();
    const args = [...prepared.command.args, ...rcloneArgs("cat", [rclonePath(prepared.remote, ref)])];
    return new Promise<Readable>((resolve, reject) => {
      const child = spawn(prepared.command.file, args, { env: prepared.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const out = new PassThrough();
      let stderr = "";
      let started = false;
      let spawnError: NodeJS.ErrnoException | null = null;
      const kill = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      };
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT);
      });
      child.stdout.once("data", (first: Buffer) => {
        started = true;
        out.write(first);
        child.stdout.pipe(out, { end: false });
        resolve(out);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        spawnError = err;
      });
      child.on("close", (code) => {
        signal?.removeEventListener("abort", kill);
        const result: RunResult = { exitCode: code, stdout: "", stderr, spawnError, timedOut: false };
        if (!started) {
          if (code === 0) {
            out.end();
            resolve(out);
          } else {
            reject(failure("download", result, signal));
          }
          return;
        }
        // Ended only on a clean exit: a stream cut by a failure must fail, not
        // look like a shorter archive.
        if (code === 0) out.end();
        else out.destroy(failure("download", result, signal));
      });
      // A reader that stops early (a cancelled download) stops rclone too.
      out.on("close", kill);
      signal?.addEventListener("abort", kill, { once: true });
    });
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath: string, fileName: string, opts: { signal?: AbortSignal } = {}) {
      const { size } = await fs.promises.stat(localPath);
      const ref = joinRemote(folder, fileName);
      const result = await exec((remote) => rcloneArgs("copyto", [localPath, rclonePath(remote, ref)]), { timeoutMs: null, signal: opts.signal });
      if (result.exitCode !== 0) throw failure("upload", result, opts.signal);
      // What the service kept, asked back: a mismatch is an archive nobody can restore.
      const kept = await statRef(ref).catch(() => null);
      if (kept?.exists && kept.bytes !== size) {
        await exec((remote) => rcloneArgs("deletefile", [rclonePath(remote, ref)]), { timeoutMs: SHORT_MS }).catch(() => null);
        throw new DestinationFailure(
          problem(
            "SIZE_MISMATCH",
            `${service} ha conservato ${kept.bytes} byte invece di ${size}: il caricamento è incompleto.`,
            "Riprova il backup.",
            null
          )
        );
      }
      return { ref, bytes: size };
    },

    async remove(ref: string) {
      const result = await exec((remote) => rcloneArgs("deletefile", [rclonePath(remote, ref)]), { timeoutMs: SHORT_MS });
      // Already gone is the state that was wanted.
      if (result.exitCode !== 0 && !(notFound(result) && !result.spawnError)) throw failure("delete", result);
    },

    async open(ref: string, opts: { signal?: AbortSignal } = {}) {
      return catStream(ref, opts.signal);
    },

    stat: statRef,

    /**
     * The folder listed, then a probe written with `copyto`, read back with
     * `cat` and deleted with `deletefile`: the same four commands a backup
     * and a restore use.
     */
    async test(): Promise<DestinationCheck> {
      let prepared: Awaited<ReturnType<typeof prepare>>;
      try {
        prepared = await prepare();
      } catch (err) {
        return err instanceof DestinationFailure ? failedCheck("", err.problem) : { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      const where = folder ? `in «${folder}»` : "nella cartella principale";

      const listed = await exec((remote) => rcloneArgs("lsjson", [rclonePath(remote, folder)], ["--max-depth", "1", "--files-only"]), { timeoutMs: CHECK_STEP_MS });
      let files = 0;
      if (listed.exitCode === 0) {
        try {
          files = (JSON.parse(listed.stdout) as unknown[]).length;
        } catch {
          files = 0;
        }
      } else if (!(notFound(listed) && !listed.spawnError)) {
        return failedCheck("", failure("list", listed).problem);
      }

      const marker = `runpanel ${Date.now()}`;
      const ref = joinRemote(folder, `.runpanel-write-test-${Date.now()}`);
      fs.mkdirSync(deps.tmpDir, { recursive: true });
      const probe = path.join(deps.tmpDir, `rp-rclone-probe-${crypto.randomBytes(6).toString("hex")}`);
      try {
        fs.writeFileSync(probe, marker, { mode: 0o600 });
        const written = await exec((remote) => rcloneArgs("copyto", [probe, rclonePath(remote, ref)]), { timeoutMs: CHECK_STEP_MS });
        if (written.exitCode !== 0) return failedCheck("", failure("upload", written).problem);
      } finally {
        fs.rmSync(probe, { force: true });
      }

      try {
        const signal = AbortSignal.timeout(CHECK_STEP_MS);
        const stream = await catStream(ref, signal);
        const parts: Buffer[] = [];
        for await (const part of stream) parts.push(part as Buffer);
        if (Buffer.concat(parts).toString("utf8") !== marker) {
          await exec((remote) => rcloneArgs("deletefile", [rclonePath(remote, ref)]), { timeoutMs: SHORT_MS }).catch(() => null);
          return { ok: false, message: `La scrittura su ${service} funziona, ma il file di prova si rilegge diverso.` };
        }
      } catch (err) {
        await exec((remote) => rcloneArgs("deletefile", [rclonePath(remote, ref)]), { timeoutMs: SHORT_MS }).catch(() => null);
        const found = err instanceof DestinationFailure ? err.problem : problem("RCLONE_ERROR", String(err), "", null);
        return failedCheck("La scrittura funziona, ma la lettura no, e senza lettura non si può ripristinare. ", found);
      }

      const versionNote = prepared.version ? ` (rclone ${prepared.version})` : "";
      const filesNote = files > 0 ? ` Nella cartella ci sono già ${files} file.` : "";
      const removed = await exec((remote) => rcloneArgs("deletefile", [rclonePath(remote, ref)]), { timeoutMs: CHECK_STEP_MS });
      if (removed.exitCode !== 0) {
        const found = failure("delete", removed).problem;
        return {
          ok: true,
          warning: true,
          message:
            `${service} raggiungibile${versionNote}: scrittura e lettura riuscite ${where}, ma l'eliminazione è stata rifiutata. ` +
            "La retention non potrà togliere gli archivi vecchi: cancellali tu dal servizio, o dai il permesso di eliminare." +
            filesNote,
          code: found.code,
          detail: found.detail,
        };
      }
      return { ok: true, message: `${service} raggiungibile${versionNote}: scrittura, lettura ed eliminazione riuscite ${where}.${filesNote}` };
    },
  };
}

