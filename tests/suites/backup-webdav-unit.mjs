import { createReporter } from "../harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { loadTs } from "../ts-modules.mjs";
import { startWebdav } from "../webdav-fake.mjs";

/**
 * The WebDAV destination, end to end, against a WebDAV server running in this
 * process (tests/webdav-fake.mjs).
 *
 * Every operation the panel uses — put, stat, open, remove, "Verifica" — on
 * real HTTP, with names that need encoding (spaces, quotes, accents, `#`, `?`,
 * `%`), and every failure that has a sentence: wrong password, read-only
 * share, delete refused, missing URL, redirect, a proxy's 413, a full quota,
 * and the one that matters most — a connection cut in the middle of an upload,
 * which must leave no file with the archive's name.
 */
export const meta = { name: "backup-webdav-unit", needsDocker: false, drivers: [], standalone: true };

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("backup-webdav-unit");
  const webdav = await loadTs(repoRoot, "services", "backup", "destinations", "webdav.ts");
  const { DestinationFailure } = await loadTs(repoRoot, "services", "backup", "destinations", "problem.ts");
  const net = await loadTs(repoRoot, "services", "backup", "destinations", "net-errors.ts");

  // --- URLs ---------------------------------------------------------------------
  const base = "https://cloud.example.com/remote.php/dav/files/alice/";
  r.check("a path under the root", webdav.webdavUrl(base, "Backup/x.zip") === `${base}Backup/x.zip`);
  r.check("a root without its slash gets one", webdav.webdavUrl(base.slice(0, -1), "x.zip") === `${base}x.zip`);
  r.check("a folder gets its trailing slash", webdav.webdavUrl(base, "Backup/run", true) === `${base}Backup/run/`);
  r.check(
    "spaces, quotes and accents are encoded per segment",
    webdav.webdavUrl(base, "run panel/it's \"x\"/città.zip") === `${base}run%20panel/it%27s%20%22x%22/citt%C3%A0.zip`,
    webdav.webdavUrl(base, "run panel/it's \"x\"/città.zip")
  );
  r.check("characters a URL would read as syntax are encoded", webdav.webdavUrl(base, "a#b?c%d.zip") === `${base}a%23b%3Fc%25d.zip`);
  r.check("parentheses and stars too, strictly", webdav.webdavUrl(base, "(1)*.zip") === `${base}%281%29%2A.zip`);
  r.check("empty segments disappear", webdav.webdavUrl(base, "a//b/") === `${base}a/b`);
  {
    const parsed = webdav.parsePropfind('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getcontentlength>4242</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>');
    r.check("a multistatus gives the size", parsed.size === 4242 && parsed.collection === false);
    const folder = webdav.parsePropfind('<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:quota-available-bytes>99</D:quota-available-bytes></D:prop></D:propstat></D:response></D:multistatus>');
    r.check("whatever the prefix, a folder is a folder", folder.collection === true && folder.available === 99);
  }

  // --- statuses -----------------------------------------------------------------
  {
    const ctx = { host: "cloud.example.com", folder: "RunPanel", step: "upload" };
    const said = (status, extra = {}) => webdav.describeWebdavStatus({ status, ...extra }, { ...ctx, ...(extra.ctx ?? {}) });
    r.check("401 points to the app password, and where Nextcloud makes one", said(401).code === "AUTH" && /password per app/.test(said(401).fix) && /Sicurezza/.test(said(401).fix));
    r.check("403 is a permission, with the verb", said(403).code === "PERMISSION" && said(403).cause.includes("scrivere"));
    r.check("404 on a write is the wrong URL, with Nextcloud's shape", said(404).code === "NO_URL" && said(404).fix.includes("remote.php/dav/files"));
    r.check("404 on a read is a missing archive", said(404, { ctx: { step: "download" } }).code === "NOT_FOUND");
    const tooLarge = said(413, { ctx: { bytes: 3 * 1024 ** 3 } });
    r.check("413 names the proxy limits", tooLarge.code === "TOO_LARGE" && /client_max_body_size/.test(tooLarge.fix) && /Cloudflare/.test(tooLarge.fix), tooLarge.fix);
    r.check("507 is a full quota", said(507).code === "QUOTA");
    r.check("a redirect says where to", said(301, { location: "https://cloud.example.com/dav/" }).cause.includes("https://cloud.example.com/dav/"));
    r.check("504 is the proxy's timeout", said(504).code === "PROXY" && /proxy_read_timeout/.test(said(504).fix));
    r.check("Sabre's own message reaches the detail", (webdav.describeWebdavStatus({ status: 403, body: "<d:error><s:message>Insufficient permissions</s:message></d:error>" }, ctx).detail ?? "").includes("Insufficient permissions"));
    r.check(
      "an HTML error page is reduced to its title",
      webdav.describeWebdavStatus({ status: 502, body: "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>" }, ctx).detail === "HTTP 502: 502 Bad Gateway"
    );
    const reset = net.describeNetworkError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }), { host: "cloud.example.com", uploading: true });
    r.check("a reset during an upload points to the proxy's body limit", reset.code === "RESET" && /client_max_body_size/.test(reset.fix));
    const dns = net.describeNetworkError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }) }), { host: "x", uploading: false });
    r.check("an unknown host is DNS", dns.code === "DNS");
  }

  // --- end to end -------------------------------------------------------------------
  const scratch = fs.mkdtempSync(join(os.tmpdir(), "rp-webdav-unit-"));
  const server = await startWebdav({ root: join(scratch, "dav") });
  try {
    const config = { url: server.url, username: "utente", password: "password-per-app", folder: "Backup/run panel/«archivi»" };
    const destination = (overrides = {}) => webdav.webdavDestination({ id: "w1", name: "Nextcloud", type: "webdav" }, { ...config, ...overrides });
    const onDisk = (...parts) => join(scratch, "dav", "Backup", "run panel", "«archivi»", ...parts);

    r.check(
      "the same address and folder is the same place, whatever the spelling",
      destination().location() === destination({ url: server.url.replace(/\/$/, "").replace("127.0.0.1", "127.0.0.1") }).location()
    );
    r.check("another folder is another place", destination().location() !== destination({ folder: "Altrove" }).location());

    const check = await destination().test();
    r.check("Verifica creates the folders and passes", check.ok === true && fs.statSync(onDisk()).isDirectory(), JSON.stringify(check));
    r.check("it says how much space is left", /Spazio libero/.test(check.message), check.message);
    r.check("and leaves nothing behind", fs.readdirSync(onDisk()).length === 0);
    r.check("it moved the probe like an upload would", server.requests.some((req) => req.method === "MOVE"));
    r.check("every request carried the credentials", server.requests.every((req) => req.headers.authorization?.startsWith("Basic ")));

    const archive = join(scratch, "archive.zip");
    const payload = crypto.randomBytes(2 * 1024 * 1024 + 7);
    fs.writeFileSync(archive, payload);
    const name = "runpanel-20261118-030000-notte #1 (it's)-abc123.zip";
    const stored = await destination().put(archive, name);
    r.check("put returns the path under the folder", stored.ref === `Backup/run panel/«archivi»/${name}` && stored.bytes === payload.length, JSON.stringify(stored));
    r.check("the server has exactly that file, nothing provisional", fs.readdirSync(onDisk()).join("|") === name, fs.readdirSync(onDisk()).join("|"));
    r.check("with every byte", fs.readFileSync(onDisk(name)).equals(payload));
    const put = server.requests.filter((req) => req.method === "PUT").at(-1);
    r.check("it was PUT under a provisional name first", /\.partial$/.test(decodeURIComponent(put.path)), put.path);
    r.check("with its length declared", put.headers["content-length"] === String(payload.length));

    const st = await destination().stat(stored.ref);
    r.check("stat reads the size with PROPFIND", st.exists && st.bytes === payload.length, JSON.stringify(st));
    r.check("and a missing archive is missing", (await destination().stat("Backup/nope.zip")).exists === false);
    const back = await collect(await destination().open(stored.ref));
    r.check("open streams it back", back.equals(payload));
    const missing = await rejects(destination().open("Backup/nope.zip"));
    r.check("opening a missing archive says so", missing instanceof DestinationFailure && missing.problem.code === "NOT_FOUND");

    await destination().remove(stored.ref);
    r.check("remove deletes it", !fs.existsSync(onDisk(name)));
    await destination().remove(stored.ref);
    r.check("and removing it again is fine", true);

    // A connection cut in the middle: the backup fails, no archive appears.
    server.knobs.cutAfter = 256 * 1024;
    const cut = await rejects(destination().put(archive, "cut.zip"));
    r.check("a cut upload fails", cut instanceof DestinationFailure, String(cut));
    r.check("and is diagnosed as the size limit, since small files go through", cut?.problem?.code === "BODY_LIMIT" && /client_max_body_size/.test(cut.problem.fix), cut ? `${cut.problem?.code}: ${cut.message}` : "");
    const afterCut = fs.readdirSync(onDisk());
    r.check("no file has the archive's name", !afterCut.includes("cut.zip"), afterCut.join("|"));
    r.check("and the provisional one was cleaned up", afterCut.length === 0, afterCut.join("|"));
    delete server.knobs.cutAfter;

    server.knobs.maxBody = 1024 * 1024;
    const tooLarge = await rejects(destination().put(archive, "big.zip"));
    // Like nginx, the fake answers 413 and hangs up while the body is still
    // arriving: whether the client reads the answer first or sees the hang-up
    // first is a race, and either way the sentence has to name the limit.
    r.check(
      "a 413 from the proxy is explained, with the size and the setting",
      ["TOO_LARGE", "BODY_LIMIT"].includes(tooLarge?.problem?.code) && tooLarge.message.includes("2.0 MB") && /client_max_body_size/.test(tooLarge.message),
      tooLarge?.message
    );
    r.check("and leaves nothing", fs.readdirSync(onDisk()).length === 0);
    delete server.knobs.maxBody;

    server.knobs.quota = 1024;
    const full = await rejects(destination().put(archive, "full.zip"));
    r.check("a full quota is explained", full?.problem?.code === "QUOTA", full?.message);
    delete server.knobs.quota;

    const wrong = await destination({ password: "sbagliata" }).test();
    r.check("a wrong password fails Verifica with the app password hint", wrong.ok === false && wrong.code === "AUTH" && /password per app/.test(wrong.message), JSON.stringify(wrong));
    r.check("and never shows the password", !JSON.stringify(wrong).includes("sbagliata"));

    server.knobs.readOnly = true;
    const readOnly = await destination().test();
    r.check("a read-only share fails Verifica on the write", readOnly.ok === false && readOnly.code === "PERMISSION", JSON.stringify(readOnly));
    delete server.knobs.readOnly;

    server.knobs.noDelete = true;
    const noDelete = await destination().test();
    r.check("a share where nothing can be deleted passes with a warning", noDelete.ok === true && noDelete.warning === true && /retention/.test(noDelete.message), JSON.stringify(noDelete));
    delete server.knobs.noDelete;
    for (const leftover of fs.readdirSync(onDisk())) fs.rmSync(onDisk(leftover));

    server.knobs.noMove = true;
    const noMove = await destination().test();
    r.check("a server that refuses MOVE fails Verifica, saying it is needed", noMove.ok === false && /MOVE/.test(noMove.message), JSON.stringify(noMove));
    r.check("and its probe is cleaned up", fs.readdirSync(onDisk()).length === 0, fs.readdirSync(onDisk()).join("|"));
    delete server.knobs.noMove;

    const wrongUrl = await destination({ url: server.url.replace("/dav/", "/altro/") }).test();
    r.check("a wrong URL is explained", wrongUrl.ok === false && wrongUrl.code === "NO_URL", JSON.stringify(wrongUrl));

    server.knobs.redirect = true;
    const redirected = await destination().test();
    r.check("a redirect is reported, not followed", redirected.ok === false && redirected.code === "REDIRECT" && redirected.message.includes("https://cloud.example.com"), JSON.stringify(redirected));
    delete server.knobs.redirect;

    // A port that was free a moment ago (fetch refuses the well-known low ones outright).
    const { createServer } = await import("node:net");
    const closedPort = await new Promise((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const refused = await destination({ url: `http://127.0.0.1:${closedPort}/dav/` }).test();
    r.check("nothing listening is explained", refused.ok === false && refused.code === "REFUSED", JSON.stringify(refused));

    const incomplete = await webdav.webdavDestination({ id: "w2", name: "x", type: "webdav" }, { url: server.url }).test();
    r.check("an incomplete configuration says what is missing", incomplete.ok === false && /incompleta/.test(incomplete.message));

    const topLevel = await destination({ folder: "" }).put(archive, "top.zip");
    r.check("an empty folder writes at the root", topLevel.ref === "top.zip" && fs.existsSync(join(scratch, "dav", "top.zip")));

    const controller = new AbortController();
    const bigFile = join(scratch, "big.zip");
    fs.writeFileSync(bigFile, crypto.randomBytes(16 * 1024 * 1024));
    const pending = destination().put(bigFile, "aborted.zip", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const aborted = await rejects(pending);
    r.check("an upload can be cancelled", aborted instanceof DestinationFailure && aborted.problem.code === "ABORTED", aborted ? `${aborted.problem?.code}` : "finished");
    await new Promise((resolve) => setTimeout(resolve, 100));
    r.check("and leaves no file with its name", !fs.existsSync(onDisk("aborted.zip")));
  } finally {
    await server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  return r.result();
}
