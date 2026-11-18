import os from "node:os";
import type { Api, TelegramClient } from "telegram";
import type { StringSession } from "telegram/sessions";
import { panelVersion } from "@/lib/version";
import {
  TELEGRAM_MAX_FILE_PARTS,
  TelegramFailure,
  classifyTelegramError,
  withTelegramRetry,
  withTimeout,
  type TelegramAccount,
  type TelegramChat,
  type TelegramConfig,
  type TelegramDocument,
  type TelegramTransport,
  type UploadInput,
} from "./telegram";

/**
 * The Telegram calls behind `TelegramTransport`, over MTProto with GramJS.
 *
 * Imported only when a Telegram destination or login is actually used, and
 * GramJS itself loaded on first call (`loadGram`), not at module load: it is
 * ~15 MB of heap and half a second of parsing the TL schema, and most panels
 * never touch Telegram. `next.config.ts` keeps it out of the server bundle.
 *
 * What GramJS does not do and this file adds: a clock on every request (it has
 * none, and a request on a connection that died quietly waits forever), a
 * clock on connecting (its TCP connect has none either), FLOOD_WAIT waited out
 * through `withTelegramRetry` so the run log can say so, and an upload loop of
 * its own — GramJS's reads a whole file from offset zero, and a part of a split
 * archive is a slice that starts in the middle.
 */

type Gram = typeof import("telegram");
type Long = ReturnType<Gram["helpers"]["returnBigInt"]>;
type Sender = Awaited<ReturnType<TelegramClient["getSender"]>>;

/** Connecting, with GramJS's own three attempts inside. */
const CONNECT_TIMEOUT_MS = 45_000;
/** An ordinary request. */
const CALL_TIMEOUT_MS = 30_000;
/** One 512 KiB piece: generous, a slow uplink shares one connection between several. */
const PIECE_TIMEOUT_MS = 120_000;
/** One 1 MiB download request. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Pieces in flight at once: enough to fill a line, few enough to stay polite. */
const UPLOAD_WORKERS = 4;
/** Below this a file goes up with saveFilePart, above with saveBigFilePart (Telegram's rule). */
const SMALL_FILE_BYTES = 10 * 1024 * 1024;
/** The largest download request, which also keeps every offset on a 1 MiB boundary as upload.getFile wants. */
const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
/** Download requests in flight ahead of the one being read. */
const DOWNLOAD_AHEAD = 3;

const CHANNEL_ABOUT =
  "Archivi di backup di RunPanel. Non eliminare né modificare i messaggi a mano: il pannello li cerca qui per ripristinare.";

let loading: Promise<{ gram: Gram; quietLogger: () => InstanceType<Gram["Logger"]> }> | null = null;

/** GramJS, loaded once, with its logger silenced: what matters goes to the run log in Italian. */
export function loadGram() {
  loading ??= (async () => {
    const gram = await import("telegram");
    const { LogLevel } = await import("telegram/extensions/Logger");
    return { gram, quietLogger: () => new gram.Logger(LogLevel.NONE) };
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

export interface GramClient {
  gram: Gram;
  client: TelegramClient;
  /** Where the authorization ends up after a login: `session.save()`. */
  session: StringSession;
}

/**
 * A client, not yet connected. The device fields are what the account owner
 * sees in Telegram › Impostazioni › Dispositivi, so they say what this is and
 * which server it runs on: that is the line to close to revoke the panel.
 */
export async function createClient(apiId: number, apiHash: string, session = ""): Promise<GramClient> {
  const { gram, quietLogger } = await loadGram();
  const stringSession = new gram.sessions.StringSession(session);
  const client = new gram.TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 2000,
    requestRetries: 3,
    autoReconnect: true,
    // GramJS sleeps through shorter waits by itself; longer ones reach
    // withTelegramRetry, which logs them and can be cancelled.
    floodSleepThreshold: 5,
    deviceModel: `RunPanel su ${os.hostname()}`.slice(0, 64),
    systemVersion: `${os.type()} ${os.release()}`.slice(0, 64),
    appVersion: `RunPanel ${panelVersion()}`,
    langCode: "it",
    systemLangCode: "it",
    baseLogger: quietLogger(),
  });
  return { gram, client, session: stringSession };
}

/** Never throws and never hangs: a destroy that waits on a dead socket is given five seconds. */
export async function closeClient(client: TelegramClient): Promise<void> {
  await withTimeout(client.destroy(), 5000, "chiusura").catch(() => {});
}

export async function connectClient(client: TelegramClient): Promise<void> {
  let connected = false;
  try {
    connected = await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, "connessione");
  } catch (err) {
    await closeClient(client);
    throw err;
  }
  if (!connected && !client.connected) {
    await closeClient(client);
    throw new TelegramFailure("Non riesco a collegarmi a Telegram: controlla che questo server possa collegarsi a internet.");
  }
}

