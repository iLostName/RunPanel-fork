/**
 * A WebDAV server in a few dozen lines of node:http, backed by a folder.
 *
 * Enough of RFC 4918 for what the WebDAV destination does — PROPFIND (depth
 * 0), MKCOL, PUT, GET, MOVE, DELETE — with Basic authentication, the status
 * codes Nextcloud and Synology answer with, and knobs for the failures that
 * matter: a body over a proxy's limit (413), a connection cut in the middle of
 * an upload, a full quota (507), a read-only share, a delete refused, a
 * redirect. Used by the unit suite directly and by the backups suite, where
 * the panel itself writes its archives here.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export async function startWebdav({ root, username = "utente", password = "password-per-app", knobs = {} }) {
  fs.mkdirSync(root, { recursive: true });
  const requests = [];
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  const local = (pathname) => {
    const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\"))) return null;
    const dav = segments[0] === "dav" ? segments.slice(1) : null;
    return dav ? path.join(root, ...dav) : null;
  };

  const reply = (res, status, body = "", headers = {}) => {
    res.writeHead(status, { "content-type": "application/xml; charset=utf-8", ...headers });
    res.end(body);
  };

  const sabre = (message) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\\DAV\\Exception</s:exception><s:message>${message}</s:message></d:error>`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });

    if (knobs.redirect) return reply(res, 301, "", { location: `https://cloud.example.com${url.pathname}` });
    if (req.headers.authorization !== expected) {
      return reply(res, 401, sabre("No public access to this resource."), { "www-authenticate": 'Basic realm="fake"' });
    }
    const file = local(url.pathname);
    if (!file) return reply(res, 404, sabre("Not found"));
    const parentExists = fs.existsSync(path.dirname(file));
    const writes = ["PUT", "MKCOL", "MOVE", "DELETE"].includes(req.method);
    if (writes && knobs.readOnly) return reply(res, 403, sabre("Permission denied"));

    switch (req.method) {
      case "PROPFIND": {
        req.resume();
        if (!fs.existsSync(file)) return reply(res, 404, sabre("File not found"));
        const stat = fs.statSync(file);
        const props = stat.isDirectory()
          ? `<d:resourcetype><d:collection/></d:resourcetype><d:quota-available-bytes>${knobs.available ?? 123456789}</d:quota-available-bytes>`
          : `<d:resourcetype/><d:getcontentlength>${stat.size}</d:getcontentlength>`;
        return reply(
          res,
          207,
          `<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:"><d:response><d:href>${url.pathname}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
        );
      }
      case "MKCOL":
        req.resume();
        if (fs.existsSync(file)) return reply(res, 405, sabre("The resource you tried to create already exists"));
        if (!parentExists) return reply(res, 409, sabre("Parent node does not exist"));
        fs.mkdirSync(file);
        return reply(res, 201);
      case "PUT": {
        const declared = Number(req.headers["content-length"] ?? -1);
        if (knobs.maxBody !== undefined && declared > knobs.maxBody) {
          req.resume();
          return reply(res, 413, "<html><head><title>413 Request Entity Too Large</title></head><body>nginx</body></html>", { "content-type": "text/html", connection: "close" });
        }
        if (knobs.quota !== undefined && declared > knobs.quota) {
          req.resume();
          return reply(res, 507, sabre("Insufficient space in /dav"));
        }
        if (!parentExists) {
          req.resume();
          return reply(res, 409, sabre("Parent node does not exist"));
        }
        const existed = fs.existsSync(file);
        const out = fs.createWriteStream(file);
        let received = 0;
        req.on("data", (chunk) => {
          received += chunk.length;
          if (knobs.cutAfter !== undefined && received >= knobs.cutAfter && declared > knobs.cutAfter) {
            // What a proxy over its limit does more often than answering: hang up.
            out.end();
            req.socket.destroy();
            return;
          }
          out.write(chunk);
        });
        req.on("end", () => out.end(() => reply(res, existed ? 204 : 201)));
        req.on("error", () => out.end());
        return;
      }
      case "GET":
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return reply(res, 404, sabre("File not found"));
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fs.statSync(file).size });
        fs.createReadStream(file).pipe(res);
        return;
      case "DELETE":
        req.resume();
        if (knobs.noDelete) return reply(res, 403, sabre("Permission denied"));
        if (!fs.existsSync(file)) return reply(res, 404, sabre("File not found"));
        fs.rmSync(file, { recursive: true, force: true });
        return reply(res, 204);
      case "MOVE": {
        req.resume();
        if (knobs.noMove) return reply(res, 403, sabre("Permission denied"));
        const destination = req.headers.destination ? local(new URL(req.headers.destination).pathname) : null;
        if (!destination) return reply(res, 400, sabre("Destination header missing"));
        if (!fs.existsSync(file)) return reply(res, 404, sabre("File not found"));
        if (fs.existsSync(destination) && req.headers.overwrite === "F") return reply(res, 412, sabre("Destination exists"));
        if (!fs.existsSync(path.dirname(destination))) return reply(res, 409, sabre("Parent node does not exist"));
        fs.renameSync(file, destination);
        return reply(res, 201);
      }
      default:
        req.resume();
        return reply(res, 405, sabre("Method not allowed"));
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/dav/`,
    port,
    requests,
    knobs,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
