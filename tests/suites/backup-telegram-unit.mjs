import { createReporter } from "../harness.mjs";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Telegram as a backup destination, with no Telegram.
 *
 * The destination's own logic — where an archive is split, what each caption
 * says, what the stored reference holds, the order the parts come back in,
 * what `stat` says about a part deleted by hand, that `remove` takes every
 * part and a failed upload leaves none, Premium against no Premium, the retry
 * policy and the Italian sentences — runs against an in-memory account behind
 * the `TelegramTransport` interface, with parts of a few bytes so every
 * boundary can be hit exactly.
 *
 * Then the GramJS side (`telegram-client.ts`) runs against a fake MTProto
 * client that answers with real GramJS objects: every request it builds is
 * serialised with `getBytes()` (a missing or mistyped field fails there, or is
 * logged by GramJS and caught here), uploads are reassembled piece by piece,
 * downloads go through a FILE_REFERENCE_EXPIRED in the middle.
 *
 * What this cannot reach: a real connection, the login itself (QR, code,
 * two-step password, data center migration), Telegram's real limits and
 * waits, and Premium as a real account reports it. See the report.
 *
 * Standalone. `telegram.ts` imports `@/lib/format` and the client its
 * neighbours without an extension; the hook below resolves both.
 */
export const meta = { name: "backup-telegram-unit", needsDocker: false, drivers: [], standalone: true };

/** Deterministic bytes, so a failure reproduces. */
function bytes(size, seed = 7) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** "4 × 96": how a reference split an archive, for a failure's detail. */
function stored(ref) {
  return ref ? `${ref.ids.length} × ${ref.partBytes}` : "null";
}

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