function errorCode(err: unknown): string | null {
  const code = err && typeof err === "object" ? (err as { errorMessage?: unknown }).errorMessage : null;
  return typeof code === "string" ? code : null;
}

export function describeUser(user: Api.User): TelegramAccount {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  const username = user.username ?? user.usernames?.find((entry) => entry.active)?.username ?? null;
  return { id: user.id.toString(), name, username, premium: user.premium === true };
}

/** A number in the app config Telegram publishes (`help.getAppConfig`), or null. */
function appConfigNumber(gram: Gram, config: Api.TypeJSONValue, key: string): number | null {
  if (!(config instanceof gram.Api.JsonObject)) return null;
  const entry = config.value.find((item) => item.key === key);
  return entry && entry.value instanceof gram.Api.JsonNumber && Number.isFinite(entry.value.value) ? entry.value.value : null;
}

/** The id Telegram gave the message just sent, found by the random id that went with it. */
function postedMessageId(gram: Gram, updates: Api.TypeUpdates, randomId: Long): number | null {
  const { Api: A } = gram;
  const list =
    updates instanceof A.Updates || updates instanceof A.UpdatesCombined
      ? updates.updates
      : updates instanceof A.UpdateShort
        ? [updates.update]
        : [];
  for (const update of list) {
    if (update instanceof A.UpdateMessageID && update.randomId?.equals(randomId)) return update.id;
  }
  for (const update of list) {
    if ((update instanceof A.UpdateNewChannelMessage || update instanceof A.UpdateNewMessage) && update.message instanceof A.Message) {
      return update.message.id;
    }
  }
  return null;
}

export class GramTransport implements TelegramTransport {
  readonly gram: Gram;
  readonly client: TelegramClient;
  private selfId: string | null = null;
  /** Once closed, nothing retries or reconnects: a request left in flight just fails. */
  private closed = false;

  constructor(gram: Gram, client: TelegramClient) {
    this.gram = gram;
    this.client = client;
  }

  private ensureOpen(): void {
    if (this.closed) throw new TelegramFailure("La connessione a Telegram è stata chiusa.");
  }

  private async reconnect(): Promise<void> {
    this.ensureOpen();
    if (this.client.connected) return;
    await withTimeout(this.client.connect(), CONNECT_TIMEOUT_MS, "riconnessione");
  }

  /** One request with a clock, the retry policy, and a reconnect between attempts when the connection dropped. */
  call<T>(
    make: () => Promise<T>,
    what: string,
    options: { timeoutMs?: number; signal?: AbortSignal; onWait?: (seconds: number) => void; attempts?: number } = {}
  ): Promise<T> {
    return withTelegramRetry(
      () => {
        this.ensureOpen();
        return withTimeout(make(), options.timeoutMs ?? CALL_TIMEOUT_MS, what);
      },
      {
        attempts: options.attempts,
        signal: options.signal,
        onWait: options.onWait,
        beforeRetry: async () => {
          this.ensureOpen();
          await this.reconnect().catch(() => {});
        },
      }
    );
  }

  private inputChannel(chat: Extract<TelegramChat, { kind: "channel" }>): Api.InputChannel {
    const { Api: A, helpers } = this.gram;
    return new A.InputChannel({ channelId: helpers.returnBigInt(chat.id), accessHash: helpers.returnBigInt(chat.accessHash) });
  }

  private inputPeer(chat: TelegramChat): Api.TypeInputPeer {
    const { Api: A, helpers } = this.gram;
    return chat.kind === "saved"
      ? new A.InputPeerSelf()
      : new A.InputPeerChannel({ channelId: helpers.returnBigInt(chat.id), accessHash: helpers.returnBigInt(chat.accessHash) });
  }

  async account(): Promise<TelegramAccount> {
    const { Api: A } = this.gram;
    const users = await this.call(() => this.client.invoke(new A.users.GetUsers({ id: [new A.InputUserSelf()] })), "account");
    const user = users[0];
    if (!(user instanceof A.User)) throw new TelegramFailure("Telegram non ha restituito l'account collegato.");
    this.selfId = user.id.toString();
    return describeUser(user);
  }

