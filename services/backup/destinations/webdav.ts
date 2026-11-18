import crypto from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import { DEFAULT_REMOTE_FOLDER, joinRemote, partialName } from "@/lib/backup-remote";
import { formatBytes } from "@/lib/format";
import { describeNetworkError } from "./net-errors";
import { DestinationFailure, clip, failedCheck, problem, redact, type DestinationProblem } from "./problem";
import { progressLog } from "./progress";
import type { Destination, DestinationCheck, PutOptions } from "../types";

/**
 * Backups to a WebDAV folder: Nextcloud, ownCloud, a Synology with the WebDAV
 * Server package, Koofr, pCloud, any server that speaks the protocol.
 *
 * Plain HTTP from Node, like the S3 adapter, because WebDAV is a handful of
 * verbs: MKCOL for the folder, PUT to write, MOVE to rename, GET to read back,
 * DELETE, and PROPFIND to ask whether something is there and how big. Basic
 * authentication, over HTTPS — or HTTP towards a private address, the same
 * rule as S3 — with an app password: on Nextcloud and ownCloud the account
 * password stops working the moment two-factor authentication is on, and an
 * app password can be revoked alone.
 *
 * An archive is PUT under a provisional name, its size asked back, and only
 * then MOVEd to its real name: a connection cut halfway leaves a `.partial`
 * file, never one that looks finished. Both directions stream.
 *
 * One limit is not ours to lift: whatever sits in front of the server — nginx,
 * Apache, Cloudflare — may cap the size of a request body. Such a refusal
 * arrives as a 413, or as a connection closed halfway through the upload; the
 * second is diagnosed with a tiny upload (if that goes through, it was the
 * size) and both are explained with the setting to change.
 */

export interface WebdavConfig {
  /** The WebDAV root: `https://cloud.example.com/remote.php/dav/files/alice/`. */
  url: string;
  username: string;
  password: string;
  /** Inside the root. */
  folder: string;
}

/** A check is a few small requests; a backup's own transfers have no clock but the socket's. */
const REQUEST_TIMEOUT_MS = 20_000;
/** An error page is a few kilobytes; past this it is not one. */
const MAX_ERROR_BODY = 16 * 1024;

type Step = "check" | "upload" | "download" | "stat" | "delete" | "folder" | "move";

interface Ctx {
  host: string;
  folder: string;
  step: Step;
  bytes?: number;
}

/** A path segment, percent-encoded strictly (RFC 3986), so `'` and `(` survive every server. */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The URL of `ref` under the root; a collection gets its trailing slash, as servers expect. */
export function webdavUrl(base: string, ref: string, collection = false): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  const path = ref
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeSegment)
    .join("/");
  return `${root}${path}${collection && path ? "/" : ""}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What a multistatus says about one resource: its size, and whether it is a folder. */
export function parsePropfind(xml: string): { size: number | null; collection: boolean; available: number | null } {
  const tag = (name: string) => new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</(?:[A-Za-z0-9_.-]+:)?${name}>`, "i").exec(xml)?.[1];
  const size = tag("getcontentlength");
  const available = tag("quota-available-bytes");
  return {
    size: size && /^\d+$/.test(size) ? Number(size) : null,
    collection: /<(?:[A-Za-z0-9_.-]+:)?collection\s*\/?>/i.test(xml),
    available: available && /^\d+$/.test(available) ? Number(available) : null,
  };
}

/** The server's own words from an error body: Sabre's `<s:message>`, or the text of a page. */
function serverWords(body: string): string {
  const sabre = /<(?:[A-Za-z0-9_-]+:)?message>([^<]*)</i.exec(body)?.[1];
  if (sabre) return clip(sabre, 200);
  if (/<html|<!doctype/i.test(body)) {
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1];
    return clip(title ?? body.replace(/<[^>]+>/g, " "), 160);
  }
  return clip(body, 160);
}

function verbOf(step: Step): string {
  switch (step) {
    case "download":
    case "stat":
      return "leggere";
    case "delete":
      return "eliminare";
    default:
      return "scrivere";
  }
}