const CHANNEL = { kind: "channel", id: "777", accessHash: "-123", title: "RunPanel · backup di prova" };
const CONFIG = { apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef", session: "1BQANOTREAL", chat: CHANNEL };

/**
 * An account in memory. Parts of 16-byte pieces, 8 pieces per file without
 * Premium and 16 with, 2 kept as margin: 96 and 224 bytes per part.
 */
function fakeAccount(options = {}) {
  const state = {
    premium: options.premium ?? false,
    messages: new Map(),
    nextId: options.firstId ?? 100,
    idStep: options.idStep ?? 1,
    uploads: 0,
    pieceSizes: [],
    connections: 0,
    closed: 0,
    removed: [],
    failPostAt: options.failPostAt ?? null,
    revoked: options.revoked ?? false,
    refuseDelete: options.refuseDelete ?? false,
    shortStore: options.shortStore ?? false,
  };
  const keyOf = (chat) => (chat.kind === "saved" ? "me" : `c${chat.id}`);
  const revokedError = () => Object.assign(new Error("401: AUTH_KEY_UNREGISTERED"), { errorMessage: "AUTH_KEY_UNREGISTERED", code: 401 });

  const connect = async (config) => {
    state.connections++;
    state.lastConfig = config;
    return {
      async account() {
        if (state.revoked) throw revokedError();
        return { id: "42", name: "Mario Rossi", username: "mario", premium: state.premium };
      },
      async maxFileParts(premium) {
        return premium ? 16 : 8;
      },
      async upload({ chunks, bytes: total, chunkBytes, fileName }) {
        const pieces = [];
        for await (const chunk of chunks) {
          state.pieceSizes.push(chunk.length);
          if (chunk.length > chunkBytes) throw new Error(`piece of ${chunk.length} > ${chunkBytes}`);
          pieces.push(Buffer.from(chunk));
        }
        const data = Buffer.concat(pieces);
        if (data.length !== total) throw new Error(`upload of ${data.length} bytes announced as ${total}`);
        state.uploads++;
        return { data, fileName };
      },
      async post(chat, file, { fileName, caption }) {
        if (state.failPostAt !== null && state.messages.size + 1 === state.failPostAt) {
          throw Object.assign(new Error("400: CHAT_WRITE_FORBIDDEN"), { errorMessage: "CHAT_WRITE_FORBIDDEN", code: 400 });
        }
        const id = state.nextId;
        state.nextId += state.idStep;
        const data = state.shortStore ? file.data.subarray(0, Math.max(1, file.data.length - 1)) : file.data;
        state.messages.set(id, { chat: keyOf(chat), data, caption, fileName });
        return id;
      },
      async documents(chat, ids) {
        return ids.map((id) => {
          const message = state.messages.get(id);
          return message && message.chat === keyOf(chat)
            ? { messageId: id, bytes: message.data.length, caption: message.caption, fileName: message.fileName }
            : null;
        });
      },
      async *download(chat, id) {
        const message = state.messages.get(id);
        if (!message || message.chat !== keyOf(chat)) throw new Error(`message ${id} not found`);
        // Odd-sized chunks, so nothing lines up with the parts by accident.
        for (let i = 0; i < message.data.length; i += 7) yield message.data.subarray(i, i + 7);
      },
      async remove(chat, ids) {
        if (state.refuseDelete) {
          throw Object.assign(new Error("403: MESSAGE_DELETE_FORBIDDEN"), { errorMessage: "MESSAGE_DELETE_FORBIDDEN", code: 403 });
        }
        for (const id of ids) {
          if (state.messages.get(id)?.chat === keyOf(chat)) {
            state.messages.delete(id);
            state.removed.push(id);
          }
        }
      },
      async close() {
        state.closed++;
      },
    };
  };
  return { state, connect };
}

export async function run({ repoRoot }) {
  const r = createReporter("backup-telegram-unit");

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) {
        const target = join(repoRoot, specifier.slice(2));
        return nextResolve(pathToFileURL(/\.[a-z]+$/i.test(target) ? target : `${target}.ts`).href, context);
      }
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      const fromTs = context.parentURL?.endsWith(".ts");
      return nextResolve(extensionless && fromTs ? `${specifier}.ts` : specifier, context);
    },
  });
  const tg = await import(pathToFileURL(join(repoRoot, "services", "backup", "destinations", "telegram.ts")).href);
  const {
    TELEGRAM_CHUNK_BYTES,
    TELEGRAM_MAX_FILE_PARTS,
    TELEGRAM_MARGIN_CHUNKS,
    partBytesFor,
    planParts,
    partFileName,
    partCaption,
    parseCaption,
    encodeTelegramRef,
    parseTelegramRef,
    classifyTelegramError,
    telegramProblemText,
    withTelegramRetry,
    telegramDestination,
  } = tg;

  const dir = mkdtempSync(join(tmpdir(), "rp-telegram-"));
  const archive = (size, seed) => {
    const file = join(dir, `archive-${size}-${seed ?? 7}.zip.enc`);
    const data = bytes(size, seed);
    writeFileSync(file, data);
    return { file, data };
  };
  const ROW = { id: "dest1", name: "Telegram", type: "telegram" };
  const destination = (account, extra = {}) =>
    telegramDestination(ROW, { ...CONFIG, ...extra }, { connect: account.connect, chunkBytes: 16, marginChunks: 2 });
  const NAME = "runpanel-20261118-030000-notturno-abc123def456.zip.enc";

  try {
    // --- The limits, from the upload rules ---------------------------------------
    {
      const regular = partBytesFor(TELEGRAM_MAX_FILE_PARTS.regular);
      const premium = partBytesFor(TELEGRAM_MAX_FILE_PARTS.premium);
      r.check("the upload piece is Telegram's largest: 512 KiB, which divides 512 KiB", TELEGRAM_CHUNK_BYTES === 524288 && 524288 % TELEGRAM_CHUNK_BYTES === 0);
      r.check("without Premium a part is 1980 MiB: 4000 pieces less a 20 MiB margin", regular === 1980 * 1024 * 1024, String(regular));
      r.check("with Premium, 3980 MiB: 8000 pieces less the same margin", premium === 3980 * 1024 * 1024, String(premium));
      r.check("both under the file limit Telegram enforces", regular < 4000 * 524288 && premium < 8000 * 524288);
      r.check("and whole pieces, so only the last piece of a part is ever short", regular % TELEGRAM_CHUNK_BYTES === 0 && premium % TELEGRAM_CHUNK_BYTES === 0);
      r.check("the margin is 40 pieces", TELEGRAM_MARGIN_CHUNKS === 40);
    }

    // --- Splitting at exact boundaries -----------------------------------------
    {
      const sizes = (total) => planParts(total, 96).map((part) => part.length).join(",");
      r.check("one byte is one part", sizes(1) === "1");
      r.check("exactly one part's worth is one part", sizes(96) === "96");
      r.check("one byte more is a second part of one byte", sizes(97) === "96,1");
      r.check("exactly two parts' worth is two full parts", sizes(192) === "96,96");
      r.check("offsets follow each other", planParts(200, 96).map((part) => part.offset).join(",") === "0,96,192");
      r.check("an empty archive is refused", (await rejects(Promise.resolve().then(() => planParts(0, 96)))) !== null);
      r.check("a single part keeps the archive's name", partFileName(NAME, 0, 1) === NAME);
      r.check("parts are numbered from 001, zero-padded", partFileName(NAME, 1, 3) === `${NAME}.002`);
      r.check("past 999 parts the padding grows, so `cat name.*` still sorts", partFileName(NAME, 0, 1200) === `${NAME}.0001`);
    }

    // --- Captions --------------------------------------------------------------
    {
      const sha = "a".repeat(64);
      const caption = partCaption({ fileName: NAME, index: 1, count: 3, bytes: 96, sha256: sha });
      const parsed = parseCaption(caption);
      r.check("a caption names the archive", caption.includes(NAME));
      r.check("the part and how many there are", caption.includes("Parte 2 di 3"));
      r.check("and its checksum", caption.includes(`sha256 ${sha}`));
      r.check("and how to put the parts back together without the panel", caption.includes(`cat ${NAME}.* > ${NAME}`));
      r.check("a single part does not talk about joining", !partCaption({ fileName: NAME, index: 0, count: 1, bytes: 5, sha256: sha }).includes("cat "));
      r.check(
        "it reads back",
        parsed?.fileName === NAME && parsed.index === 1 && parsed.count === 3 && parsed.bytes === 96 && parsed.sha256 === sha,
        JSON.stringify(parsed)
      );
      r.check("a caption that is not ours reads as nothing", parseCaption("ciao") === null && parseCaption("") === null);
    }

    // --- The reference ------------------------------------------------------------
    {
      const ref = { chat: "c777", partBytes: 96, total: 200, ids: [105, 101, 103], fileName: NAME };
      const text = encodeTelegramRef(ref);
      const back = parseTelegramRef(text);
      r.check("a reference round-trips", JSON.stringify(back) === JSON.stringify(ref), text);
      r.check("keeps the ids in part order, not sorted", back?.ids.join(",") === "105,101,103");
      r.check("ends with the archive's name, which the download names the file by", basename(text) === NAME);
      r.check("Saved Messages is `me`", parseTelegramRef(encodeTelegramRef({ ...ref, chat: "me" }))?.chat === "me");
      r.check("ids that do not match the parts are refused", parseTelegramRef(text.replace("105,101,103", "105,101")) === null);
      r.check("a repeated id is refused", parseTelegramRef(text.replace("105,101,103", "105,105,103")) === null);
      r.check("a path in the name is refused", parseTelegramRef(`${text.split("/")[0]}/../secret`) === null);
      r.check("another scheme is refused", parseTelegramRef("2026/11/archivio.zip") === null && parseTelegramRef(`tg2${text.slice(3)}`) === null);
      r.check("an id beyond Telegram's range is refused", parseTelegramRef(`tg1:me:96:10:4294967296/${NAME}`) === null);
    }

    // --- Uploading: Premium or not, and the split -----------------------------------
    {
      const account = fakeAccount();
      const { file, data } = archive(96);
      const lines = [];
      const stored = await destination(account).put(file, NAME, { log: (line) => lines.push(line) });
      const ref = parseTelegramRef(stored.ref);
      r.check("an archive of exactly one part goes up as one message", ref?.ids.length === 1 && account.state.messages.size === 1, stored.ref);
      r.check("whole, under its own name", account.state.messages.get(ref.ids[0])?.data.equals(data) && account.state.messages.get(ref.ids[0])?.fileName === NAME);
      r.check("the size returned is the archive's", stored.bytes === 96);
      r.check("the run log says who and with which limit", lines.some((line) => line.includes("Mario Rossi (@mario)") && line.includes("senza Premium")), lines.join(" | "));
      r.check("pieces are never larger than the piece size, only the last is short", account.state.pieceSizes.every((size) => size === 16));
      r.check("the connection is closed afterwards", account.state.closed === account.state.connections);
    }
    {
      const account = fakeAccount();
      const { file, data } = archive(97);
      const stored = await destination(account).put(file, NAME);
      const ref = parseTelegramRef(stored.ref);
      const [first, second] = ref.ids.map((id) => account.state.messages.get(id));
      r.check("one byte more makes two messages", ref.ids.length === 2);
      r.check("the second holds exactly that byte", second?.data.length === 1 && second.data[0] === data[96]);
      r.check("each one named as a part", first?.fileName === `${NAME}.001` && second?.fileName === `${NAME}.002`);
      const caption = parseCaption(second?.caption);
      r.check(
        "and captioned with its own checksum",
        caption?.index === 1 && caption.count === 2 && caption.sha256 === createHash("sha256").update(data.subarray(96)).digest("hex")
      );
      r.check("the reference records the part size and the total", ref.partBytes === 96 && ref.total === 97);
    }
    {
      const { file } = archive(300, 3);
      const regular = fakeAccount({ premium: false });
      const premium = fakeAccount({ premium: true });
      const a = parseTelegramRef((await destination(regular).put(file, NAME)).ref);
      const b = parseTelegramRef((await destination(premium).put(file, NAME)).ref);
      r.check("without Premium, 300 bytes are 4 parts of up to 96", a.ids.length === 4 && a.partBytes === 96, stored(a));
      r.check("with Premium, 2 parts of up to 224", b.ids.length === 2 && b.partBytes === 224, stored(b));
      // Premium lapsing between two runs: read at every run, never remembered.
      premium.state.premium = false;
      const c = parseTelegramRef((await destination(premium).put(file, NAME)).ref);
      r.check("Premium is read again at every run: lapsed, the next archive uses smaller parts", c.ids.length === 4, stored(c));
    }

    // --- Reading back, in order ------------------------------------------------------
    {
      // Ids going down: another message posted in between, or a client that numbers oddly.
      const account = fakeAccount({ firstId: 900, idStep: -7 });
      const { file, data } = archive(250, 5);
      const dest = destination(account);
      const { ref } = await dest.put(file, NAME);
      const parsed = parseTelegramRef(ref);
      r.check("ids that go down are kept in part order", parsed.ids.join(",") === "900,893,886", ref);
      const back = await collect(await dest.open(ref));
      r.check("the parts come back as the one archive, byte for byte", back.equals(data), `${back.length} bytes`);
      r.check("and the download closes the connection when done", account.state.closed === account.state.connections);

      const swapped = encodeTelegramRef({ ...parsed, ids: [parsed.ids[1], parsed.ids[0], parsed.ids[2]] });
      const err = await rejects(dest.open(swapped));
      r.check(
        "two ids swapped in the reference are refused instead of rebuilding a corrupt archive",
        err !== null && /non corrispondono/.test(err.message),
        String(err?.message)
      );

      // A part edited on Telegram's side: same length, different bytes.
      const middle = account.state.messages.get(parsed.ids[1]);
      middle.data = Buffer.from(middle.data);
      middle.data[3] ^= 0xff;
      const broken = await rejects(collect(await dest.open(ref)));
      r.check("a part that changed is caught by its checksum, naming the part", broken !== null && /parte 2 di 3/.test(broken.message) && /sha256/.test(broken.message), String(broken?.message));
    }

    // --- stat: every part, and a missing one ----------------------------------------------
    {
      const account = fakeAccount();
      const { file } = archive(250, 9);
      const dest = destination(account);
      const { ref } = await dest.put(file, NAME);
      const whole = await dest.stat(ref);
      r.check("stat sums every part", whole.exists === true && whole.bytes === 250, JSON.stringify(whole));

      const parsed = parseTelegramRef(ref);
      account.state.messages.delete(parsed.ids[1]);
      const gap = await dest.stat(ref);
      r.check("a part deleted by hand makes the archive missing", gap.exists === false, JSON.stringify(gap));
      r.check("and says which one", typeof gap.detail === "string" && /parte 2 di 3/.test(gap.detail), String(gap.detail));
      r.check("counting only what is left", gap.bytes === 250 - 96);
      const opened = await rejects(dest.open(ref));
      r.check("open refuses before downloading anything", opened !== null && /parte 2 di 3/.test(opened.message), String(opened?.message));

      const single = fakeAccount();
      const one = await destination(single).put(archive(10, 2).file, NAME);
      single.state.messages.clear();
      const gone = await destination(single).stat(one.ref);
      r.check("a single message gone is said as such", gone.exists === false && /non c'è più/.test(gone.detail ?? ""), String(gone.detail));
    }

    // --- remove: every part, nothing else -----------------------------------------------------
    {
      const account = fakeAccount();
      const dest = destination(account);
      const { ref } = await dest.put(archive(250, 4).file, NAME);
      const other = await dest.put(archive(20, 6).file, "runpanel-other.zip");
      await dest.remove(ref);
      const parsed = parseTelegramRef(ref);
      r.check("remove deletes every part of the archive", parsed.ids.every((id) => !account.state.messages.has(id)), account.state.removed.join(","));
      r.check("and nothing else", account.state.messages.has(parseTelegramRef(other.ref).ids[0]));
      r.check("an archive already gone removes without error", (await rejects(dest.remove(ref))) === null);
    }

    // --- A failed upload leaves nothing behind -------------------------------------------------
    {
      const account = fakeAccount({ failPostAt: 3 });
      const lines = [];
      const err = await rejects(destination(account).put(archive(300, 8).file, NAME, { log: (line) => lines.push(line) }));
      r.check("a part refused halfway fails the upload", err !== null, String(err));
      r.check("with the reason in Italian", /permesso di scrivere/.test(err?.message ?? ""), String(err?.message));
      r.check("and the parts already posted are deleted", account.state.messages.size === 0, `${account.state.messages.size} left`);
      r.check("Telegram's own code goes to the run log", lines.some((line) => line.includes("CHAT_WRITE_FORBIDDEN")), lines.join(" | "));
    }
    {
      const account = fakeAccount({ shortStore: true });
      const err = await rejects(destination(account).put(archive(150, 8).file, NAME));
      r.check("a part kept shorter than it was sent fails the upload", err !== null && /incompleto/.test(err.message), String(err?.message));
      r.check("and is cleaned up too", account.state.messages.size === 0);
    }

    // --- A session closed from the app ------------------------------------------------------------
    {
      const account = fakeAccount({ revoked: true });
      const dest = destination(account);
      const err = await rejects(dest.put(archive(50, 1).file, NAME));
      r.check("a revoked session fails the backup", err !== null);
      r.check("saying it was closed from the app and to link the account again", /chiusa dall'app/.test(err?.message ?? "") && /ricollega l'account/.test(err?.message ?? ""), String(err?.message));
      const check = await dest.test();
      r.check("the check says the same", check.ok === false && /chiusa dall'app/.test(check.message), check.message);
      r.check("with Telegram's code for expert mode", check.code === "AUTH_KEY_UNREGISTERED", String(check.code));
    }

    // --- The check ---------------------------------------------------------------------------------
    {
      const account = fakeAccount({ premium: true });
      const check = await destination(account).test();
      r.check("the check passes on a working account", check.ok === true && !check.warning, check.message);
      r.check("naming the account and Premium", check.message.includes("Mario Rossi (@mario)") && check.message.includes("con Telegram Premium"), check.message);
      r.check("the largest part", check.message.includes("parti fino a"), check.message);
      r.check("and the channel, written, read and cleaned", check.message.includes("RunPanel · backup di prova") && check.message.includes("scrittura, lettura ed eliminazione riuscite"), check.message);
      r.check("leaving nothing behind", account.state.messages.size === 0);

      const refused = await destination(fakeAccount({ refuseDelete: true })).test();
      r.check("an account that cannot delete passes with a warning: retention would not work", refused.ok === true && refused.warning === true && /retention/.test(refused.message), refused.message);

      const saved = await destination(fakeAccount(), { chat: { kind: "saved" } }).test();
      r.check("Saved Messages are named as such", saved.ok && saved.message.includes("Messaggi salvati"), saved.message);

      const empty = await telegramDestination(ROW, {}, { connect: fakeAccount().connect }).test();
      r.check("a destination with no account linked says so", empty.ok === false && /non collegato/.test(empty.message), empty.message);
    }

    // --- The chat an archive lives in ------------------------------------------------------------
    {
      const account = fakeAccount();
      const dest = destination(account);
      const { ref } = await dest.put(archive(40, 2).file, NAME);
      const elsewhere = ref.replace("tg1:c777:", "tg1:me:");
      const err = await rejects(dest.stat(elsewhere));
      r.check("a reference to another chat is refused, not looked up in this one", err !== null && /altra chat/.test(err.message), String(err?.message));
    }

    // --- Errors and the retry policy ----------------------------------------------------------------
    {
      const flood = Object.assign(new Error("420: FLOOD_WAIT_37"), { errorMessage: "FLOOD_WAIT_37", seconds: 37, code: 420 });
      const premiumFlood = { errorMessage: "FLOOD_PREMIUM_WAIT_4", seconds: 4 };
      r.check("FLOOD_WAIT is a wait, with its seconds", JSON.stringify(classifyTelegramError(flood)) === JSON.stringify({ kind: "flood", code: "FLOOD_WAIT_37", seconds: 37 }));
      r.check("so is FLOOD_PREMIUM_WAIT, Telegram slowing an account without Premium", classifyTelegramError(premiumFlood).kind === "flood");
      r.check("a closed session is recognised", ["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "AUTH_KEY_DUPLICATED"].every((code) => classifyTelegramError({ errorMessage: code }).kind === "revoked"));
      r.check("a deleted channel is recognised", classifyTelegramError({ errorMessage: "CHANNEL_INVALID" }).kind === "chat");
      r.check("a moved file says where", classifyTelegramError({ errorMessage: "FILE_MIGRATE_4", newDc: 4 }).newDc === 4);
      r.check("a dropped connection is a network problem", classifyTelegramError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })).kind === "network");
      r.check("a long wait is said in minutes", /2 minuti/.test(telegramProblemText({ errorMessage: "FLOOD_WAIT_120", seconds: 120 })));
      r.check("wrong api keys are explained with where to find them", /my\.telegram\.org/.test(telegramProblemText({ errorMessage: "API_ID_INVALID" })));

      const waits = [];
      const sleeps = [];
      const sleep = async (ms) => void sleeps.push(ms);
      let calls = 0;
      const result = await withTelegramRetry(
        async () => {
          calls++;
          if (calls === 1) throw flood;
          if (calls === 2) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
          return "ok";
        },
        { sleep, onWait: (seconds) => waits.push(seconds) }
      );
      r.check("a FLOOD_WAIT is waited out, then the call goes through", result === "ok" && calls === 3);
      r.check("for as long as Telegram asked", waits[0] === 37 && sleeps[0] >= 37_000, `${waits} / ${sleeps}`);
      r.check("a dropped connection is retried after a pause", sleeps.length === 2 && sleeps[1] > 0);

      let revokedCalls = 0;
      const revoked = await rejects(
        withTelegramRetry(
          async () => {
            revokedCalls++;
            throw { errorMessage: "SESSION_REVOKED", code: 401 };
          },
          { sleep }
        )
      );
      r.check("a revoked session is not retried", revoked !== null && revokedCalls === 1);

      const tooLong = await rejects(withTelegramRetry(async () => { throw { errorMessage: "FLOOD_WAIT_86400", seconds: 86400 }; }, { sleep }));
      r.check("a wait of a day is not sat out: it fails with its own sentence", tooLong !== null && classifyTelegramError(tooLong).seconds === 86400);

      let netCalls = 0;
      const network = await rejects(
        withTelegramRetry(
          async () => {
            netCalls++;
            throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
          },
          { sleep, attempts: 3 }
        )
      );
      r.check("a connection that stays down gives up after the attempts", network !== null && netCalls === 3, String(netCalls));

      const controller = new AbortController();
      controller.abort();
      const aborted = await rejects(withTelegramRetry(async () => "never", { signal: controller.signal }));
      r.check("a cancelled run stops at once", aborted?.name === "AbortError");
    }

    // --- The GramJS side, against a fake MTProto client ------------------------------------------------
    {
      const gram = await import("telegram");
      const client = await import(pathToFileURL(join(repoRoot, "services", "backup", "destinations", "telegram-client.ts")).href);
      const { Api, helpers } = gram;
      const big = (value) => helpers.returnBigInt(value);
      const logged = [];
      const realError = console.error;
      console.error = (...args) => logged.push(args.map(String).join(" "));

      function fakeClient(options = {}) {
        const self = big(42);
        const state = { requests: [], files: new Map(), messages: new Map(), nextId: 500, getFile: 0, expireAt: options.expireAt ?? 0, destroyed: false, reference: 1 };
        const message = (id) => {
          const stored = state.messages.get(id);
          return new Api.Message({
            id,
            peerId: stored.peer,
            date: 0,
            message: stored.caption,
            media: new Api.MessageMediaDocument({
              document: new Api.Document({
                id: big(id * 10),
                accessHash: big(9),
                fileReference: Buffer.from([state.reference]),
                date: 0,
                mimeType: "application/octet-stream",
                size: big(stored.data.length),
                dcId: 2,
                attributes: [new Api.DocumentAttributeFilename({ fileName: stored.fileName })],
              }),
            }),
          });
        };
        const fake = {
          connected: true,
          async connect() {
            return true;
          },
          async destroy() {
            state.destroyed = true;
          },
          async getSender() {
            return {};
          },
          async invokeWithSender(request) {
            return fake.invoke(request);
          },
          async invoke(request) {
            // What would go on the wire: a missing or mistyped field breaks or is logged here.
            request.getBytes();
            state.requests.push(request.className);
            switch (request.className) {
              case "users.GetUsers":
                return [new Api.User({ id: self, firstName: "Mario", lastName: "Rossi", username: "mario", premium: options.premium ?? false })];
              case "help.GetAppConfig":
                return new Api.help.AppConfig({
                  hash: 1,
                  config: new Api.JsonObject({
                    value: [
                      new Api.JsonObjectValue({ key: "upload_max_fileparts_default", value: new Api.JsonNumber({ value: options.regularParts ?? 4000 }) }),
                      new Api.JsonObjectValue({ key: "upload_max_fileparts_premium", value: new Api.JsonNumber({ value: options.premiumParts ?? 8000 }) }),
                    ],
                  }),
                });
              case "upload.SaveFilePart":
              case "upload.SaveBigFilePart": {
                const key = request.fileId.toString();
                const file = state.files.get(key) ?? { big: request.className === "upload.SaveBigFilePart", total: request.fileTotalParts, pieces: new Map() };
                file.pieces.set(request.filePart, Buffer.from(request.bytes));
                state.files.set(key, file);
                return true;
              }
              case "messages.SendMedia": {
                const input = request.media.file;
                const file = state.files.get(input.id.toString());
                const data = Buffer.concat(Array.from({ length: input.parts }, (_, i) => file.pieces.get(i) ?? Buffer.alloc(0)));
                const id = state.nextId++;
                const peer = request.peer instanceof Api.InputPeerSelf ? new Api.PeerUser({ userId: self }) : new Api.PeerChannel({ channelId: request.peer.channelId });
                state.messages.set(id, { data, caption: request.message, fileName: request.media.attributes[0].fileName, peer, input: input.className, big: file.big, total: file.total });
                return new Api.Updates({
                  updates: [new Api.UpdateMessageID({ id, randomId: request.randomId }), new Api.UpdateNewChannelMessage({ message: message(id), pts: 1, ptsCount: 1 })],
                  users: [],
                  chats: [],
                  date: 0,
                  seq: 0,
                });
              }
              case "channels.GetMessages":
              case "messages.GetMessages": {
                const messages = request.id.map(({ id }) => (state.messages.has(id) ? message(id) : new Api.MessageEmpty({ id })));
                return request.className === "channels.GetMessages"
                  ? new Api.messages.ChannelMessages({ messages, pts: 1, count: messages.length, chats: [], users: [], topics: [] })
                  : new Api.messages.Messages({ messages, chats: [], users: [], topics: [] });
              }
              case "upload.GetFile": {
                state.getFile++;
                if (state.expireAt && state.getFile === state.expireAt) {
                  state.reference++;
                  throw Object.assign(new Error("400: FILE_REFERENCE_EXPIRED"), { errorMessage: "FILE_REFERENCE_EXPIRED", code: 400 });
                }
                const stored = state.messages.get(Number(request.location.id.toString()) / 10);
                const offset = Number(request.offset.toString());
                return new Api.upload.File({ type: new Api.storage.FileUnknown(), mtime: 0, bytes: stored.data.subarray(offset, offset + request.limit) });
              }
              case "channels.DeleteMessages":
              case "messages.DeleteMessages":
                for (const id of request.id) state.messages.delete(id);
                return new Api.messages.AffectedMessages({ pts: 1, ptsCount: request.id.length });
              case "channels.CreateChannel":
                return new Api.Updates({
                  updates: [],
                  users: [],
                  chats: [new Api.Channel({ id: big(1234567890), accessHash: big("-998877"), title: request.title, photo: new Api.ChatPhotoEmpty(), date: 0 })],
                  date: 0,
                  seq: 0,
                });
              default:
                throw new Error(`unexpected ${request.className}`);
            }
          },
        };
        return { fake, state };
      }

      try {
        {
          const { fake, state } = fakeClient({ premium: true });
          const transport = new client.GramTransport(gram, fake);
          const account = await transport.account();
          r.check("GramJS: the account is read from users.getUsers", account.id === "42" && account.name === "Mario Rossi" && account.username === "mario");
          r.check("GramJS: Premium comes from the user's own flag", account.premium === true);
          r.check("GramJS: the part limits come from the app config", (await transport.maxFileParts(false)) === 4000 && (await transport.maxFileParts(true)) === 8000);
          const lower = new client.GramTransport(gram, fakeClient({ regularParts: 3000, premiumParts: 9000 }).fake);
          r.check("GramJS: a lower limit is followed, a higher one is not", (await lower.maxFileParts(false)) === 3000 && (await lower.maxFileParts(true)) === 8000);
          const channel = await transport.createChannel("RunPanel · backup di prova");
          r.check("GramJS: the channel created is read back with its access hash", channel.id === "1234567890" && channel.accessHash === "-998877" && channel.title === "RunPanel · backup di prova");
          r.check(
            "GramJS: every request so far serialised",
            ["users.GetUsers", "help.GetAppConfig", "channels.CreateChannel"].every((name) => state.requests.includes(name)),
            state.requests.join(",")
          );
        }

        {
          // Over 10 MiB: saveBigFilePart, every piece numbered, the last one short.
          const { fake, state } = fakeClient();
          const transport = new client.GramTransport(gram, fake);
          const data = randomBytes(10 * 1024 * 1024 + 1000);
          const chunks = async function* () {
            for (let i = 0; i < data.length; i += TELEGRAM_CHUNK_BYTES) yield data.subarray(i, i + TELEGRAM_CHUNK_BYTES);
          };
          let progress = 0;
          const file = await transport.upload({ chunks: chunks(), bytes: data.length, chunkBytes: TELEGRAM_CHUNK_BYTES, fileName: "big.zip", onProgress: (sent) => (progress = sent) });
          r.check("GramJS: a file over 10 MiB goes up as InputFileBig", file instanceof Api.InputFileBig && file.parts === 21, file?.className);
          const stored = [...state.files.values()][0];
          r.check("GramJS: with saveBigFilePart and the total announced", stored.big === true && stored.total === 21);
          r.check("GramJS: every piece 0…20 arrived", [...stored.pieces.keys()].sort((a, b) => a - b).join(",") === Array.from({ length: 21 }, (_, i) => i).join(","));
          r.check("GramJS: progress counts the bytes confirmed", progress === data.length);
          const id = await transport.post(CHANNEL, file, { fileName: "big.zip", caption: "RunPanel · prova", bytes: data.length });
          r.check("GramJS: the message id is found by the random id sent", state.messages.has(id), String(id));
          r.check("GramJS: the document is the file, byte for byte", state.messages.get(id).data.equals(data));
          const [doc] = await transport.documents(CHANNEL, [id]);
          r.check("GramJS: a document reads back with size, caption and name", doc?.bytes === data.length && doc.caption === "RunPanel · prova" && doc.fileName === "big.zip");
          const missing = await transport.documents(CHANNEL, [id, 99999]);
          r.check("GramJS: a deleted message reads as null", missing[1] === null && missing[0] !== null);

          // A download that hits an expired file reference on its second request.
          state.expireAt = 2;
          state.getFile = 0;
          const back = await collect(transport.download(CHANNEL, id));
          r.check("GramJS: the download survives FILE_REFERENCE_EXPIRED", back.equals(data), `${back.length} bytes`);
          r.check("GramJS: by fetching the message again", state.requests.filter((name) => name === "channels.GetMessages").length >= 3);
          await transport.remove(CHANNEL, [id]);
          r.check("GramJS: remove deletes in the channel", !state.messages.has(id) && state.requests.includes("channels.DeleteMessages"));
        }

        {
          const { fake, state } = fakeClient();
          const transport = new client.GramTransport(gram, fake);
          const data = Buffer.from("piccolo");
          const file = await transport.upload({
            chunks: (async function* () {
              yield data;
            })(),
            bytes: data.length,
            chunkBytes: TELEGRAM_CHUNK_BYTES,
            fileName: "small.txt",
          });
          r.check("GramJS: a small file goes up as InputFile", file instanceof Api.InputFile && file.parts === 1, file?.className);
          const id = await transport.post({ kind: "saved" }, file, { fileName: "small.txt", caption: "x", bytes: data.length });
          r.check("GramJS: to Saved Messages", state.messages.get(id)?.peer instanceof Api.PeerUser);
          // A message with the same id in another private chat is not ours.
          state.messages.get(id).peer = new Api.PeerUser({ userId: big(7) });
          const [other] = await transport.documents({ kind: "saved" }, [id]);
          r.check("GramJS: a message of another private chat is not taken for Saved Messages", other === null);
          state.messages.get(id).peer = new Api.PeerUser({ userId: big(42) });
          const [mine] = await transport.documents({ kind: "saved" }, [id]);
          r.check("GramJS: one in Saved Messages is", mine?.bytes === data.length);
          await transport.remove({ kind: "saved" }, [id]);
          r.check("GramJS: remove in Saved Messages revokes the message", state.requests.includes("messages.DeleteMessages") && !state.messages.has(id));
        }

        {
          // The whole destination over the GramJS transport, with pieces of 16 bytes
          // and an app config of 100 pieces less a margin of 90: parts of 160 bytes.
          const { fake, state } = fakeClient({ regularParts: 100 });
          const dest = telegramDestination(ROW, CONFIG, {
            connect: async () => new client.GramTransport(gram, fake),
            chunkBytes: 16,
            marginChunks: 90,
          });
          const { file, data } = archive(400, 11);
          const put = await dest.put(file, NAME);
          const ref = parseTelegramRef(put.ref);
          r.check("end to end: 400 bytes in parts of 160 are 3 documents", ref?.ids.length === 3 && ref.partBytes === 160, put.ref);
          r.check("end to end: the archive comes back whole", (await collect(await dest.open(put.ref))).equals(data));
          r.check("end to end: stat agrees", (await dest.stat(put.ref)).bytes === 400);
          await dest.remove(put.ref);
          r.check("end to end: remove leaves the channel empty", state.messages.size === 0);
          r.check("end to end: the client is destroyed after each operation", state.destroyed === true);
        }

        r.check("GramJS logged no type error for any request built", logged.length === 0, logged.slice(0, 3).join(" | "));
      } finally {
        console.error = realError;
      }
    }

    // --- The login's own sentences ---------------------------------------------------------------
    {
      const login = await import(pathToFileURL(join(repoRoot, "services", "backup", "telegram-login.ts")).href);
      r.check("login: a wrong code is said as such", /Codice sbagliato/.test(login.loginProblemText({ errorMessage: "PHONE_CODE_INVALID" })));
      r.check("login: a wrong password points at the two-step verification", /due passaggi/.test(login.loginProblemText({ errorMessage: "PASSWORD_HASH_INVALID" })));
      r.check("login: a number without the prefix is explained", /prefisso internazionale/.test(login.loginProblemText({ errorMessage: "PHONE_NUMBER_INVALID" })));
      r.check("login: anything else falls back to the Telegram sentences", /my\.telegram\.org/.test(login.loginProblemText({ errorMessage: "API_ID_INVALID" })));
      r.check("login: the channel is named after this server", login.suggestedChannelTitle().startsWith("RunPanel · backup di "));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