  async maxFileParts(premium: boolean): Promise<number> {
    const documented = premium ? TELEGRAM_MAX_FILE_PARTS.premium : TELEGRAM_MAX_FILE_PARTS.regular;
    const { Api: A } = this.gram;
    try {
      const result = await this.call(() => this.client.invoke(new A.help.GetAppConfig({ hash: 0 })), "configurazione", { attempts: 2 });
      if (result instanceof A.help.AppConfig) {
        const value = appConfigNumber(this.gram, result.config, premium ? "upload_max_fileparts_premium" : "upload_max_fileparts_default");
        // Followed down, never up: see TELEGRAM_MAX_FILE_PARTS.
        if (value !== null && value >= 100) return Math.min(documented, Math.floor(value));
      }
    } catch (err) {
      const kind = classifyTelegramError(err).kind;
      if (kind === "revoked" || kind === "deactivated") throw err;
      // Anything else: the documented value is the answer.
    }
    return documented;
  }

  /**
   * The pieces go up with a few in flight, each retried on its own: a piece
   * sent twice simply replaces itself, so a dropped connection costs one
   * piece, not the part.
   */
  async upload(input: UploadInput): Promise<unknown> {
    const { Api: A, helpers } = this.gram;
    const big = input.bytes > SMALL_FILE_BYTES;
    const total = Math.ceil(input.bytes / input.chunkBytes);
    if (total < 1) throw new TelegramFailure("Non si carica un file vuoto.");
    const fileId = helpers.generateRandomLong();

    let index = 0;
    let sent = 0;
    let failure: unknown = null;
    const inFlight = new Set<Promise<void>>();

    const send = async (part: number, bytes: Buffer) => {
      const request = big
        ? new A.upload.SaveBigFilePart({ fileId, filePart: part, fileTotalParts: total, bytes })
        : new A.upload.SaveFilePart({ fileId, filePart: part, bytes });
      const accepted = await this.call(() => this.client.invoke(request), `pezzo ${part + 1} di ${total}`, {
        timeoutMs: PIECE_TIMEOUT_MS,
        signal: input.signal,
        onWait: input.onWait,
        attempts: 6,
      });
      if (!accepted) throw new TelegramFailure(`Telegram non ha accettato il pezzo ${part + 1} di ${total}.`);
      sent += bytes.length;
      input.onProgress?.(sent);
    };

    try {
      for await (const chunk of input.chunks) {
        if (failure) break;
        const task: Promise<void> = send(index++, chunk)
          .catch((err: unknown) => {
            failure ??= err;
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
        if (inFlight.size >= UPLOAD_WORKERS) await Promise.race(inFlight);
      }
    } finally {
      await Promise.allSettled([...inFlight]);
    }
    if (failure) throw failure;
    if (index !== total) throw new TelegramFailure(`Letti ${index} pezzi su ${total}: il file è cambiato durante il caricamento.`);

    return big
      ? new A.InputFileBig({ id: fileId, parts: total, name: input.fileName })
      : new A.InputFile({ id: fileId, parts: total, name: input.fileName, md5Checksum: "" });
  }

  async post(
    chat: TelegramChat,
    file: unknown,
    input: { fileName: string; caption: string; bytes: number; signal?: AbortSignal }
  ): Promise<number> {
    const { Api: A, helpers } = this.gram;
    // Kept across retries on purpose: Telegram refuses a second message with
    // the same random id, so a send whose answer was lost is never posted twice.
    const randomId = helpers.generateRandomLong();
    const request = new A.messages.SendMedia({
      peer: this.inputPeer(chat),
      media: new A.InputMediaUploadedDocument({
        file: file as Api.TypeInputFile,
        mimeType: "application/octet-stream",
        attributes: [new A.DocumentAttributeFilename({ fileName: input.fileName })],
        forceFile: true,
      }),
      message: input.caption,
      randomId,
      silent: true,
    });
    // Telegram puts the pieces together before it answers: allow a minute per gigabyte.
    const timeoutMs = 120_000 + Math.ceil(input.bytes / 1024 ** 3) * 60_000;
    try {
      const updates = await this.call(() => this.client.invoke(request), "invio del file", { timeoutMs, signal: input.signal });
      const id = postedMessageId(this.gram, updates, randomId);
      if (id !== null) return id;
    } catch (err) {
      if (errorCode(err) !== "RANDOM_ID_DUPLICATE") throw err;
    }
    const found = await this.findPosted(chat, input.fileName, input.caption);
    if (found === null) {
      throw new TelegramFailure("Telegram ha accettato il file ma non ha detto in quale messaggio l'ha messo. Riprova il backup.");
    }
    return found;
  }

  /** The message just posted, looked up among the latest ones by its file name and caption. */
  private async findPosted(chat: TelegramChat, fileName: string, caption: string): Promise<number | null> {
    const { Api: A, helpers } = this.gram;
    const history = await this.call(
      () =>
        this.client.invoke(
          new A.messages.GetHistory({
            peer: this.inputPeer(chat),
            offsetId: 0,
            offsetDate: 0,
            addOffset: 0,
            limit: 30,
            maxId: 0,
            minId: 0,
            hash: helpers.returnBigInt(0),
          })
        ),
      "ricerca del messaggio"
    );
    if (!("messages" in history)) return null;
    for (const message of history.messages) {
      if (message instanceof A.Message && message.message === caption && this.document(message)?.fileName === fileName) {
        return message.id;
      }
    }
    return null;
  }

  private document(message: Api.Message): TelegramDocument | null {
    const { Api: A } = this.gram;
    const media = message.media;
    if (!(media instanceof A.MessageMediaDocument) || !(media.document instanceof A.Document)) return null;
    const named = media.document.attributes.find(
      (attribute): attribute is Api.DocumentAttributeFilename => attribute instanceof A.DocumentAttributeFilename
    );
    return {
      messageId: message.id,
      bytes: media.document.size.toJSNumber(),
      caption: message.message ?? "",
      fileName: named?.fileName ?? null,
    };
  }

  private async messages(chat: TelegramChat, ids: number[]): Promise<Map<number, Api.Message>> {
    const { Api: A } = this.gram;
    const found = new Map<number, Api.Message>();
    if (chat.kind === "saved" && this.selfId === null) await this.account();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100).map((id) => new A.InputMessageID({ id }));
      const request =
        chat.kind === "channel"
          ? new A.channels.GetMessages({ channel: this.inputChannel(chat), id: batch })
          : new A.messages.GetMessages({ id: batch });
      const result = await this.call(() => this.client.invoke(request), "lettura dei messaggi");
      if (!("messages" in result)) continue;
      for (const message of result.messages) {
        if (!(message instanceof A.Message)) continue;
        // Message ids outside a channel are shared by every private chat of
        // the account: only one in Saved Messages is one of ours.
        if (chat.kind === "saved" && !(message.peerId instanceof A.PeerUser && message.peerId.userId.toString() === this.selfId)) {
          continue;
        }
        found.set(message.id, message);
      }
    }
    return found;
  }