/** A response with an error status, in Italian. */
export function describeWebdavStatus(input: { status: number; body?: string; location?: string | null }, ctx: Ctx): DestinationProblem {
  const { status } = input;
  const words = input.body ? serverWords(input.body) : "";
  const detail = clip(`HTTP ${status}${words ? `: ${words}` : ""}`, 300);
  const out = (code: string, cause: string, fix: string) => problem(code, cause, fix, detail);
  const folder = ctx.folder ? `«${ctx.folder}»` : "la cartella principale";

  if (status >= 300 && status < 400) {
    return out(
      "REDIRECT",
      `L'indirizzo rimanda altrove${input.location ? ` (${clip(input.location, 120)})` : ""}.`,
      "Usa direttamente l'indirizzo a cui rimanda: spesso è la versione https, o quello con la barra finale."
    );
  }
  switch (status) {
    case 401:
      return out(
        "AUTH",
        `Nome utente o password non accettati da ${ctx.host}.`,
        "Su Nextcloud e ownCloud serve una password per app (Impostazioni personali › Sicurezza › Crea nuova password per app): con la verifica in due passaggi attiva, la password dell'account non funziona."
      );
    case 403:
      return out(
        "PERMISSION",
        `L'utente non ha il permesso di ${verbOf(ctx.step)} in ${folder}.`,
        "Controlla i permessi della cartella sul server: una cartella condivisa con te in sola lettura non accetta file."
      );
    case 404:
      if (ctx.step === "download" || ctx.step === "stat") {
        return out("NOT_FOUND", "L'archivio non c'è più sul server.", "È stato spostato o eliminato fuori dal pannello.");
      }
      return out(
        "NO_URL",
        `L'indirizzo WebDAV non esiste su ${ctx.host}.`,
        "Controlla l'indirizzo: per Nextcloud è https://<server>/remote.php/dav/files/<utente>/, con il tuo nome utente."
      );
    case 405:
      return out(
        "NOT_WEBDAV",
        `${ctx.host} risponde, ma non accetta WebDAV a questo indirizzo.`,
        "Usa l'indirizzo WebDAV del servizio, non quello della sua pagina web."
      );
    case 409:
      return out("NO_FOLDER", `La cartella ${folder} non esiste e non si può creare lì.`, "Controlla l'indirizzo e la cartella.");
    case 412:
      return out("EXISTS", "Sul server c'è già un archivio con lo stesso nome.", "Riprova il backup: il nome cambia a ogni esecuzione.");
    case 413:
      return out(
        "TOO_LARGE",
        `${ctx.host} ha rifiutato l'archivio perché troppo grande${ctx.bytes ? ` (${formatBytes(ctx.bytes)})` : ""}.`,
        "Il limite è quasi sempre del reverse proxy davanti al server (client_max_body_size in nginx, LimitRequestBody in Apache, 100 MB su Cloudflare): alzalo, oppure usa una destinazione senza questo limite."
      );
    case 423:
      return out("LOCKED", "Il file è bloccato sul server da un altro programma.", "Riprova tra qualche minuto.");
    case 507:
      return out(
        "QUOTA",
        "Lo spazio dell'account sul server è esaurito.",
        "Libera spazio o alza la quota, oppure conserva meno archivi (sezione «Quanto tenerne» della pianificazione)."
      );
    case 429:
    case 503:
      return out(
        "BUSY",
        `${ctx.host} è sovraccarico o in manutenzione.`,
        "Riprova tra qualche minuto: una pianificazione ci riproverà comunque alla prossima esecuzione."
      );
    case 502:
    case 504:
      return out(
        "PROXY",
        status === 504 ? `Il reverse proxy davanti a ${ctx.host} non ha avuto risposta in tempo.` : `Il reverse proxy davanti a ${ctx.host} non è riuscito a parlare con il server.`,
        "Con archivi grandi, alza i timeout del proxy (proxy_read_timeout in nginx); altrimenti controlla che il server dietro sia acceso."
      );
  }
  if (status >= 500) {
    return out("SERVER_ERROR", `${ctx.host} ha avuto un errore interno (HTTP ${status}).`, "Riprova più tardi; se continua, controlla il log del server.");
  }
  return out("HTTP_" + status, `${ctx.host} ha rifiutato la richiesta (HTTP ${status})${words ? `: ${words}` : ""}.`, "Il dettaglio tecnico è qui sotto.");
}

/** The file as a stream, telling `progress` how much has gone, when someone listens. */
function counted(localPath: string, progress?: (done: number) => void): Readable {
  if (!progress) return fs.createReadStream(localPath);
  let done = 0;
  return Readable.from(
    (async function* () {
      for await (const chunk of fs.createReadStream(localPath)) {
        done += (chunk as Buffer).length;
        progress(done);
        yield chunk as Buffer;
      }
    })()
  );
}

