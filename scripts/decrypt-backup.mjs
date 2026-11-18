#!/usr/bin/env node
/**
 * Turn an encrypted RunPanel backup back into the zip it holds.
 *
 *   node decrypt-backup.mjs archivio.zip.enc              writes archivio.zip next to it
 *   node decrypt-backup.mjs archivio.zip.enc altro.zip    writes altro.zip
 *   node decrypt-backup.mjs --check archivio.zip.enc      checks password and file, writes nothing
 *
 * For the day there is no panel to do it: the server is gone, the archive is
 * in a bucket, and the instructions inside it (LEGGIMI.txt) are inside the
 * encryption too. One file, plain Node 18 or later, no dependencies and no
 * checkout: copy it onto any machine next to the archive and run it.
 *
 * The password is asked on the terminal, without echo. For a script it can
 * come from the first line of a file (`--password-file`), from the
 * RUNPANEL_BACKUP_PASSWORD variable, or piped in on standard input — never as
 * an argument, where the shell history and `ps` would keep it.
 *
 * The format is the one services/backup/archive-crypto.ts writes, read here a
 * second time on purpose with nothing shared: a header (magic, version,
 * length, JSON), then chunks of AES-256-GCM with the key from scrypt. Every
 * chunk is checked before it is written, the output is written as `.part` and
 * renamed only once the last chunk has passed, so a wrong password, a damaged
 * or a truncated file never leaves something that looks like a whole zip.
 *
 * Exit status: 0 done, 2 wrong password, 1 anything else.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const USAGE = `Uso: node decrypt-backup.mjs [opzioni] <archivio.zip.enc> [uscita.zip]

Decifra un backup di RunPanel cifrato con la password dei backup e scrive lo
zip che contiene. Senza [uscita.zip], lo scrive accanto all'archivio, senza
l'estensione .enc.

Opzioni:
  --check                  controlla password e archivio, senza scrivere niente
  --password-file <file>   legge la password dalla prima riga del file
  --force                  sovrascrive [uscita.zip] se esiste già
  -h, --help               questo aiuto

La password si può dare anche con la variabile RUNPANEL_BACKUP_PASSWORD, o
su standard input. Codici di uscita: 0 riuscito, 2 password sbagliata, 1 altro.`;

const MAGIC = Buffer.from("RPBKENC", "latin1");
const VERSION = 1;
const PREFIX_BYTES = MAGIC.length + 1 + 4;
const MAX_HEADER_BYTES = 8 * 1024;
const TAG_BYTES = 16;
const INFO_KEY = "runpanel-backup/v1/aes-256-gcm";
const INFO_CHECK = "runpanel-backup/v1/password-check";

// --- arguments ------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
let passwordFile = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--password-file") {
    passwordFile = argv[++i];
    if (!passwordFile) fail("--password-file vuole il nome di un file");
  } else if (arg.startsWith("-")) flags.add(arg);
  else positional.push(arg);
}

function fail(message, code = 1) {
  process.stderr.write(`\n${message}\n`);
  process.exit(code);
}

if (flags.has("--help") || flags.has("-h")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
for (const flag of flags) {
  if (!["--check", "--force"].includes(flag)) fail(`Opzione sconosciuta: ${flag}\n\n${USAGE}`);
}
if (positional.length < 1 || positional.length > 2) fail(USAGE);

const input = path.resolve(positional[0]);
const checkOnly = flags.has("--check");
const output = checkOnly
  ? null
  : path.resolve(positional[1] ?? (input.toLowerCase().endsWith(".enc") ? input.slice(0, -4) : `${input}.zip`));

// --- the header -----------------------------------------------------------------

const isPowerOfTwo = (n) => Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0;
const base64Of = (value, bytes) =>
  typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === bytes;

function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return buffer.subarray(0, filled);
}

function readHeader(fd) {
  const prefix = readExactly(fd, PREFIX_BYTES, 0);
  if (prefix.length < MAGIC.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
    if (prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      fail("Questo è già uno zip, non un archivio cifrato: si apre così com'è.");
    }
    fail("Non è un backup cifrato di RunPanel: manca l'intestazione RPBKENC.");
  }
  if (prefix.length < PREFIX_BYTES) fail("L'archivio è troncato: finisce dentro l'intestazione.");
  const version = prefix[MAGIC.length];
  if (version !== VERSION) fail(`Formato ${version}: questo script legge solo la versione ${VERSION}. Usa quello della versione del pannello che ha creato l'archivio.`);
  const length = prefix.readUInt32BE(MAGIC.length + 1);
  if (length === 0 || length > MAX_HEADER_BYTES) fail("L'intestazione dell'archivio è danneggiata.");
  const json = readExactly(fd, length, PREFIX_BYTES);
  if (json.length < length) fail("L'archivio è troncato: finisce dentro l'intestazione.");

  let header;
  try {
    header = JSON.parse(json.toString("utf8"));
  } catch {
    fail("L'intestazione dell'archivio è danneggiata.");
  }
  const ok =
    header &&
    header.kdf === "scrypt" &&
    header.cipher === "aes-256-gcm" &&
    isPowerOfTwo(header.N) &&
    header.N >= 2 ** 10 &&
    header.N <= 2 ** 20 &&
    Number.isSafeInteger(header.r) &&
    header.r >= 1 &&
    header.r <= 32 &&
    Number.isSafeInteger(header.p) &&
    header.p >= 1 &&
    header.p <= 4 &&
    header.N * header.r <= 2 ** 21 &&
    isPowerOfTwo(header.chunkSize) &&
    header.chunkSize >= 1024 &&
    header.chunkSize <= 4 * 1024 * 1024 &&
    base64Of(header.salt, 32) &&
    base64Of(header.check, 16);
  if (!ok) fail("L'intestazione dell'archivio è danneggiata, o non è di un formato che questo script conosce.");

  const bytes = Buffer.concat([prefix, json]);
  return { header, length: bytes.length, hash: crypto.createHash("sha256").update(bytes).digest() };
}

// --- the password ---------------------------------------------------------------

function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\nAnnullato.\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function firstLine(stream) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stream, terminal: false });
    let done = false;
    rl.on("line", (line) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(line);
    });
    rl.on("close", () => {
      if (!done) resolve("");
    });
  });
}

async function password() {
  if (passwordFile) {
    try {
      return (await firstLine(fs.createReadStream(passwordFile))).replace(/\r$/, "");
    } catch (err) {
      fail(`Non riesco a leggere ${passwordFile}: ${err.message}`);
    }
  }
  if (process.env.RUNPANEL_BACKUP_PASSWORD) return process.env.RUNPANEL_BACKUP_PASSWORD;
  if (process.stdin.isTTY) return askHidden("Password dei backup: ");
  return (await firstLine(process.stdin)).replace(/\r$/, "");
}

// --- the chunks -----------------------------------------------------------------

function deriveKeys(secret, header) {
  // NFC, as the panel does: "è" can be one code point or two depending on the keyboard.
  const master = crypto.scryptSync(Buffer.from(secret.normalize("NFC"), "utf8"), Buffer.from(header.salt, "base64"), 32, {
    N: header.N,
    r: header.r,
    p: header.p,
    maxmem: 512 * 1024 * 1024,
  });
  return {
    key: Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), INFO_KEY, 32)),
    check: Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), INFO_CHECK, 16)),
  };
}

function counter(index, into, at) {
  into.writeUInt32BE(Math.floor(index / 0x100000000), at);
  into.writeUInt32BE(index >>> 0, at + 4);
}

function openChunk(key, hash, index, final, stored) {
  const nonce = Buffer.alloc(12);
  counter(index, nonce, 4);
  const aad = Buffer.alloc(hash.length + 9);
  hash.copy(aad, 0);
  counter(index, aad, hash.length);
  aad[hash.length + 8] = final ? 1 : 0;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(stored.subarray(stored.length - TAG_BYTES));
    return Buffer.concat([decipher.update(stored.subarray(0, stored.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// --- main -----------------------------------------------------------------------

if (!fs.existsSync(input)) fail(`Il file non esiste: ${input}`);
if (output && fs.existsSync(output) && !flags.has("--force")) {
  fail(`${output} esiste già: scegli un altro nome, oppure aggiungi --force per sovrascriverlo.`);
}

const fd = fs.openSync(input, "r");
const size = fs.fstatSync(fd).size;
const { header, length, hash } = readHeader(fd);

const stride = header.chunkSize + TAG_BYTES;
const body = size - length;
const chunkCount = Math.ceil(body / stride);
const lastStored = body - (chunkCount - 1) * stride;
if (body < TAG_BYTES || lastStored < TAG_BYTES || (lastStored === TAG_BYTES && chunkCount > 1)) {
  fail("L'archivio è troncato: è più corto di quanto il suo formato permetta. Recuperane un'altra copia.");
}
const plainSize = (chunkCount - 1) * header.chunkSize + lastStored - TAG_BYTES;

const secret = await password();
if (!secret) fail("Serve la password dei backup.");
const keys = deriveKeys(secret, header);
if (!crypto.timingSafeEqual(keys.check, Buffer.from(header.check, "base64"))) {
  const when = header.keyCreatedAt ? ` (impostata nel pannello il ${new Date(header.keyCreatedAt).toLocaleString("it-IT")})` : "";
  fail(`Password sbagliata. Questo archivio è cifrato con la password dei backup${when}: se nel frattempo l'hai cambiata, serve quella di allora.`, 2);
}

const partial = output ? `${output}.part` : null;
const out = partial ? fs.openSync(partial, "w", 0o600) : null;
const showProgress = process.stderr.isTTY && plainSize > 64 * 1024 * 1024;
let lastShown = -1;

try {
  for (let index = 0; index < chunkCount; index++) {
    const final = index === chunkCount - 1;
    const stored = readExactly(fd, final ? lastStored : stride, length + index * stride);
    if (stored.length < (final ? lastStored : stride)) throw new Error("L'archivio è troncato.");
    const plain = openChunk(keys.key, hash, index, final, stored);
    if (!plain) {
      throw new Error(
        `Il blocco ${index + 1} di ${chunkCount} non supera il controllo: l'archivio è danneggiato o è stato modificato. Recuperane un'altra copia.`
      );
    }
    if (out !== null) fs.writeSync(out, plain);
    if (showProgress) {
      const percent = Math.floor(((index + 1) / chunkCount) * 100);
      if (percent !== lastShown) {
        lastShown = percent;
        process.stderr.write(`\r  ${percent}%`);
      }
    }
  }
  if (showProgress) process.stderr.write("\n");
  if (out !== null) {
    fs.fsyncSync(out);
    fs.closeSync(out);
    fs.renameSync(partial, output);
  }
} catch (err) {
  if (out !== null) {
    fs.closeSync(out);
    fs.rmSync(partial, { force: true });
  }
  fail(err instanceof Error ? err.message : String(err));
} finally {
  fs.closeSync(fd);
}

process.stdout.write(
  output
    ? `Fatto: ${output} (${formatBytes(plainSize)}). È lo zip del backup: dentro c'è LEGGIMI.txt con le istruzioni di ripristino.\n`
    : `Password giusta e archivio integro: ${chunkCount} blocchi controllati, ${formatBytes(plainSize)} di zip.\n`
);