  async documents(chat: TelegramChat, ids: number[]): Promise<(TelegramDocument | null)[]> {
    const found = await this.messages(chat, ids);
    return ids.map((id) => {
      const message = found.get(id);
      return message ? this.document(message) : null;
    });
  }

  private async fileOf(chat: TelegramChat, messageId: number): Promise<Api.Document> {
    const { Api: A } = this.gram;
    const message = (await this.messages(chat, [messageId])).get(messageId);
    const media = message?.media;
    if (!(media instanceof A.MessageMediaDocument) || !(media.document instanceof A.Document)) {
      throw new TelegramFailure(`Il messaggio ${messageId} non c'è più su Telegram, o non contiene più il file.`);
    }
    return media.document;
  }

  /**
   * A document from the start, 1 MiB at a time, with a few requests ahead of
   * the one being handed over: one at a time, a restore would wait a round
   * trip per megabyte. They are still yielded strictly in order.
   *
   * The file reference in a message expires after a while, so a long download
   * that hits FILE_REFERENCE_EXPIRED fetches the message again and carries on
   * from the same offset; a file on another data center gets a connection
   * there.
   */
  async *download(chat: TelegramChat, messageId: number, options: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {
    const { Api: A, helpers } = this.gram;
    let file = await this.fileOf(chat, messageId);
    const size = file.size.toJSNumber();
    let refreshing: Promise<void> | null = null;
    let refreshed = 0;
    let sender: Promise<Sender> | null = null;

    const fetch = async (offset: number): Promise<Buffer> => {
      for (;;) {
        const current = file;
        const request = new A.upload.GetFile({
          location: new A.InputDocumentFileLocation({
            id: current.id,
            accessHash: current.accessHash,
            fileReference: current.fileReference,
            thumbSize: "",
          }),
          offset: helpers.returnBigInt(offset),
          limit: DOWNLOAD_CHUNK_BYTES,
        });
        try {
          const via = sender ? await sender : null;
          const result = await this.call(
            () => (via ? this.client.invokeWithSender(request, via) : this.client.invoke(request)),
            "download",
            { timeoutMs: DOWNLOAD_TIMEOUT_MS, signal: options.signal, attempts: 6 }
          );
          if (!(result instanceof A.upload.File)) {
            throw new TelegramFailure("Telegram ha risposto al download con un rimando a una CDN, che il pannello non gestisce.");
          }
          return result.bytes;
        } catch (err) {
          const problem = classifyTelegramError(err);
          if (problem.kind === "file-reference") {
            // One refresh for every request that hit the same expired reference.
            if (file === current) {
              if (refreshed++ >= 5) throw err;
              refreshing ??= this.fileOf(chat, messageId).then((next) => {
                file = next;
              }).finally(() => {
                refreshing = null;
              });
            }
            await refreshing;
            continue;
          }
          if (problem.kind === "migrate" && problem.newDc) {
            sender ??= withTimeout(this.client.getSender(problem.newDc), CONNECT_TIMEOUT_MS, "data center del file");
            continue;
          }
          throw err;
        }
      }
    };

    const ahead: Promise<Buffer>[] = [];
    let next = 0;
    let offset = 0;
    while (offset < size) {
      while (ahead.length < DOWNLOAD_AHEAD && next < size) {
        const pending = fetch(next);
        // Awaited in order below. One further ahead, left behind when the
        // download stops early, must not surface as an unhandled rejection —
        // nor be waited for: closing the transport ends it.
        pending.catch(() => {});
        ahead.push(pending);
        next += DOWNLOAD_CHUNK_BYTES;
      }
      const bytes = await (ahead.shift() as Promise<Buffer>);
      if (bytes.length === 0 || (bytes.length < DOWNLOAD_CHUNK_BYTES && offset + bytes.length < size)) {
        throw new TelegramFailure(`Il file su Telegram si interrompe a ${offset + bytes.length} byte su ${size}.`);
      }
      offset += bytes.length;
      yield bytes;
    }
  }

  async remove(chat: TelegramChat, ids: number[]): Promise<void> {
    const { Api: A } = this.gram;
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const request =
        chat.kind === "channel"
          ? new A.channels.DeleteMessages({ channel: this.inputChannel(chat), id: batch })
          : new A.messages.DeleteMessages({ id: batch, revoke: true });
      await this.call(() => this.client.invoke(request), "eliminazione");
    }
  }

