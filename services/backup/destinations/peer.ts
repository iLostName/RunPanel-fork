import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import {
  PEER_CHUNK_BYTES,
  PEER_PROTOCOL,
  PEER_TOKEN_HEADER,
  isPeerMemberId,
  isPeerUploadId,
  isSha256,
  peerFileNameProblem,
  peerRefProblem,
} from "@/lib/backup-peer";
import { formatBytes } from "@/lib/format";
import { DestinationFailure, clip, failedCheck, problem, type DestinationProblem } from "./problem";
import { progressLog } from "./progress";
import type { Destination, DestinationCheck, PutOptions } from "../types";

/**
 * Backups to another RunPanel server of the same cluster: the copy away from
 * this machine, with no account anywhere else. Two servers keeping each
 * other's copies is the use it is made for.
 *
 * The copies live in the other server's data directory, in a folder of this
 * server's own, apart from that server's backups (services/backup/peer-host.ts).
 * Every call is signed with the cluster's secret, member to member and for no
 * user, exactly as the cluster's own calls are.
 *
 * The signature covers the body's sha256, which a stream of gigabytes cannot
 * declare in a header it must send first, and the panel's proxy checks it by
 * buffering at most 10 MB; Node, for its part, closes a request whose body is
 * still arriving after five minutes. So an archive travels like this:
 *
 *  1. a small signed request reserves room for it — name, size, sha256 — and
 *     gets back a one-time token;
 *  2. the pieces, 8 MB at most, in order, each a signed request of its own
 *     carrying the token: each is checked whole on arrival, a lost one is sent
 *     again, and a connection that drops costs one piece rather than the
 *     upload;
 *  3. "complete": the receiver compares the size and the sha256 of everything
 *     that arrived with the reservation, and only then names the file.
 *
 * Reading is one signed GET streamed back, and the sha256 recorded with the
 * run is what a restore checks it against, as for every destination.
 *
 * The network part comes in as `transport`, so the unit suite drives this
 * without a cluster; destinations/index.ts hands it `signedFetch`.
 */

export interface PeerMember {
  id: string;
  name: string;
  url: string;
}

export type PeerLookup = { member: PeerMember } | { problem: "solo" | "gone" | "self" };

export interface PeerSendInit {
  method: "GET" | "POST" | "PUT" | "DELETE";
  body?: Uint8Array | string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
  /** How long to wait for the answer's headers — which, for a piece, includes sending it. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PeerTransport {
  /** The member as this server knows it now, or why it cannot be reached at all. */
  resolve(memberId: string): Promise<PeerLookup>;
  /** A signed member-to-member call. Throws when nothing answered. */
  send(member: PeerMember, path: string, init: PeerSendInit): Promise<Response>;
}

export interface PeerConfig {
  memberId: string;
  /** Its name when the destination was saved: what the messages call it once it is no longer linked. */
  memberName?: string;
}