function isValid(config: Partial<WebdavConfig>): config is WebdavConfig {
  return Boolean(config.url && config.username && config.password);
}

export function webdavDestination(row: { id: string; name: string; type: string }, raw: Record<string, unknown>): Destination {
  const config = raw as unknown as Partial<WebdavConfig>;

  function requireConfig(): WebdavConfig {
    if (!isValid(config)) {
      throw new Error("Configurazione WebDAV incompleta: servono indirizzo, utente e password. Modifica la destinazione e completala.");
    }
    return config;
  }

  const folderOf = (cfg: WebdavConfig) => (typeof cfg.folder === "string" ? cfg.folder : DEFAULT_REMOTE_FOLDER);
  const ctxOf = (cfg: WebdavConfig, step: Step, bytes?: number): Ctx => ({ host: hostOf(cfg.url), folder: folderOf(cfg), step, bytes });
  const scrub = (cfg: WebdavConfig, found: DestinationProblem): DestinationProblem => ({
    ...found,
    detail: found.detail ? redact(found.detail, [cfg.password]) : found.detail,
  });

  async function request(
    cfg: WebdavConfig,
    step: Step,
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: BodyInit; stream?: boolean; timeoutMs?: number | null; signal?: AbortSignal } = {}
  ): Promise<Response> {
    const timeout = init.timeoutMs === null ? null : (init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signals = [init.signal, timeout ? AbortSignal.timeout(timeout) : undefined].filter(Boolean) as AbortSignal[];
    try {
      return await fetch(url, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`, "utf8").toString("base64")}`,
          ...init.headers,
        },
        body: init.body,
        // A redirect is reported, not followed: a streamed body cannot be sent
        // twice, and credentials should not travel to an address nobody typed.
        redirect: "manual",
        ...(init.stream ? { duplex: "half" } : {}),
        ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
      } as RequestInit & { duplex?: "half" });
    } catch (err) {
      throw new DestinationFailure(scrub(cfg, describeNetworkError(err, { host: hostOf(cfg.url), uploading: step === "upload" })));
    }
  }

  async function refusal(cfg: WebdavConfig, step: Step, res: Response, bytes?: number): Promise<DestinationFailure> {
    let body = "";
    if (res.status !== 304 && step !== "stat") {
      try {
        const text = await res.text();
        body = text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text;
      } catch {
        body = "";
      }
    }
    return new DestinationFailure(scrub(cfg, describeWebdavStatus({ status: res.status, body, location: res.headers.get("location") }, ctxOf(cfg, step, bytes))));
  }

  const PROPFIND_BODY =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:quota-available-bytes/></d:prop></d:propfind>';

  /** Size, folder-ness and free space of one resource, or null when it is not there. */
  async function propfind(cfg: WebdavConfig, step: Step, url: string) {
    const res = await request(cfg, step, "PROPFIND", url, {
      headers: { depth: "0", "content-type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
      timeoutMs: REQUEST_TIMEOUT_MS * 2,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (res.status !== 207) {
      // A 200 to PROPFIND is a web page answering for a server that is not WebDAV.
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new DestinationFailure(scrub(cfg, describeWebdavStatus({ status: 405 }, ctxOf(cfg, step))));
      }
      throw await refusal(cfg, step, res);
    }
    return parsePropfind(await res.text());
  }

  /**
   * The folder, and every folder above it, created where missing — top down,
   * because MKCOL creates one level and refuses (409) when the parent is not
   * there. 405 is a folder that exists already.
   */
  async function ensureFolder(cfg: WebdavConfig, folder: string): Promise<void> {
    if (!folder) return;
    const whole = await propfind(cfg, "folder", webdavUrl(cfg.url, folder, true));
    if (whole) return;
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const res = await request(cfg, "folder", "MKCOL", webdavUrl(cfg.url, current, true));
      if (res.status === 201 || res.status === 405 || res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      throw await refusal(cfg, "folder", res);
    }
  }

  async function move(cfg: WebdavConfig, from: string, to: string): Promise<void> {
    const res = await request(cfg, "move", "MOVE", webdavUrl(cfg.url, from), {
      headers: { destination: webdavUrl(cfg.url, to), overwrite: "F" },
    });
    if (!res.ok) throw await refusal(cfg, "move", res);
    await res.body?.cancel().catch(() => {});
  }

  async function removeQuietly(cfg: WebdavConfig, ref: string): Promise<void> {
    const res = await request(cfg, "delete", "DELETE", webdavUrl(cfg.url, ref)).catch(() => null);
    await res?.body?.cancel().catch(() => {});
  }

  /**
   * Why a large upload was cut, asked with a few bytes.
   *
   * A proxy that refuses a body over its limit often answers before reading
   * it and closes the connection, and Node then reports a reset rather than
   * the 413. If a tiny write goes through, the size was the problem; if it
   * does not, its answer is the real reason.
   */
  async function diagnoseCut(cfg: WebdavConfig, bytes: number): Promise<DestinationProblem | null> {
    const folder = folderOf(cfg);
    const probe = joinRemote(folder, `.runpanel-size-test-${Date.now()}`);
    try {
      const body = Buffer.from("runpanel");
      const res = await request(cfg, "upload", "PUT", webdavUrl(cfg.url, probe), {
        headers: { "content-length": String(body.length), "content-type": "application/octet-stream" },
        body,
      });
      if (!res.ok) return (await refusal(cfg, "upload", res)).problem;
      await res.body?.cancel().catch(() => {});
      await removeQuietly(cfg, probe);
      return problem(
        "BODY_LIMIT",
        `${hostOf(cfg.url)} ha chiuso la connessione durante il caricamento di ${formatBytes(bytes)}, ma accetta i file piccoli.`,
        "Quasi certamente è il limite di dimensione del reverse proxy davanti al server (client_max_body_size in nginx, LimitRequestBody in Apache, 100 MB su Cloudflare): alzalo, o usa una destinazione senza limite.",
        null
      );
    } catch (err) {
      return err instanceof DestinationFailure ? err.problem : null;
    }
  }

  return {
    id: row.id,
    type: row.type,
    name: row.name,

    async put(localPath: string, fileName: string, opts: PutOptions = {}) {
      const cfg = requireConfig();
      const folder = folderOf(cfg);
      const { size } = await fs.promises.stat(localPath);
      const ref = joinRemote(folder, fileName);
      const provisional = partialName(ref, crypto.randomBytes(4).toString("hex"));

      await ensureFolder(cfg, folder);
      try {
        let res: Response;
        try {
          res = await request(cfg, "upload", "PUT", webdavUrl(cfg.url, provisional), {
            headers: { "content-length": String(size), "content-type": "application/octet-stream" },
            // Streamed, never buffered: an archive is routinely larger than the
            // heap. Read, never moved: the runner hands the same staged file to
            // every destination of the policy.
            body: Readable.toWeb(counted(localPath, opts.log ? progressLog(opts.log, size) : undefined)) as ReadableStream,
            stream: true,
            timeoutMs: null,
            signal: opts.signal,
          });
        } catch (err) {
          if (err instanceof DestinationFailure && err.problem.code === "RESET" && !opts.signal?.aborted) {
            const reason = await diagnoseCut(cfg, size);
            if (reason) throw new DestinationFailure(reason);
          }
          throw err;
        }
        if (!res.ok) throw await refusal(cfg, "upload", res, size);
        await res.body?.cancel().catch(() => {});

        // The size the server kept, before the archive gets its real name: an
        // incomplete upload must never become a file that looks finished.
        const kept = await propfind(cfg, "upload", webdavUrl(cfg.url, provisional));
        if (kept && kept.size !== null && kept.size !== size) {
          throw new DestinationFailure(
            problem(
              "SIZE_MISMATCH",
              `Il server ha conservato ${kept.size} byte invece di ${size}: il caricamento è incompleto.`,
              "Riprova il backup; se succede ancora, controlla lo spazio sul server.",
              null
            )
          );
        }
        await move(cfg, provisional, ref);
      } catch (err) {
        await removeQuietly(cfg, provisional);
        throw err;
      }
      return { ref, bytes: size };
    },

    /** The same address and folder is the same place: a policy refuses two copies there. */
    location() {
      let root = String(config.url ?? "");
      try {
        const url = new URL(root);
        root = `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
      } catch {
        /* compared as typed */
      }
      return `webdav:${root}/${typeof config.folder === "string" ? config.folder : DEFAULT_REMOTE_FOLDER}`;
    },

    async remove(ref: string) {
      const cfg = requireConfig();
      const res = await request(cfg, "delete", "DELETE", webdavUrl(cfg.url, ref), { timeoutMs: REQUEST_TIMEOUT_MS * 2 });
      // 404: already gone, which is the state that was wanted.
      if (!res.ok && res.status !== 404) throw await refusal(cfg, "delete", res);
      await res.body?.cancel().catch(() => {});
    },

    async open(ref: string, opts: { signal?: AbortSignal } = {}): Promise<Readable> {
      const cfg = requireConfig();
      const res = await request(cfg, "download", "GET", webdavUrl(cfg.url, ref), { timeoutMs: null, signal: opts.signal });
      if (!res.ok || !res.body) throw await refusal(cfg, "download", res);
      return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    },

    async stat(ref: string) {
      const cfg = requireConfig();
      const found = await propfind(cfg, "stat", webdavUrl(cfg.url, ref));
      if (!found) return { bytes: 0, exists: false };
      return { bytes: found.size ?? 0, exists: true };
    },

    /**
     * The whole path of a backup with a few bytes: the folder, a write under a
     * provisional name, the MOVE to the real one, a read back, a delete.
     */
    async test(): Promise<DestinationCheck> {
      let cfg: WebdavConfig;
      try {
        cfg = requireConfig();
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Configurazione non valida" };
      }
      const folder = folderOf(cfg);
      const ref = joinRemote(folder, `.runpanel-write-test-${Date.now()}`);
      const provisional = partialName(ref, crypto.randomBytes(4).toString("hex"));
      const marker = `runpanel ${Date.now()}`;
      const host = hostOf(cfg.url);
      const where = folder ? `in «${folder}»` : "nella cartella principale";
      const failure = (prefix: string, err: unknown) =>
        err instanceof DestinationFailure
          ? failedCheck(prefix, err.problem)
          : { ok: false, message: `${prefix}${err instanceof Error ? err.message : String(err)}` };

      try {
        await ensureFolder(cfg, folder);
        const body = Buffer.from(marker);
        const written = await request(cfg, "upload", "PUT", webdavUrl(cfg.url, provisional), {
          headers: { "content-length": String(body.length), "content-type": "text/plain" },
          body,
        });
        if (!written.ok) throw await refusal(cfg, "upload", written);
        await written.body?.cancel().catch(() => {});
      } catch (err) {
        return failure("", err);
      }

      try {
        await move(cfg, provisional, ref);
      } catch (err) {
        await removeQuietly(cfg, provisional);
        return failure("La scrittura funziona, ma lo spostamento (MOVE) no, e serve a ogni caricamento. ", err);
      }

      try {
        const read = await request(cfg, "download", "GET", webdavUrl(cfg.url, ref));
        if (!read.ok) throw await refusal(cfg, "download", read);
        const text = await read.text();
        if (text !== marker) {
          await removeQuietly(cfg, ref);
          return {
            ok: false,
            message:
              "La scrittura funziona, ma rileggendo il file il server ha restituito un contenuto diverso. " +
              "Controlla l'indirizzo: tra il pannello e il server potrebbe esserci un proxy o una cache.",
          };
        }
      } catch (err) {
        await removeQuietly(cfg, ref);
        return failure("La scrittura funziona, ma la lettura no, e senza lettura non si può ripristinare. ", err);
      }

      const space = await propfind(cfg, "folder", webdavUrl(cfg.url, folder, true)).catch(() => null);
      const spaceNote = space?.available !== null && space?.available !== undefined ? ` Spazio libero: ${formatBytes(space.available)}.` : "";

      try {
        const removed = await request(cfg, "delete", "DELETE", webdavUrl(cfg.url, ref));
        if (!removed.ok && removed.status !== 404) throw await refusal(cfg, "delete", removed);
        await removed.body?.cancel().catch(() => {});
      } catch (err) {
        const found = err instanceof DestinationFailure ? err.problem : null;
        return {
          ok: true,
          warning: true,
          message:
            `${host} raggiungibile: scrittura e lettura riuscite ${where}, ma l'eliminazione è stata rifiutata. ` +
            "La retention non potrà togliere gli archivi vecchi: dai all'utente anche il permesso di eliminare, o cancellali tu dal server." +
            spaceNote,
          code: found?.code,
          detail: found?.detail,
        };
      }

      return {
        ok: true,
        message: `${host} raggiungibile: scrittura, spostamento, lettura ed eliminazione riuscite ${where}.${spaceNote}`,
      };
    },
  };
}