  /**
   * The private channel the archives go to. Created once, with the
   * destination; never retried on a dropped connection, so a timeout cannot
   * leave two channels behind.
   */
  async createChannel(title: string): Promise<Extract<TelegramChat, { kind: "channel" }>> {
    const { Api: A } = this.gram;
    const result = await this.call(
      () => this.client.invoke(new A.channels.CreateChannel({ broadcast: true, title, about: CHANNEL_ABOUT })),
      "creazione del canale",
      { attempts: 1 }
    );
    const chats = result instanceof A.Updates || result instanceof A.UpdatesCombined ? result.chats : [];
    const channel = chats.find((chat): chat is Api.Channel => chat instanceof A.Channel);
    if (!channel?.accessHash) throw new TelegramFailure("Telegram ha creato il canale ma non l'ha restituito: riprova.");
    return { kind: "channel", id: channel.id.toString(), accessHash: channel.accessHash.toString(), title: channel.title };
  }

  /**
   * A channel as this account sees it, looked up among its chats. Access
   * hashes belong to an account, so re-linking another one — an admin added
   * to the channel after the first account was lost — needs its own.
   */
  async findChannel(id: string): Promise<Extract<TelegramChat, { kind: "channel" }> | null> {
    const { Api: A } = this.gram;
    const search = async () => {
      let seen = 0;
      for await (const dialog of this.client.iterDialogs({})) {
        const entity = dialog.entity;
        if (entity instanceof A.Channel && entity.id.toString() === id && entity.accessHash) {
          return { kind: "channel" as const, id, accessHash: entity.accessHash.toString(), title: entity.title };
        }
        if (++seen >= 3000) break;
      }
      return null;
    };
    return withTelegramRetry(() => withTimeout(search(), 120_000, "ricerca del canale"), { attempts: 2 });
  }

  /** End this session at Telegram: it disappears from the account's devices. */
  async logOut(): Promise<void> {
    const { Api: A } = this.gram;
    await withTimeout(this.client.invoke(new A.auth.LogOut()), 10_000, "uscita");
  }

  async close(): Promise<void> {
    this.closed = true;
    await closeClient(this.client);
  }
}

/** A transport on a stored session. */
export async function connectTelegram(config: TelegramConfig): Promise<GramTransport> {
  const { gram, client } = await createClient(config.apiId, config.apiHash, config.session);
  await connectClient(client);
  return new GramTransport(gram, client);
}