export interface PeerDriverOptions {
  /** The waits before sending a piece again; three, by default. */
  retryDelaysMs?: number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

type Step = "info" | "reserve" | "upload" | "complete" | "download" | "stat" | "delete";

const BASE = "/api/cluster/peer-backups";
/** A piece of 8 MB on a slow uplink still arrives in time; past this, the link is not usable. */
const PIECE_TIMEOUT_MS = 5 * 60_000;
const SMALL_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY = 16 * 1024;

const nonce = () => crypto.randomBytes(6).toString("hex");

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * A refusal from the other server, in Italian. Its own code and numbers come
 * in the body; the name is the one this server knows it by.
 */
export function describePeerStatus(
  input: { status: number; body: Record<string, unknown> | null },
  ctx: { name: string; step: Step; bytes?: number }
): DestinationProblem {
  const { status } = input;
  const body = input.body ?? {};
  const code = typeof body.code === "string" ? body.code : null;
  const words = typeof body.error === "string" ? clip(body.error, 200) : "";
  const detail = clip(`HTTP ${status}${code ? ` ${code}` : ""}${words ? `: ${words}` : ""}`, 300);
  const out = (ours: string, cause: string, fix: string) => problem(ours, cause, fix, detail);
  const name = `«${ctx.name}»`;

  if (status === 401) {
    return out(
      "SIGNATURE",
      `${name} non riconosce la firma di questo server.`,
      "I due server non hanno lo stesso segreto del cluster, questo server non è più tra i suoi, o gli orologi sono distanti più di cinque minuti: apri Impostazioni › Server collegati › Diagnostica."
    );
  }
  if (status === 404 && !code) {
    // A route that does not exist: a version from before copies for other servers.
    return out("OLD_VERSION", `${name} ha una versione di RunPanel che non sa ancora tenere le copie di un altro server.`, "Aggiornalo da Impostazioni › Aggiornamenti, poi premi Verifica.");
  }
  if (code === "NOT_FOUND" && (ctx.step === "download" || ctx.step === "stat")) {
    return out("NOT_FOUND", `L'archivio non c'è più su ${name}.`, "È stato eliminato da lì, per esempio da Backup › Copie per altri server.");
  }
  if (code === "NOT_FOUND" || status === 410) {
    return out(
      "LOST",
      `${name} ha perso il caricamento a metà${code === "INTERRUPTED" ? ": si è riavviato" : ""}.`,
      "Riprova la copia: un archivio interrotto non prende mai il suo nome definitivo."
    );
  }
  if (code === "REFUSED") {
    return out(
      "REFUSED",
      `${name} non accetta copie da questo server.`,
      `Sul pannello di ${name}, in Backup › Copie per altri server, dai uno spazio a questo server; oppure scegli un'altra destinazione.`
    );
  }
  if (code === "QUOTA") {
    const used = num(body.usedBytes);
    const quota = num(body.quotaBytes);
    const bytes = num(body.bytes) ?? ctx.bytes ?? null;
    return out(
      "QUOTA",
      `Lo spazio che ${name} concede a questo server è pieno${used !== null && quota !== null ? `: ${formatBytes(used)} usati su ${formatBytes(quota)}` : ""}${bytes !== null ? `, e ne servono altri ${formatBytes(bytes)}` : ""}.`,
      `Alza il limite dal pannello di ${name} (Backup › Copie per altri server), o tieni lì meno copie («Quanto tenerne», nella pianificazione).`
    );
  }
  if (code === "DISK") {
    const free = num(body.freeBytes);
    const reserve = num(body.reserveBytes);
    const bytes = num(body.bytes) ?? ctx.bytes ?? null;
    return out(
      "DISK",
      `Sul disco di ${name} non c'è posto${bytes !== null ? ` per ${formatBytes(bytes)}` : ""}${free !== null ? `: liberi ${formatBytes(Math.max(0, free))}` : ""}${reserve !== null ? `, e ${formatBytes(reserve)} restano sempre a ${name} per sé` : ""}.`,
      `Libera spazio su ${name}, o tieni lì meno copie.`
    );
  }
  if (status === 429 || code === "BUSY" || code === "BUSY_WRITE" || code === "UPLOADING") {
    return out("BUSY", `${name} sta già ricevendo altri caricamenti da questo server.`, "Riprova tra qualche minuto.");
  }
  if (status === 422 || code === "HASH_MISMATCH" || code === "SIZE_MISMATCH") {
    return out(
      "MISMATCH",
      `${name} ha ricevuto un archivio diverso da quello inviato (${code === "SIZE_MISMATCH" ? "dimensione" : "sha256"} diverso) e lo ha scartato.`,
      "Riprova la copia; se succede ancora, controlla la rete tra i due server e il disco di questo."
    );
  }
  if (status === 413 || code === "TOO_LARGE") {
    return out(
      "TOO_LARGE",
      `${name} ha rifiutato un pezzo dell'archivio perché troppo grande.`,
      `Se davanti a ${name} c'è un reverse proxy, deve accettare richieste di almeno 8 MB (client_max_body_size in nginx).`
    );
  }
  if (status === 403) {
    return out("FORBIDDEN", `${name} ha rifiutato la richiesta${words ? `: ${words}` : ""}.`, "Il dettaglio tecnico è qui sotto.");
  }
  if (status >= 500) {
    return out("SERVER_ERROR", `${name} ha avuto un errore (HTTP ${status})${words ? `: ${words}` : ""}.`, `Riprova più tardi; se continua, guarda il log di ${name}.`);
  }
  return out(`HTTP_${status}`, `${name} ha rifiutato la richiesta (HTTP ${status})${words ? `: ${words}` : ""}.`, "Il dettaglio tecnico è qui sotto.");
}

async function bodyOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The file's sha256, for a caller that did not pass it along. */
async function hashOf(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface Reservation {
  uploadId: string;
  token: string;
  chunkBytes: number;
}

export function peerDestination(
  row: { id: string; name: string; type: string },
  raw: Record<string, unknown>,
  transport: PeerTransport,
  driver: PeerDriverOptions = {}
): Destination {
  const config = raw as unknown as Partial<PeerConfig>;
  const retryDelays = driver.retryDelaysMs ?? [2_000, 5_000, 15_000];
  const sleep = driver.sleep ?? defaultSleep;
  const storedName = typeof config.memberName === "string" && config.memberName ? config.memberName : "il server collegato";

  /** The member this destination writes to, as linked now; the reason in words when it is not. */
  async function target(): Promise<PeerMember> {
    if (!isPeerMemberId(config.memberId)) {
      throw new DestinationFailure(problem("CONFIG", "Configurazione incompleta: manca il server.", "Modifica la destinazione e scegli il server.", null));
    }
    const found = await transport.resolve(config.memberId);
    if ("member" in found) return found.member;
    if (found.problem === "solo") {
      throw new DestinationFailure(
        problem("SOLO", "Questo server non fa più parte di un cluster.", `Collegalo di nuovo a «${storedName}» da Impostazioni › Server collegati, o scegli un'altra destinazione.`, null)
      );
    }
    if (found.problem === "self") {
      throw new DestinationFailure(problem("SELF", "La destinazione punta a questo stesso server: non sarebbe una copia fuori sede.", "Modificala e scegli un altro server.", null));
    }
    throw new DestinationFailure(
      problem(
        "NOT_LINKED",
        `«${storedName}» non è più collegato a questo server.`,
        "Ricollegalo da Impostazioni › Server collegati, o scegli un'altra destinazione. Le copie che ha già restano lì, nella sua pagina Backup.",
        null
      )
    );
  }

  /** A call that got no answer at all, in words. */
  async function call(member: PeerMember, path: string, init: PeerSendInit): Promise<Response> {
    try {
      return await transport.send(member, path, init);
    } catch (err) {
      if (init.signal?.aborted) {
        throw new DestinationFailure(problem("ABORTED", "Caricamento annullato.", "Riprova quando vuoi: un archivio interrotto non prende mai il suo nome definitivo.", null));
      }
      const words = err instanceof Error ? clip(err.message, 160) : "";
      throw new DestinationFailure(
        problem(
          "UNREACHABLE",
          `«${member.name}» non risponde${words ? ` (${words})` : ""}.`,
          "Controlla che sia acceso e raggiungibile da questo server: Impostazioni › Server collegati › Diagnostica.",
          words || null
        )
      );
    }
  }

  async function refusal(member: PeerMember, res: Response, step: Step, bytes?: number): Promise<DestinationFailure> {
    return new DestinationFailure(describePeerStatus({ status: res.status, body: await bodyOf(res) }, { name: member.name, step, bytes }));
  }

  /** A call worth repeating: nothing answered, or the answer was a proxy's or a busy server's. */
  async function retrying<T>(attempt: () => Promise<T>, signal: AbortSignal | undefined, log?: (line: string) => void, what = "la richiesta"): Promise<T> {
    for (let index = 0; ; index++) {
      try {
        return await attempt();
      } catch (err) {
        const code = err instanceof DestinationFailure ? err.problem.code : null;
        const transient = code === "UNREACHABLE" || code === "SERVER_ERROR";
        if (!transient || index >= retryDelays.length || signal?.aborted) throw err;
        const wait = retryDelays[index];
        log?.(`  ${err instanceof DestinationFailure ? err.problem.cause : "nessuna risposta"} Riprovo ${what} tra ${Math.round(wait / 1000)} s…`);
        await sleep(wait, signal);
      }
    }
  }

  async function reserve(member: PeerMember, fileName: string, bytes: number, sha256: string, signal?: AbortSignal): Promise<Reservation> {
    const res = await call(member, `${BASE}/uploads`, {
      method: "POST",
      body: JSON.stringify({ fileName, bytes, sha256 }),
      contentType: "application/json",
      timeoutMs: SMALL_TIMEOUT_MS,
      signal,
    });
    if (!res.ok) throw await refusal(member, res, "reserve", bytes);
    const body = (await bodyOf(res)) ?? {};
    if (!isPeerUploadId(body.uploadId) || typeof body.token !== "string") {
      throw new DestinationFailure(problem("PROTOCOL", `«${member.name}» ha risposto in un modo che questo server non riconosce.`, "Aggiorna entrambi i server alla stessa versione.", clip(JSON.stringify(body), 200)));
    }
    const chunk = num(body.chunkBytes);
    return { uploadId: body.uploadId, token: body.token, chunkBytes: chunk && chunk > 0 ? Math.min(chunk, PEER_CHUNK_BYTES) : PEER_CHUNK_BYTES };
  }

  /** One piece; the offset the receiver has reached after it. */
  async function piece(member: PeerMember, reservation: Reservation, offset: number, bytes: Uint8Array, total: number, signal?: AbortSignal): Promise<number> {
    const res = await call(member, `${BASE}/uploads/${reservation.uploadId}?offset=${offset}`, {
      method: "PUT",
      body: bytes,
      contentType: "application/octet-stream",
      headers: { [PEER_TOKEN_HEADER]: reservation.token },
      timeoutMs: PIECE_TIMEOUT_MS,
      signal,
    });
    const body = await bodyOf(res);
    if (res.ok) {
      const received = num(body?.received);
      if (received === null || received <= offset || received > total) {
        throw new DestinationFailure(problem("PROTOCOL", `«${member.name}» ha risposto in un modo che questo server non riconosce.`, "Aggiorna entrambi i server alla stessa versione.", null));
      }
      return received;
    }
    // A piece that crossed a lost answer: the receiver says where it is, and the upload goes on from there.
    const received = num(body?.received);
    if (res.status === 409 && body?.code === "OUT_OF_ORDER" && received !== null && received >= 0 && received <= total) return received;
    throw new DestinationFailure(describePeerStatus({ status: res.status, body }, { name: member.name, step: "upload", bytes: total }));
  }

  async function sendAll(member: PeerMember, reservation: Reservation, localPath: string, size: number, opts: PutOptions): Promise<void> {
    const progress = opts.log ? progressLog(opts.log, size) : undefined;
    const handle = await fs.promises.open(localPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(reservation.chunkBytes);
      let offset = 0;
      while (offset < size) {
        if (opts.signal?.aborted) {
          throw new DestinationFailure(problem("ABORTED", "Caricamento annullato.", "Riprova quando vuoi: un archivio interrotto non prende mai il suo nome definitivo.", null));
        }
        const length = Math.min(reservation.chunkBytes, size - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) {
          throw new DestinationFailure(problem("LOCAL_CHANGED", "L'archivio è cambiato sul disco di questo server mentre veniva caricato.", "Riprova il backup.", null));
        }
        const from = offset;
        offset = await retrying(() => piece(member, reservation, from, buffer.subarray(0, length), size, opts.signal), opts.signal, opts.log, "il pezzo");
        progress?.(offset);
      }
    } finally {
      await handle.close();
    }
  }

  async function complete(member: PeerMember, reservation: Reservation, signal?: AbortSignal): Promise<{ ref: string; bytes: number; sha256: string }> {
    const res = await call(member, `${BASE}/uploads/${reservation.uploadId}`, {
      method: "POST",
      headers: { [PEER_TOKEN_HEADER]: reservation.token },
      // Comparing the sha256 is instant (it ran while the pieces arrived); flushing a large file is not.
      timeoutMs: PIECE_TIMEOUT_MS,
      signal,
    });
    if (!res.ok) throw await refusal(member, res, "complete");
    const body = (await bodyOf(res)) ?? {};
    if (typeof body.ref !== "string" || peerRefProblem(body.ref) || num(body.bytes) === null || !isSha256(body.sha256)) {
      throw new DestinationFailure(problem("PROTOCOL", `«${member.name}» ha risposto in un modo che questo server non riconosce.`, "Aggiorna entrambi i server alla stessa versione.", null));
    }
    return { ref: body.ref, bytes: body.bytes as number, sha256: body.sha256 };
  }

  async function abort(member: PeerMember, reservation: Reservation): Promise<void> {
    const res = await call(member, `${BASE}/uploads/${reservation.uploadId}`, {
      method: "DELETE",
      headers: { [PEER_TOKEN_HEADER]: reservation.token },
      timeoutMs: 10_000,
    });
    await res.body?.cancel().catch(() => {});
  }

  /** Store `localPath` there; the file stays where it is, for the policy's next destination. */
  async function upload(member: PeerMember, localPath: string, fileName: string, opts: PutOptions, knownSha256?: string): Promise<{ ref: string; bytes: number }> {
    const nameProblem = peerFileNameProblem(fileName);
    if (nameProblem) throw new DestinationFailure(problem("NAME", `Nome dell'archivio non valido: ${nameProblem}.`, "Rinomina la pianificazione e riprova.", fileName));
    const { size } = await fs.promises.stat(localPath);
    if (!isSha256(knownSha256) && size > 256 * 1024 * 1024) opts.log?.("  calcolo lo sha256 dell'archivio…");
    const sha256: string = isSha256(knownSha256) ? knownSha256 : await hashOf(localPath);
    const reservation = await retrying(() => reserve(member, fileName, size, sha256, opts.signal), opts.signal, opts.log);
    try {
      await sendAll(member, reservation, localPath, size, opts);
      const done = await retrying(() => complete(member, reservation, opts.signal), opts.signal, opts.log);
      if (done.bytes !== size || done.sha256 !== sha256) {
        throw new DestinationFailure(problem("MISMATCH", `«${member.name}» ha conservato un archivio diverso da quello inviato.`, "Riprova la copia.", null));
      }
      return { ref: done.ref, bytes: done.bytes };
    } catch (err) {
      await abort(member, reservation).catch(() => {});
      throw err;
    }
  }

  async function info(member: PeerMember): Promise<Record<string, unknown>> {
    const res = await call(member, `${BASE}?n=${nonce()}`, { method: "GET", timeoutMs: SMALL_TIMEOUT_MS });
    if (!res.ok) throw await refusal(member, res, "info");
    const body = (await bodyOf(res)) ?? {};
    if ((num(body.protocol) ?? 0) < PEER_PROTOCOL) {
      throw new DestinationFailure(
        problem("OLD_VERSION", `«${member.name}» ha una versione di RunPanel che non sa ancora tenere le copie di un altro server.`, "Aggiornalo da Impostazioni › Aggiornamenti, poi premi Verifica.", null)
      );
    }
    return body;
  }

  async function statOn(member: PeerMember, ref: string): Promise<{ exists: boolean; bytes: number }> {
    const res = await call(member, `${BASE}/archive/stat?ref=${encodeURIComponent(ref)}&n=${nonce()}`, { method: "GET", timeoutMs: SMALL_TIMEOUT_MS });
    if (!res.ok) throw await refusal(member, res, "stat");
    const body = (await bodyOf(res)) ?? {};
    return { exists: body.exists === true, bytes: num(body.bytes) ?? 0 };
  }

  async function openOn(member: PeerMember, ref: string, signal?: AbortSignal): Promise<Readable> {
    const res = await call(member, `${BASE}/archive?ref=${encodeURIComponent(ref)}&n=${nonce()}`, { method: "GET", timeoutMs: 60_000, signal });
    if (!res.ok || !res.body) throw await refusal(member, res, "download");
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  async function removeOn(member: PeerMember, ref: string): Promise<void> {
    const res = await call(member, `${BASE}/archive?ref=${encodeURIComponent(ref)}&n=${nonce()}`, { method: "DELETE", timeoutMs: SMALL_TIMEOUT_MS });
    if (!res.ok) throw await refusal(member, res, "delete");
    await res.body?.cancel().catch(() => {});
  }

  /** What "Verifica" says about the room left: the limit, or the disk's. */
  function spaceLine(name: string, about: Record<string, unknown>): { text: string; low: boolean } {
    const quota = num(about.quotaBytes);
    const used = num(about.usedBytes) ?? 0;
    const available = num(about.availableBytes);
    const reserve = num(about.reserveBytes);
    const low = available !== null && available < 1024 ** 3;
    if (quota !== null) {
      const disk = about.limitedBy === "DISK" && available !== null ? ` Sul suo disco però restano solo ${formatBytes(available)}.` : "";
      return { text: `Spazio concesso da «${name}» a questo server: ${formatBytes(used)} usati su ${formatBytes(quota)}.${disk}`, low };
    }
    if (available === null) return { text: `Nessun limite per questo server su «${name}».`, low };
    return {
      text: `Nessun limite per questo server: su «${name}» restano ${formatBytes(available)}${reserve !== null ? ` (${formatBytes(reserve)} del disco restano sempre a «${name}»)` : ""}.`,
      low,
    };
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath, fileName, opts: PutOptions = {}) {
      const member = await target();
      return upload(member, localPath, fileName, opts, opts.sha256);
    },

    async remove(ref) {
      if (peerRefProblem(ref)) return;
      await removeOn(await target(), ref);
    },

    async open(ref, opts: { signal?: AbortSignal } = {}) {
      if (peerRefProblem(ref)) throw new Error("Riferimento dell'archivio non valido");
      return openOn(await target(), ref, opts.signal);
    },

    async stat(ref) {
      if (peerRefProblem(ref)) return { bytes: 0, exists: false };
      return statOn(await target(), ref);
    },

    /** Two destinations towards the same server are one place: a policy refuses two copies there. */
    location() {
      return `peer:${typeof config.memberId === "string" ? config.memberId : ""}`;
    },

    /**
     * The whole path of a backup with a few bytes: what the other server
     * allows, a reservation, a piece, "complete", a read back, a delete.
     */
    async test(): Promise<DestinationCheck> {
      let member: PeerMember;
      try {
        member = await target();
      } catch (err) {
        return err instanceof DestinationFailure ? failedCheck("", err.problem) : { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      const failure = (prefix: string, err: unknown): DestinationCheck =>
        err instanceof DestinationFailure ? failedCheck(prefix, err.problem) : { ok: false, message: `${prefix}${err instanceof Error ? err.message : String(err)}` };

      let about: Record<string, unknown>;
      try {
        about = await info(member);
      } catch (err) {
        return failure("", err);
      }
      if (about.limitedBy === "REFUSED") {
        return failedCheck("", describePeerStatus({ status: 403, body: { code: "REFUSED" } }, { name: member.name, step: "info" }));
      }

      const stamp = Date.now();
      const marker = Buffer.from(`runpanel ${stamp} ${nonce()}`);
      const file = `runpanel-verifica-${stamp}-${nonce()}.txt`;
      let ref: string;
      try {
        const reservation = await reserve(member, file, marker.length, crypto.createHash("sha256").update(marker).digest("hex"));
        try {
          await piece(member, reservation, 0, marker, marker.length);
          ref = (await complete(member, reservation)).ref;
        } catch (err) {
          await abort(member, reservation).catch(() => {});
          throw err;
        }
      } catch (err) {
        return failure("", err);
      }

      try {
        const stat = await statOn(member, ref);
        const stream = await openOn(member, ref);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        if (!stat.exists || !Buffer.concat(chunks).equals(marker)) {
          await removeOn(member, ref).catch(() => {});
          return { ok: false, message: `La scrittura su «${member.name}» funziona, ma il file riletto è diverso da quello scritto: controlla il disco di «${member.name}».` };
        }
      } catch (err) {
        await removeOn(member, ref).catch(() => {});
        return failure("La scrittura funziona, ma la lettura no, e senza lettura non si può ripristinare. ", err);
      }

      try {
        await removeOn(member, ref);
      } catch (err) {
        const found = err instanceof DestinationFailure ? err.problem : null;
        return {
          ok: true,
          warning: true,
          message: `«${member.name}» raggiungibile: scrittura e lettura riuscite, ma l'eliminazione no. La retention non potrà togliere gli archivi vecchi.`,
          code: found?.code,
          detail: found?.detail,
        };
      }

      const space = spaceLine(member.name, about);
      if (space.low) {
        return {
          ok: true,
          warning: true,
          message: `«${member.name}» raggiungibile: scrittura, lettura ed eliminazione riuscite, ma lo spazio è quasi finito. ${space.text}`,
        };
      }
      return { ok: true, message: `«${member.name}» raggiungibile: scrittura, lettura ed eliminazione riuscite. ${space.text}` };
    },
  };
}
