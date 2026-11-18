import crypto from "node:crypto";
import fs from "node:fs";
import type { Readable } from "node:stream";
import { DEFAULT_REMOTE_FOLDER, joinRemote, partialName } from "@/lib/backup-remote";
import { formatBytes } from "@/lib/format";
import { FX, OPEN_FLAGS, isStatus } from "./sftp-client";
import { fingerprintOf } from "./ssh-keys";
import { openSftpSession, type SessionOptions, type SftpSession, type SshCommand } from "./ssh-transport";
import { DestinationFailure, failedCheck } from "./problem";
import { progressLog } from "./progress";
import type { Destination, DestinationCheck, PutOptions } from "../types";

/**
 * Backups to a server over SFTP: a NAS (Synology, QNAP), a Hetzner Storage
 * Box, a second VPS.
 *
 * The panel authenticates with a key pair of its own, made for this
 * destination when it was created (ssh-keys.ts); the person adds the public
 * half to the server once. The server's host key is trusted on first use and
 * pinned from then on: "Verifica" shows its fingerprint, and a server that
 * later presents a different one is refused, in words.
 *
 * An archive is written under a provisional name (`.<name>.<random>.partial`),
 * flushed, checked for size, and only then renamed to its real name, so a
 * connection cut halfway never leaves a file that looks like a finished
 * archive — a restore that picked one up would fail halfway through the
 * database it was replacing. Both directions stream: no archive is ever held
 * in memory, whatever its size.
 *
 * No timeout on uploads and downloads, which take as long as the archive
 * needs; a connection that dies is caught by ssh's keepalives, and a server
 * that stops answering by the client's silence watchdog. The short operations
 * have a clock.
 */

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  /** Relative to the login folder, or absolute. Empty: the login folder itself. */
  folder: string;
  privateKey: string;
  /** The `authorized_keys` line, kept to show it again when editing. */
  publicKey?: string;
  /** `type base64`, pinned on first use. */
  hostKey?: string | null;
}

export interface SftpDeps {
  /** The panel's `data/tmp`, where the key waits for ssh to read it. */
  tmpDir: string;
  /** Persists a host key accepted on first contact. Absent for a check of an unsaved form. */
  pinHostKey?: (key: string) => Promise<void>;
  command?: SshCommand;
  stallMs?: number;
  /** Seconds for the connection and the handshake; 20 unless a test is in a hurry. */
  connectTimeoutSec?: number;
}

/** Enough to connect, write, read back and delete a few bytes. */
const CHECK_TIMEOUT_MS = 90_000;
/** A stat or a delete: one connection, one request. */
const SHORT_TIMEOUT_MS = 60_000;

function isValid(config: Partial<SftpConfig>): config is SftpConfig {
  return Boolean(config.host && config.port && config.username && config.privateKey);
}

export function sftpFolder(config: Partial<SftpConfig>): string {
  return typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER;
}

export function sftpDestination(
  row: { id: string; name: string; type: string },
  raw: Record<string, unknown>,
  deps: SftpDeps
): Destination {
  const config = raw as unknown as Partial<SftpConfig>;
  let pinned: string | null = typeof config.hostKey === "string" && config.hostKey ? config.hostKey : null;

  function requireConfig(): SftpConfig {
    if (!isValid(config)) {
      throw new Error("Configurazione SFTP incompleta: servono server, porta, utente e la chiave. Modifica la destinazione e completala.");
    }
    return config;
  }

  async function connect(step: SessionOptions["step"], signal?: AbortSignal): Promise<SftpSession> {
    const cfg = requireConfig();
    const session = await openSftpSession(
      { host: cfg.host, port: cfg.port, username: cfg.username },
      {
        tmpDir: deps.tmpDir,
        privateKey: cfg.privateKey,
        hostKey: pinned,
        folder: sftpFolder(cfg),
        step,
        command: deps.command,
        stallMs: deps.stallMs,
        connectTimeoutSec: deps.connectTimeoutSec,
        signal,
      }
    );
    if (session.learnedHostKey && deps.pinHostKey) {
      // Pinned as soon as the server proved it holds the key and accepted
      // ours: from the next connection on, any other key is refused.
      await deps.pinHostKey(session.learnedHostKey).catch(() => {});
      pinned = session.learnedHostKey;
    }
    return session;
  }

  /** Runs `work` in one session with a clock, and turns any failure into the sentence that explains it. */
  async function withSession<T>(step: SessionOptions["step"], timeoutMs: number | null, work: (session: SftpSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(Boolean) as AbortSignal[];
    const combined = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    const session = await connect(step, combined);
    try {
      return await work(session);
    } catch (err) {
      throw new DestinationFailure(await session.explain(err));
    } finally {
      session.close();
    }
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath: string, fileName: string, opts: PutOptions = {}) {
      const cfg = requireConfig();
      // The staged archive is read, never moved: the runner hands the same file
      // to every destination of the policy and removes it at the end.
      const { size } = await fs.promises.stat(localPath);
      const progress = opts.log ? progressLog(opts.log, size) : undefined;
      const folder = sftpFolder(cfg);
      const ref = joinRemote(folder, fileName);
      const provisional = partialName(ref, crypto.randomBytes(4).toString("hex"));

      return withSession(
        "upload",
        null,
        async (session) => {
          await session.client.ensureDir(folder);
          let bytes: number;
          try {
            bytes = await session.client.upload(localPath, provisional, { signal: opts.signal, onProgress: progress });
            const kept = await session.client.stat(provisional);
            if (kept.size !== null && kept.size !== bytes) {
              throw new DestinationFailure({
                code: "SIZE_MISMATCH",
                cause: `Il server ha conservato ${kept.size} byte invece di ${bytes}: il caricamento è incompleto.`,
                fix: "Riprova il backup; se succede ancora, controlla lo spazio e il disco del server.",
                detail: null,
              });
            }
            await session.client.rename(provisional, ref);
          } catch (err) {
            // Best effort, on the same connection when it is still there. When
            // it is not, the provisional name is what stays behind — never the
            // real one.
            await session.client.remove(provisional).catch(() => {});
            throw err;
          }
          return { ref, bytes };
        },
        opts.signal
      );
    },

    async remove(ref: string) {
      await withSession("delete", SHORT_TIMEOUT_MS, async (session) => {
        try {
          await session.client.remove(ref);
        } catch (err) {
          // Already gone is the state that was wanted.
          if (!isStatus(err, FX.NO_SUCH_FILE)) throw err;
        }
      });
    },

    async open(ref: string, opts: { signal?: AbortSignal } = {}): Promise<Readable> {
      const session = await connect("download", opts.signal);
      try {
        return await session.client.download(ref, { onEnd: () => session.close() });
      } catch (err) {
        const found = await session.explain(err);
        session.close();
        throw new DestinationFailure(found);
      }
    },

    async stat(ref: string) {
      return withSession("stat", SHORT_TIMEOUT_MS, async (session) => {
        try {
          const found = await session.client.stat(ref);
          return { bytes: found.size ?? 0, exists: true };
        } catch (err) {
          if (isStatus(err, FX.NO_SUCH_FILE)) return { bytes: 0, exists: false };
          throw err;
        }
      });
    },

    /**
     * The whole path of a backup, with a few bytes: connect, create the
     * folder, write under a provisional name, rename, read back, delete.
     *
     * The rename is in there because an upload depends on it, and it is
     * exactly the permission a carefully restricted account sometimes lacks.
     */
    /**
     * The same server, account and folder is the same place: a policy refuses
     * two copies there. The user is part of it, because a relative folder is
     * relative to that user's home, and a chrooted account sees its own root.
     */
    location() {
      return `sftp:${String(config.username ?? "")}@${String(config.host ?? "").toLowerCase()}:${config.port ?? 22}:${sftpFolder(config)}`;
    },

    async test(): Promise<DestinationCheck> {
      let cfg: SftpConfig;
      try {
        cfg = requireConfig();
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Configurazione non valida" };
      }
      const folder = sftpFolder(cfg);
      const name = `.runpanel-write-test-${Date.now()}`;
      const ref = joinRemote(folder, name);
      const provisional = partialName(ref, crypto.randomBytes(4).toString("hex"));
      const marker = Buffer.from(`runpanel ${Date.now()}`);
      const where = folder ? `«${folder}»` : "nella cartella iniziale";

      let session: SftpSession;
      const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
      try {
        session = await connect("check", signal);
      } catch (err) {
        return err instanceof DestinationFailure ? failedCheck("", err.problem) : { ok: false, message: err instanceof Error ? err.message : String(err) };
      }

      const learned = session.learnedHostKey;
      const fingerprint = fingerprintOf(learned ?? pinned ?? "");
      const pinNote = fingerprint
        ? learned
          ? ` Impronta del server: ${fingerprint}, salvata: d'ora in poi un server con un'impronta diversa verrà rifiutato.`
          : ` Impronta del server: ${fingerprint}, la stessa salvata alla prima connessione.`
        : "";
      const extra = learned ? { learned: { hostKey: learned } } : {};
      const step = async <T,>(prefix: string, work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (err) {
          throw { prefix, problem: await session.explain(err) };
        }
      };

      try {
        await step("", () => session.client.ensureDir(folder));
        await step("", async () => {
          const handle = await session.client.open(provisional, OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | OPEN_FLAGS.TRUNC, 0o600);
          await session.client.write(handle, 0, marker, provisional);
          await session.client.close(handle, provisional);
        });
        await step("La scrittura funziona, ma non la rinomina, che serve a ogni caricamento. ", () => session.client.rename(provisional, ref));
        await step("La scrittura funziona, ma la lettura no, e senza lettura non si può ripristinare. ", async () => {
          const handle = await session.client.open(ref, OPEN_FLAGS.READ);
          const back = await session.client.read(handle, 0, marker.length + 16, ref);
          await session.client.close(handle, ref);
          if (!back || !back.equals(marker)) {
            throw new DestinationFailure({
              code: "READ_MISMATCH",
              cause: "Il file di prova si rilegge diverso da come è stato scritto.",
              fix: "Il disco del server potrebbe avere un problema: controllalo prima di affidargli i backup.",
              detail: null,
            });
          }
        });
      } catch (thrown) {
        await session.client.remove(provisional).catch(() => {});
        session.close();
        const failure = thrown as { prefix?: string; problem?: DestinationFailure["problem"] };
        if (failure.problem) return { ...failedCheck(failure.prefix ?? "", failure.problem), ...extra };
        return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown), ...extra };
      }

      const space = await session.client.space(folder || ".").catch(() => null);
      const spaceNote = space ? ` Spazio libero: ${formatBytes(space.available)}.` : "";

      try {
        await session.client.remove(ref);
      } catch (err) {
        const found = await session.explain(err);
        session.close();
        return {
          ok: true,
          warning: true,
          message:
            `${cfg.host} raggiungibile: scrittura e lettura riuscite in ${where}, ma l'eliminazione è stata rifiutata. ` +
            "La retention non potrà togliere gli archivi vecchi: dai all'utente anche il permesso di eliminare, o cancellali tu dal server." +
            spaceNote +
            pinNote,
          code: found.code,
          detail: found.detail,
          ...extra,
        };
      }
      session.close();

      return {
        ok: true,
        message: `${cfg.host} raggiungibile come ${cfg.username}: scrittura, rinomina, lettura ed eliminazione riuscite in ${where}.${spaceNote}${pinNote}`,
        ...extra,
      };
    },
  };
}
