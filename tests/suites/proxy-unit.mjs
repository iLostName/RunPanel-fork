import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

/**
 * Domains as nginx sees them: which names are accepted, and the exact
 * configuration and commands that come out.
 *
 * This is the boundary between operator text and a file a root process loads,
 * so most checks here are refusals — a name, a rule or a path that would
 * become a directive must never reach the output. The rest pins what a block
 * must contain for a certificate to renew and a restriction to hold.
 *
 * Standalone: `lib/proxy-names.ts` and `services/proxy/render.ts` have no
 * imports, so this runs with no nginx, no certbot and no Linux.
 */
export const meta = { name: "proxy-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("proxy-unit");
  const names = await import(pathToFileURL(join(repoRoot, "lib", "proxy-names.ts")).href);
  const render = await import(pathToFileURL(join(repoRoot, "services", "proxy", "render.ts")).href);
  const { normalizeDomain, normalizeSubdomain, hostnameFor, isHostname, zoneFor, wwwTwin } = names;

  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };

  // --- names -------------------------------------------------------------------
  r.check("a domain is lowercased and loses its trailing dot", normalizeDomain(" Esempio.IT. ") === "esempio.it", String(normalizeDomain(" Esempio.IT. ")));
  r.check("a domain of several labels is accepted", normalizeDomain("clienti.esempio.co.uk") === "clienti.esempio.co.uk");
  r.check("a punycode domain is accepted", normalizeDomain("xn--bcher-kva.it") === "xn--bcher-kva.it");
  for (const bad of ["localhost", "esempio", "*.esempio.it", "http://esempio.it", "esempio.it/x", "es_empio.it", "-esempio.it", "esempio-.it", "esem pio.it", "1.2.3.4", "esempio.it;", "", `${"a".repeat(64)}.it`]) {
    r.check(`the domain ${JSON.stringify(bad)} is refused`, normalizeDomain(bad) === null, String(normalizeDomain(bad)));
  }

  r.check("a subdomain is lowercased", normalizeSubdomain(" App ") === "app");
  r.check("a subdomain may hold hyphens and digits", normalizeSubdomain("api-v2") === "api-v2");
  r.check("an empty subdomain means the domain itself", normalizeSubdomain("  ") === "" && hostnameFor("", "esempio.it") === "esempio.it");
  for (const bad of ["a.b", "-app", "app-", "*", "ap p", "app;", "_app"]) {
    r.check(`the subdomain ${JSON.stringify(bad)} is refused`, normalizeSubdomain(bad) === null, String(normalizeSubdomain(bad)));
  }

  r.check("the full name is the two joined", hostnameFor("app", "esempio.it") === "app.esempio.it");
  r.check("a full name past 253 characters is refused", hostnameFor("a".repeat(63), `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.it`) === null);
  r.check("a stored hostname passes the renderer's check", isHostname("app.esempio.it") === true);
  r.check("the domain itself is a hostname too", isHostname("esempio.it") === true);

  r.check("a domain is in its own zone", zoneFor("esempio.it", ["altro.it", "esempio.it"]) === "esempio.it");
  r.check("a domain under a zone is in it", zoneFor("clienti.esempio.it", ["esempio.it"]) === "esempio.it");
  r.check("the closest zone wins", zoneFor("a.clienti.esempio.it", ["esempio.it", "clienti.esempio.it"]) === "clienti.esempio.it");
  r.check("a name that only ends the same way is not in the zone", zoneFor("altroesempio.it", ["esempio.it"]) === null);
  r.check("no zones, no zone", zoneFor("esempio.it", []) === null);

  r.check("the domain's twin is its www", JSON.stringify(wwwTwin("", "esempio.it")) === JSON.stringify({ subdomain: "www", hostname: "www.esempio.it" }));
  r.check("www's twin is the domain itself", JSON.stringify(wwwTwin("www", "esempio.it")) === JSON.stringify({ subdomain: "", hostname: "esempio.it" }));
  r.check("a domain under another has its own www", wwwTwin("", "clienti.esempio.it")?.hostname === "www.clienti.esempio.it");
  r.check("any other subdomain has no twin", wwwTwin("app", "esempio.it") === null);
  r.check("a twin too long for DNS is none", wwwTwin("", `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.${"e".repeat(60)}`) === null);

  // --- HTTP/2 syntax by nginx version ------------------------------------------------
  const { http2Syntax } = render;
  r.check("Ubuntu 24.04's 1.24 uses the listen parameter", http2Syntax("nginx version: nginx/1.24.0 (Ubuntu)") === "listen");
  r.check("1.25.1 switches to the directive", http2Syntax("nginx version: nginx/1.25.1") === "directive");
  r.check("1.27 uses the directive", http2Syntax("nginx version: nginx/1.27.3") === "directive");
  r.check("an nginx older than HTTP/2 gets none", http2Syntax("nginx version: nginx/1.9.4") === "none");
  r.check("an unreadable version gets none", http2Syntax(null) === "none" && http2Syntax("boh") === "none");

  // --- a block over HTTP ------------------------------------------------------------
  const token = "abcdefghijklmnopqrstuvwx";
  const base = {
    hostname: "app.esempio.it",
    upstreamPort: 3001,
    allow: null,
    certificate: null,
    checkToken: token,
    ipv6: true,
    http2: "directive",
    cloudflare: false,
    auth: null,
  };
  const plain = render.renderSite(base);
  r.check("it listens on 80, both families", plain.includes("    listen 80;") && plain.includes("    listen [::]:80;"));
  r.check("it names the host", plain.includes("server_name app.esempio.it;"));
  r.check("the challenge is served from the webroot", plain.includes(`root ${render.WEBROOT_DIR};`) && plain.includes("location ^~ /.well-known/acme-challenge/"));
  r.check("the routing check answers the token", plain.includes(`return 200 "${token}";`) && plain.includes(`location = ${render.CHECK_PATH}`));
  r.check("without a certificate the app is served on 80", plain.includes("proxy_pass http://127.0.0.1:3001;"));
  r.check("without a certificate there is no 443", !plain.includes("443"));
  r.check("an open name has no allow list", !plain.includes("allow ") && !plain.includes("deny all"));
  r.check("WebSockets go through", plain.includes("proxy_set_header Upgrade $http_upgrade;") && plain.includes("$runpanel_connection_upgrade"));
  r.check("the forwarded headers are set", plain.includes("X-Forwarded-Proto $scheme") && plain.includes("X-Forwarded-For $proxy_add_x_forwarded_for"));
  r.check("without IPv6 there is no [::] listen", !render.renderSite({ ...base, ipv6: false }).includes("[::]"));

  // --- with a certificate --------------------------------------------------------------
  const certificate = render.certificatePaths("app.esempio.it");
  const tls = render.renderSite({ ...base, certificate });
  // The managed-file comment comes first, then one block per port.
  const [port80, port443] = tls.split("\nserver {").slice(1);
  r.check("the certificate lives under the proxy's own directory", certificate.fullchain.startsWith(`${render.LETSENCRYPT_DIR}/live/app.esempio.it/`));
  r.check("port 80 then only redirects", port80.includes("return 301 https://$host$request_uri;") && !port80.includes("proxy_pass"));
  r.check("port 80 still serves the challenge, so renewals work", port80.includes("/.well-known/acme-challenge/"));
  r.check("443 carries the certificate", port443?.includes(`ssl_certificate ${certificate.fullchain};`) && port443.includes(`ssl_certificate_key ${certificate.privkey};`));
  r.check("443 proxies to the app", port443?.includes("proxy_pass http://127.0.0.1:3001;"));
  r.check("a recent nginx gets http2 on;", tls.includes("    http2 on;") && tls.includes("    listen 443 ssl;"));
  const old = render.renderSite({ ...base, certificate, http2: "listen" });
  r.check("an older nginx gets the listen parameter", old.includes("listen 443 ssl http2;") && !old.includes("http2 on;"));
  const none = render.renderSite({ ...base, certificate, http2: "none" });
  r.check("without HTTP/2 neither appears", !none.includes("http2"));

  // --- restricted ---------------------------------------------------------------------
  const limited = render.renderSite({ ...base, certificate, allow: ["192.168.1.0/24", "fd7a:115c:a1e0::/48"] });
  const [limited80, limited443] = limited.split("\nserver {").slice(1);
  r.check("the allow list is applied on 443", limited443?.includes("allow 192.168.1.0/24;") && limited443.includes("allow fd7a:115c:a1e0::/48;") && limited443.includes("deny all;"));
  r.check("this machine is always allowed", limited443?.includes("allow 127.0.0.1;") && limited443.includes("allow ::1;"));
  r.check("the challenge on 80 is not behind the list", !limited80.includes("deny all;"));
  const onlyHere = render.renderSite({ ...base, allow: [] });
  r.check("an empty list means this machine only", onlyHere.includes("allow 127.0.0.1;") && onlyHere.includes("deny all;") && !/allow \d+\.\d+\.\d+\.\d+\/\d+/.test(onlyHere));

  // --- behind Cloudflare's proxy ---------------------------------------------------------
  const proxied = render.renderSite({ ...base, certificate, cloudflare: true, allow: ["192.168.1.0/24"] });
  const [proxied80, proxied443] = proxied.split("\nserver {").slice(1);
  const believes = (block) => render.CLOUDFLARE_RANGES.every((range) => block.includes(`    set_real_ip_from ${range};`));
  r.check("both blocks read the visitor from CF-Connecting-IP", proxied80.includes("real_ip_header CF-Connecting-IP;") && proxied443?.includes("real_ip_header CF-Connecting-IP;"));
  r.check("and believe it only from Cloudflare's ranges", believes(proxied80) && believes(proxied443) && proxied.match(/set_real_ip_from /g).length === 2 * render.CLOUDFLARE_RANGES.length);
  r.check("the allow list still applies, to the visitor", proxied443.includes("allow 192.168.1.0/24;") && proxied443.includes("deny all;"));
  r.check("a name not on Cloudflare believes no header", !plain.includes("real_ip") && !tls.includes("real_ip"));
  r.check("Cloudflare's ranges are all plain CIDR", render.CLOUDFLARE_RANGES.every((range) => /^[0-9a-f.:]+\/\d{1,3}$/.test(range)));

  // --- behind a password -------------------------------------------------------------------
  const password = await import(pathToFileURL(join(repoRoot, "services", "proxy", "password.ts")).href);
  r.check(
    "SHA-512 crypt matches the reference vector",
    password.sha512Crypt("Hello world!", "saltstring") ===
      "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"
  );
  const hash = password.hashPassword("una-password-lunga");
  r.check("a hash is $6$ with a fresh 16-character salt", /^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/.test(hash) && hash !== password.hashPassword("una-password-lunga"), hash);
  r.check("and checks against its own salt", password.sha512Crypt("una-password-lunga", hash.split("$")[2]) === hash);

  const auth = { user: "admin", hash };
  const locked = render.renderSite({ ...base, certificate, auth });
  const [locked80, locked443] = locked.split("\nserver {").slice(1);
  const usersFile = `${render.SITES_DIR}/${render.htpasswdFileName("app.esempio.it")}`;
  r.check("443 asks for the password", locked443?.includes('auth_basic "app.esempio.it";') && locked443.includes(`auth_basic_user_file ${usersFile};`));
  r.check("the app never gets the credentials", locked443?.includes('proxy_set_header Authorization "";'));
  r.check("port 80 only redirects, with no password", !locked80.includes("auth_basic"));
  const lockedPlain = render.renderSite({ ...base, auth });
  r.check("without a certificate it is asked on 80, for the app only", (lockedPlain.match(/auth_basic /g) ?? []).length === 1 && lockedPlain.indexOf("auth_basic ") > lockedPlain.indexOf(render.CHECK_PATH));
  r.check("an open name asks for nothing", !plain.includes("auth_basic") && !tls.includes("Authorization"));
  r.check("the users file is not a .conf the include would read", !render.htpasswdFileName("app.esempio.it").endsWith(".conf"));
  r.check("the users file is one line, user:hash", render.renderHtpasswd(auth) === `admin:${hash}\n`);
  for (const bad of ["ad:min", "ad min", "admin\nroot", "", "a".repeat(65)]) {
    r.check(`the user ${JSON.stringify(bad)} is refused`, throws(() => render.renderSite({ ...base, auth: { user: bad, hash } })) && throws(() => render.renderHtpasswd({ user: bad, hash })));
  }
  for (const bad of ["plain-password", "$apr1$abc$def", `${hash}\nroot:${hash}`, "$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012"]) {
    r.check(`the hash ${JSON.stringify(bad.slice(0, 20))} is refused`, throws(() => render.renderSite({ ...base, auth: { user: "admin", hash: bad } })));
  }

  // --- a twin that only redirects ------------------------------------------------------------
  const twin = { ...base, hostname: "www.esempio.it", checkToken: "zyxwvutsrqponmlkjihgfedc" };
  const toApex = render.renderSite({ ...twin, redirect: { hostname: "esempio.it", https: true } });
  r.check("a twin sends visitors on, keeping the path", toApex.includes("return 301 https://esempio.it$request_uri;"));
  r.check("a twin serves no app", !toApex.includes("proxy_pass"));
  r.check("a twin still answers its own challenge and routing check", toApex.includes("/.well-known/acme-challenge/") && toApex.includes(`return 200 "${twin.checkToken}";`));
  r.check("without its own certificate a twin has no 443", !toApex.includes("443"));
  const toPlain = render.renderSite({ ...twin, redirect: { hostname: "esempio.it", https: false } });
  r.check("a twin of a name without its certificate yet sends to http", toPlain.includes("return 301 http://esempio.it$request_uri;") && !toPlain.includes("https://esempio.it"));

  const twinCertificate = render.certificatePaths("www.esempio.it");
  const twinTls = render.renderSite({ ...twin, certificate: twinCertificate, redirect: { hostname: "esempio.it", https: true } });
  const [twin80, twin443] = twinTls.split("\nserver {").slice(1);
  r.check("with its certificate, port 80 goes straight to the other name", twin80.includes("return 301 https://esempio.it$request_uri;") && !twin80.includes("https://$host"));
  r.check("and 443 too, with its own certificate", twin443?.includes(`ssl_certificate ${twinCertificate.fullchain};`) && twin443.includes("return 301 https://esempio.it$request_uri;"));
  r.check("neither block of a twin proxies", !twinTls.includes("proxy_pass"));
  const guardedTwin = render.renderSite({ ...twin, allow: [], auth: null, redirect: { hostname: "esempio.it", https: true } });
  r.check("a twin given an allow list still only redirects", !guardedTwin.includes("proxy_pass") && guardedTwin.includes("return 301 https://esempio.it$request_uri;"));
  const proxiedTwin = render.renderSite({ ...twin, cloudflare: true, redirect: { hostname: "esempio.it", https: true } });
  r.check("a twin behind Cloudflare still reads the visitor's address", proxiedTwin.includes("real_ip_header CF-Connecting-IP;"));
  r.check("a twin without redirect renders as before", render.renderSite({ ...base, redirect: null }) === plain && render.renderSite({ ...base, certificate, redirect: null }) === tls);
  r.check("a redirect to an invalid name is refused", throws(() => render.renderSite({ ...twin, redirect: { hostname: "esempio.it; return 200", https: true } })));
  r.check("a redirect to itself is refused", throws(() => render.renderSite({ ...twin, redirect: { hostname: "www.esempio.it", https: true } })));

  // --- refusals -------------------------------------------------------------------------
  r.check("a hostname with a semicolon is refused", throws(() => render.renderSite({ ...base, hostname: "app.esempio.it; include /etc/shadow" })));
  r.check("a hostname with a space is refused", throws(() => render.renderSite({ ...base, hostname: "app esempio.it" })));
  r.check("port 0 is refused", throws(() => render.renderSite({ ...base, upstreamPort: 0 })));
  r.check("port 70000 is refused", throws(() => render.renderSite({ ...base, upstreamPort: 70000 })));
  r.check("a fractional port is refused", throws(() => render.renderSite({ ...base, upstreamPort: 1.5 })));
  r.check("a rule with a directive in it is refused", throws(() => render.renderSite({ ...base, allow: ["1.2.3.4/32; allow all"] })));
  r.check("a short token is refused", throws(() => render.renderSite({ ...base, checkToken: "abc" })));
  r.check("a token with a quote is refused", throws(() => render.renderSite({ ...base, checkToken: 'abcdefghijklmnop"; x' })));
  r.check(
    "a certificate outside the proxy's directory is refused",
    throws(() => render.renderSite({ ...base, certificate: { fullchain: "/etc/shadow", privkey: "/etc/shadow" } }))
  );
  r.check("a file name is only made from a valid hostname", throws(() => render.siteFileName("../../etc/x")));
  r.check("the site file is the hostname", render.siteFileName("app.esempio.it") === "app.esempio.it.conf");

  // --- the panel's own name ------------------------------------------------------------------
  // In front of the panel itself, so a mistake here is the owner's way in: every
  // directive the project page's live events, an upload or the sign-in depend
  // on is pinned, and so is what the block must never do.
  const panelBase = {
    hostname: "pannello.esempio.it",
    upstreamPort: 3000,
    certificate: null,
    checkToken: token,
    ipv6: true,
    http2: "directive",
    cloudflare: false,
    hstsMaxAge: null,
  };
  const panelWaiting = render.renderPanelSite(panelBase);
  r.check("the panel's block names the host on 80, both families", panelWaiting.includes("server_name pannello.esempio.it;") && panelWaiting.includes("    listen 80;") && panelWaiting.includes("    listen [::]:80;"));
  r.check("before its certificate it answers the challenge and the check", panelWaiting.includes("/.well-known/acme-challenge/") && panelWaiting.includes(`return 200 "${token}";`));
  r.check("before its certificate the panel is never served over plain HTTP", !panelWaiting.includes("proxy_pass") && !panelWaiting.includes("443"));
  r.check("anyone else is told the certificate is on its way", /return 503 "RunPanel: [^"$;]+";/.test(panelWaiting));
  r.check("the block says the panel's port stays open", panelWaiting.includes("its own port 3000 stays open"));

  const panelCertificate = render.certificatePaths("pannello.esempio.it");
  const panelTls = render.renderPanelSite({ ...panelBase, certificate: panelCertificate });
  const [panel80, panel443] = panelTls.split("\nserver {").slice(1);
  const panelApp = panel443?.slice(panel443.indexOf("    location / {")) ?? "";
  r.check("with it, port 80 redirects and still answers the challenge", panel80.includes("return 301 https://$host$request_uri;") && panel80.includes("/.well-known/acme-challenge/") && !panel80.includes("proxy_pass"));
  r.check("443 carries the panel's certificate", panel443?.includes(`ssl_certificate ${panelCertificate.fullchain};`) && panel443.includes(`ssl_certificate_key ${panelCertificate.privkey};`));
  r.check("443 proxies to the panel's port on loopback", panelApp.includes("proxy_pass http://127.0.0.1:3000;") && panelApp.includes("proxy_http_version 1.1;"));
  r.check("WebSockets go through to the panel", panelApp.includes("proxy_set_header Upgrade $http_upgrade;") && panelApp.includes("proxy_set_header Connection $runpanel_connection_upgrade;"));
  r.check("the live events are never held back: buffering and gzip off", panelApp.includes("proxy_buffering off;") && panelApp.includes("gzip off;"));
  r.check("an upload streams through instead of waiting on nginx's disk", panelApp.includes("proxy_request_buffering off;"));
  r.check("long-lived answers get an hour between reads", panelApp.includes(`proxy_read_timeout ${render.PANEL_READ_TIMEOUT};`) && panelApp.includes(`proxy_send_timeout ${render.PANEL_READ_TIMEOUT};`) && render.PANEL_READ_TIMEOUT === "3600s");
  r.check("the panel's own body limits are the only ones", panelApp.includes("client_max_body_size 0;"));
  r.check("Host and the forwarded scheme and host are nginx's", panelApp.includes("proxy_set_header Host $host;") && panelApp.includes("proxy_set_header X-Forwarded-Proto $scheme;") && panelApp.includes("proxy_set_header X-Forwarded-Host $host;"));
  r.check("X-Forwarded-For is set to the peer, never appended to what the visitor sent", panelApp.includes("proxy_set_header X-Forwarded-For $remote_addr;") && !panelTls.includes("$proxy_add_x_forwarded_for"));
  r.check("the panel's own HSTS is never passed on", panelApp.includes("proxy_hide_header Strict-Transport-Security;"));
  r.check("HSTS stays off until the name is the public address", !panelTls.includes("add_header Strict-Transport-Security"));
  const panelAdopted = render.renderPanelSite({ ...panelBase, certificate: panelCertificate, hstsMaxAge: render.PANEL_HSTS_FIRST });
  r.check("once adopted, HSTS goes on", panelAdopted.includes(`add_header Strict-Transport-Security "max-age=${render.PANEL_HSTS_FIRST}" always;`));
  r.check("and never for the domain's other names", !panelAdopted.includes("includeSubDomains"));
  r.check("an HSTS past two years, or not a whole number, is refused", throws(() => render.renderPanelSite({ ...panelBase, hstsMaxAge: render.PANEL_HSTS_FULL + 1 })) && throws(() => render.renderPanelSite({ ...panelBase, hstsMaxAge: 1.5 })));
  const day = 24 * 60 * 60 * 1000;
  const adoptedAt = "2026-11-01T00:00:00.000Z";
  r.check("no HSTS while the name is not the public address", render.panelHstsMaxAge(false, adoptedAt) === null);
  r.check("a day of HSTS in the first week after adoption", render.panelHstsMaxAge(true, adoptedAt, Date.parse(adoptedAt) + 6 * day) === 86_400 && render.PANEL_HSTS_FIRST === 86_400);
  r.check("two years once the week is over", render.panelHstsMaxAge(true, adoptedAt, Date.parse(adoptedAt) + 7 * day) === 63_072_000 && render.PANEL_HSTS_FULL === 63_072_000);
  r.check("adopted with no date counts as adopted now", render.panelHstsMaxAge(true, null) === render.PANEL_HSTS_FIRST && render.panelHstsMaxAge(true, "boh") === render.PANEL_HSTS_FIRST);
  r.check("443 answers only for the panel's own name", panel443?.includes('if ($host != "pannello.esempio.it") {') && panel443.includes("return 421;") && panel443.indexOf("return 421;") < panel443.indexOf("    location / {"));
  r.check("port 80 keeps answering the challenge for anyone", !panel80.includes("return 421;"));
  r.check("the check answers on 443 too, readable by the owner's browser", panel443?.includes(`return 200 "${token}";`) && panel443.includes('add_header Access-Control-Allow-Origin "*" always;'));
  r.check("CORS is opened on the check alone, never on the panel", !panelApp.includes("Access-Control-Allow-Origin"));
  r.check("the panel's name has no allow list and no password", !panelTls.includes("deny all") && !panelTls.includes("auth_basic"));
  r.check("a recent nginx gets http2 on the panel too", panelTls.includes("    http2 on;"));
  r.check("an older one the listen parameter", render.renderPanelSite({ ...panelBase, certificate: panelCertificate, http2: "listen" }).includes("listen 443 ssl http2;"));
  r.check("without IPv6 the panel's block has no [::] listen", !render.renderPanelSite({ ...panelBase, certificate: panelCertificate, ipv6: false }).includes("[::]"));
  const panelProxied = render.renderPanelSite({ ...panelBase, certificate: panelCertificate, cloudflare: true });
  r.check("behind Cloudflare the panel reads the visitor from CF-Connecting-IP, only from its ranges", panelProxied.includes("real_ip_header CF-Connecting-IP;") && panelProxied.match(/set_real_ip_from /g).length === 2 * render.CLOUDFLARE_RANGES.length);
  r.check("the panel's block uses the same file name as any name", render.siteFileName("pannello.esempio.it") === "pannello.esempio.it.conf");
  r.check("a panel name with a directive in it is refused", throws(() => render.renderPanelSite({ ...panelBase, hostname: "pannello.esempio.it; return 200" })));
  r.check("a panel port out of range is refused", throws(() => render.renderPanelSite({ ...panelBase, upstreamPort: 0 })) && throws(() => render.renderPanelSite({ ...panelBase, upstreamPort: 65536 })));
  r.check("a panel token with a quote is refused", throws(() => render.renderPanelSite({ ...panelBase, checkToken: 'abcdefghijklmnop"; x' })));
  r.check("a panel certificate outside the proxy's directory is refused", throws(() => render.renderPanelSite({ ...panelBase, certificate: { fullchain: "/etc/shadow", privkey: "/etc/shadow" } })));

  // --- reading the panel's checks --------------------------------------------------------------
  const checks = await import(pathToFileURL(join(repoRoot, "services", "proxy", "panel-checks.ts")).href);
  r.check("the sign-in check of a RunPanel is recognised by its shape", checks.isPanelCheckAnswer(200, JSON.stringify({ authenticated: false, firstRun: false, emailRequired: false, role: null })));
  r.check("nginx's error page is not the panel", !checks.isPanelCheckAnswer(502, "<html>Bad Gateway</html>") && !checks.isPanelCheckAnswer(200, "<html>Welcome to nginx!</html>"));
  r.check("another app's JSON is not the panel", !checks.isPanelCheckAnswer(200, JSON.stringify({ ok: true })));
  r.check("an expired certificate is said so", checks.explainTlsFailure("CERT_HAS_EXPIRED", "pannello.esempio.it").includes("scaduto"));
  r.check("another name's certificate is said so", checks.explainTlsFailure("ERR_TLS_CERT_ALTNAME_INVALID", "pannello.esempio.it").includes("pannello.esempio.it"));
  r.check("an unknown failure keeps its code", checks.explainTlsFailure("EWHATEVER", "x.it").includes("EWHATEVER"));
  r.check("a 502 through nginx names the panel's port", checks.explainProxiedAnswer(502, 3000).includes("127.0.0.1:3000"));

  // --- instant addresses, and the panel's public address --------------------------------------
  r.check("an IPv4 makes a dashed instant domain", names.instantDomainFor("203.0.113.7") === "203-0-113-7.sslip.io");
  r.check("an IPv6 too, with its double colon as two dashes", names.instantDomainFor("2001:db8::1") === "2001-db8--1.sslip.io");
  r.check("an IPv6 ending in :: cannot be a label", names.instantDomainFor("2001:db8::") === null);
  for (const bad of ["", "sslip.io", "1.2.3", "256.1.1.1", "example.com", "1.2.3.4; x"]) {
    r.check(`no instant domain for ${JSON.stringify(bad)}`, names.instantDomainFor(bad) === null);
  }
  r.check("an instant domain reads back as its address", names.instantDomainAddress("203-0-113-7.sslip.io") === "203.0.113.7" && names.instantDomainAddress("2001-db8--1.sslip.io") === "2001:db8::1");
  r.check("nip.io reads the same", names.instantDomainAddress("8-8-8-8.nip.io") === "8.8.8.8");
  r.check("a real domain is not an instant one", names.instantDomainAddress("esempio.it") === null && names.instantDomainAddress("app.sslip.io") === null && names.instantDomainAddress("abcd.sslip.io") === null);
  r.check("an instant domain is a domain the store accepts", normalizeDomain("203-0-113-7.sslip.io") === "203-0-113-7.sslip.io" && normalizeDomain("2001-db8--1.sslip.io") === "2001-db8--1.sslip.io");
  r.check("any name under those services is instant", names.isInstantHostname("app.203-0-113-7.sslip.io") && names.isInstantHostname("x.nip.io") && names.isInstantHostname("SSLIP.IO."));
  r.check("a name that only ends alike is not", !names.isInstantHostname("notsslip.io") && !names.isInstantHostname("app.esempio.it"));
  r.check("a label is made from a project's name", names.labelFrom("Il Mio Sito!") === "il-mio-sito" && names.labelFrom("Caffè") === "caffe");
  r.check("and is never empty or too long", names.labelFrom("!!!") === "app" && names.labelFrom("a".repeat(80)).length === 40 && names.labelFrom(`${"a".repeat(39)}-b`) === "a".repeat(39));
  r.check("the panel's public address is its HTTPS name", names.isPanelAddress("https://pannello.esempio.it", "pannello.esempio.it") && names.isPanelAddress(" https://pannello.esempio.it:443/ ", "pannello.esempio.it"));
  r.check("over http, on another port or another name it is not", !names.isPanelAddress("http://pannello.esempio.it", "pannello.esempio.it") && !names.isPanelAddress("https://pannello.esempio.it:8443", "pannello.esempio.it") && !names.isPanelAddress("https://altro.esempio.it", "pannello.esempio.it") && !names.isPanelAddress("", "pannello.esempio.it") && !names.isPanelAddress(null, "pannello.esempio.it"));

  // --- shared files ------------------------------------------------------------------------
  const include = render.renderInclude();
  r.check("the include defines the map under RunPanel's own name", include.includes("map $http_upgrade $runpanel_connection_upgrade"));
  r.check("the include points at the sites", include.includes(`include ${render.SITES_DIR}/*.conf;`));
  r.check("the map comes before any block that uses it", include.indexOf("map $http_upgrade") < include.indexOf("include "));

  // --- sudo ---------------------------------------------------------------------------------
  r.check(
    "sudoers allows exactly test and reload",
    render.renderSudoers("runpanel", "/usr/sbin/nginx") === "runpanel ALL=(root) NOPASSWD: /usr/sbin/nginx -t, /usr/sbin/nginx -s reload\n"
  );
  r.check("a user name with punctuation is refused", throws(() => render.renderSudoers("op,root", "/usr/sbin/nginx")));
  r.check("an nginx path with a space is refused", throws(() => render.renderSudoers("op", "/usr/sbin/nginx -s stop")));

  const setup = (method) => render.setupCommands({ user: "op", uid: 1000, gid: 1000, nginxPath: "/usr/sbin/nginx", method });
  const commands = setup("sudo");
  const sudoersLine = commands.find((c) => c.includes(render.SUDOERS_PATH)) ?? "";
  r.check("the directories belong to the panel's user", commands[0].includes("-o 1000 -g 1000") && commands[0].includes(render.SITES_DIR));
  r.check("the key directory is private", commands[1].includes("-m 0700") && commands[1].includes(render.LETSENCRYPT_DIR));
  r.check("the include goes in through a quoted heredoc", commands.some((c) => c.startsWith(`sudo tee ${render.NGINX_INCLUDE_PATH}`) && c.includes("<<'RUNPANEL_EOF'")));
  r.check("the sudoers file is staged with mktemp", sudoersLine.includes("f=$(mktemp)") && !sudoersLine.includes("/tmp/runpanel"));
  r.check(
    "visudo checks it before it is installed",
    sudoersLine.indexOf("visudo -cf") > -1 && sudoersLine.indexOf("visudo -cf") < sudoersLine.indexOf("install -o root")
  );
  r.check("it is installed 0440 as root", sudoersLine.includes("install -o root -g root -m 0440"));
  r.check("the last step tests before it reloads", commands[commands.length - 1] === "sudo /usr/sbin/nginx -t && sudo /usr/sbin/nginx -s reload");

  // --- systemd, for a panel under its own NoNewPrivileges unit ------------------------------------------
  const viaSystemd = setup("systemd");
  const joined = viaSystemd.join("\n");
  r.check("systemd needs no sudoers rule", !joined.includes(render.SUDOERS_PATH));
  r.check("the requests directory belongs to the panel", viaSystemd[0].includes(render.REQUESTS_DIR) && viaSystemd[0].includes("-o 1000 -g 1000"));
  r.check("the script is installed and made executable", joined.includes(`sudo tee ${render.APPLY_SCRIPT_PATH}`) && joined.includes(`sudo chmod 0755 ${render.APPLY_SCRIPT_PATH}`));
  r.check(
    "both path units are installed and enabled",
    joined.includes("runpanel-nginx-test.path") && joined.includes("enable --now runpanel-nginx-test.path runpanel-nginx-reload.path")
  );
  const direct = setup("direct");
  r.check("a root panel's commands carry no reload plumbing", !direct.join("\n").includes("systemctl") && !direct.join("\n").includes("visudo"));

  const script = render.renderApplyScript("/usr/sbin/nginx");
  r.check("the script tests on test", script.includes('test) { /usr/sbin/nginx -t; echo "exit=$?"; }'));
  r.check("and tests again before it reloads", script.includes("/usr/sbin/nginx -t && /usr/sbin/nginx -s reload"));
  r.check("the verdict lands whole, through a rename", script.includes('mv -f "$dir/reload.tmp" "$dir/reload"') && script.includes(`dir=${render.RESULTS_DIR}`));
  r.check("the script never reads the request file", !script.includes(render.REQUESTS_DIR));
  r.check("any other action is refused", script.includes("*) exit 2 ;;"));
  r.check("a script for an odd nginx path is refused", throws(() => render.renderApplyScript("/usr/sbin/nginx; rm -rf /")));

  const service = render.renderApplyService();
  r.check("the service keeps its verdict after it stops", service.includes("RuntimeDirectoryPreserve=yes") && service.includes("RuntimeDirectory=runpanel-proxy"));
  r.check("the service passes the action through", service.includes(`ExecStart=${render.APPLY_SCRIPT_PATH} %i`) && service.includes("Type=oneshot"));
  const reloadPath = render.renderPathUnit("reload");
  r.check("the path unit watches its own request", reloadPath.includes(`PathChanged=${render.REQUESTS_DIR}/reload`) && reloadPath.includes("Unit=runpanel-nginx@reload.service"));

  r.check("a whole verdict is read", JSON.stringify(render.parseVerdict("nginx: test is successful\nexit=0\n")) === JSON.stringify({ ok: true, output: "nginx: test is successful" }));
  r.check("a failing one says so", render.parseVerdict("nginx: [emerg] unknown directive\nexit=1")?.ok === false);
  r.check("half a verdict is not one", render.parseVerdict("nginx: the configuration") === null);

  const teardown = render.teardownCommands("/usr/sbin/nginx").join("\n");
  r.check("teardown removes what setup added", teardown.includes(render.NGINX_INCLUDE_PATH) && teardown.includes(render.APPLY_SCRIPT_PATH) && teardown.includes(`rm -rf ${render.PROXY_ROOT}`));

  // --- certbot -------------------------------------------------------------------------------
  const issue = render.certbotIssueArgs("app.esempio.it", "op@esempio.it");
  const at = (flag) => issue[issue.indexOf(flag) + 1];
  r.check("certbot uses the webroot", issue[0] === "certonly" && issue.includes("--webroot") && at("-w") === render.WEBROOT_DIR);
  r.check("the certificate is named after the host", at("-d") === "app.esempio.it" && at("--cert-name") === "app.esempio.it");
  r.check("certbot never asks a question", issue.includes("--non-interactive") && issue.includes("--agree-tos"));
  r.check("the email is passed when there is one", at("--email") === "op@esempio.it" && issue.includes("--no-eff-email"));
  r.check("certbot keeps to the proxy's directories", at("--config-dir") === render.LETSENCRYPT_DIR);
  const noEmail = render.certbotIssueArgs("app.esempio.it", null);
  r.check("without an email certbot is told so", noEmail.includes("--register-unsafely-without-email") && !noEmail.includes("--email"));
  r.check("certbot is never given an invalid name", throws(() => render.certbotIssueArgs("--help", null)));
  r.check("renew is non-interactive", render.certbotRenewArgs().slice(0, 2).join(" ") === "renew --non-interactive");
  r.check("renew skips the hook directories a project could write to", render.certbotRenewArgs().includes("--no-directory-hooks"));
  r.check("delete names the certificate", render.certbotDeleteArgs("app.esempio.it").slice(0, 3).join(" ") === "delete --cert-name app.esempio.it");

  const viaDns = render.certbotIssueArgs("app.esempio.it", null, "cloudflare");
  const dnsAt = (flag) => viaDns[viaDns.indexOf(flag) + 1];
  r.check("through Cloudflare certbot answers on DNS, with no webroot", viaDns.includes("--manual") && dnsAt("--preferred-challenges") === "dns" && !viaDns.includes("--webroot"));
  r.check(
    "the hooks are the panel's, run by node",
    dnsAt("--manual-auth-hook") === `node ${render.CLOUDFLARE_HOOK_PATH} auth` && dnsAt("--manual-cleanup-hook") === `node ${render.CLOUDFLARE_HOOK_PATH} cleanup`
  );
  r.check("the hook lives in certbot's private directory", render.CLOUDFLARE_HOOK_PATH.startsWith(`${render.CERTBOT_DIR}/`));
  r.check("the name and its certificate are the same either way", dnsAt("-d") === "app.esempio.it" && dnsAt("--cert-name") === "app.esempio.it" && viaDns.includes("--keep-until-expiring"));

  r.check("the renewal settings are named after the host", render.renewalConfPath("app.esempio.it") === `${render.LETSENCRYPT_DIR}/renewal/app.esempio.it.conf`);
  r.check(
    "a renewal through the hook reads as Cloudflare",
    render.renewalChallenge(`[renewalparams]\nauthenticator = manual\nmanual_auth_hook = node ${render.CLOUDFLARE_HOOK_PATH} auth\n`) === "cloudflare"
  );
  r.check("a webroot renewal reads as HTTP", render.renewalChallenge("[renewalparams]\nauthenticator = webroot\n") === "http");
  r.check("someone else's manual hook is not ours", render.renewalChallenge("authenticator = manual\nmanual_auth_hook = /root/other.sh\n") === "http");

  // --- reading the tools' output ------------------------------------------------------------------
  const nginxOutput = [
    'nginx: [warn] conflicting server name "App.esempio.it" on 0.0.0.0:80, ignored',
    'nginx: [warn] conflicting server name "app.esempio.it" on [::]:80, ignored',
    "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok",
  ].join("\n");
  const conflicts = render.conflictingNames(nginxOutput);
  r.check("a conflict is read once, lowercased", conflicts.length === 1 && conflicts[0] === "app.esempio.it", JSON.stringify(conflicts));
  r.check("clean output has no conflicts", render.conflictingNames("nginx: configuration file test is successful").length === 0);

  // The shapes a real nginx (1.28) prints, with the paths it would have on Linux.
  const brokenCert = render.blamedNames(
    `nginx: [emerg] cannot load certificate "${render.LETSENCRYPT_DIR}/live/app.esempio.it/fullchain.pem": PEM_read_bio_X509_AUX() failed (SSL: error:0480006C:PEM routines::no start line)\nnginx: configuration file /etc/nginx/nginx.conf test failed`
  );
  r.check("an unreadable certificate blames its name", brokenCert.certificates.join() === "app.esempio.it" && brokenCert.blocks.length === 0, JSON.stringify(brokenCert));
  const brokenBlock = render.blamedNames(
    `nginx: [emerg] unknown directive "bogus" in ${render.SITES_DIR}/api.esempio.it.conf:4\nnginx: configuration file /etc/nginx/nginx.conf test failed`
  );
  r.check("a broken block blames its name", brokenBlock.blocks.join() === "api.esempio.it" && brokenBlock.certificates.length === 0, JSON.stringify(brokenBlock));
  const theirs = render.blamedNames('nginx: [emerg] unknown directive "bogus" in /etc/nginx/sites-enabled/default:12');
  r.check("an error in the operator's own file blames nothing of ours", theirs.blocks.length === 0 && theirs.certificates.length === 0);
  const warned = render.blamedNames(`nginx: [warn] the "listen ... http2" directive is deprecated in ${render.SITES_DIR}/app.esempio.it.conf:24`);
  r.check("a warning blames nothing", warned.blocks.length === 0);

  const certbotOutput = [
    "Saving debug log to /var/lib/runpanel-proxy/certbot/logs/letsencrypt.log",
    "Requesting a certificate for app.esempio.it",
    "Certbot failed to authenticate some domains (authenticator: webroot).",
    "  Domain: app.esempio.it",
    "  Type:   dns",
    "  Detail: DNS problem: NXDOMAIN looking up A for app.esempio.it",
  ].join("\n");
  const failure = render.certbotFailure(certbotOutput);
  r.check("a certbot failure keeps Let's Encrypt's detail", failure.includes("NXDOMAIN") && !failure.includes("Saving debug log"), failure);
  r.check("without a detail the last lines are kept", render.certbotFailure("a\nb\nc\nd\ne").startsWith("b"));

  const hookFailure = render.certbotFailure(
    [
      "Hook '--manual-auth-hook' for app.esempio.it ran with error output:",
      " RunPanel: il token Cloudflare non vede nessuna zona che contenga app.esempio.it",
      "Certbot failed to authenticate some domains (authenticator: manual).",
      "  Domain: app.esempio.it",
      "  Type:   unauthorized",
      "  Detail: No TXT record found at _acme-challenge.app.esempio.it",
    ].join("\n")
  );
  r.check("a hook failure is the reason shown, not the record it left missing", hookFailure.startsWith("il token Cloudflare") && !hookFailure.includes("No TXT"), hookFailure);

  await checkCloudflareHook(r, render);
  return r.result();
}

/**
 * The hook certbot runs, as certbot runs it — a node process with the token in
 * its environment — against a stand-in for Cloudflare's API that keeps the
 * records it is given. The stand-in answers TXT content quoted, as Cloudflare
 * may, and only to the right bearer token.
 */
async function checkCloudflareHook(r, render) {
  const dir = mkdtempSync(join(tmpdir(), "runpanel-hook-"));
  const hook = join(dir, "cloudflare-hook.mjs");
  writeFileSync(hook, render.renderCloudflareHook());

  const records = new Map();
  const asked = [];
  let nextId = 1;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      asked.push(`${req.method} ${req.url}`);
      const url = new URL(req.url, "http://stand-in");
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Bearer good-token") {
        return send(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }] });
      }
      if (req.method === "GET" && url.pathname === "/zones") {
        const found = url.searchParams.get("name") === "esempio.it";
        return send(200, { success: true, result: found ? [{ id: "z1", name: "esempio.it", name_servers: [] }] : [] });
      }
      if (req.method === "POST" && url.pathname === "/zones/z1/dns_records") {
        const record = JSON.parse(body);
        const id = `r${nextId++}`;
        records.set(id, { ...record, id, content: `"${record.content}"` });
        return send(200, { success: true, result: { id } });
      }
      if (req.method === "GET" && url.pathname === "/zones/z1/dns_records") {
        const named = [...records.values()].filter((record) => record.name === url.searchParams.get("name"));
        return send(200, { success: true, result: named });
      }
      const one = url.pathname.match(/^\/zones\/z1\/dns_records\/(\w+)$/);
      if (req.method === "DELETE" && one) {
        records.delete(one[1]);
        return send(200, { success: true, result: { id: one[1] } });
      }
      send(404, { success: false, errors: [{ code: 7003, message: "No route for that URI" }] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const run = (phase, env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [hook, phase], {
        env: {
          ...process.env,
          RUNPANEL_CLOUDFLARE_API: `http://127.0.0.1:${server.address().port}`,
          CERTBOT_DOMAIN: "app.esempio.it",
          CERTBOT_VALIDATION: "the-validation",
          [render.CLOUDFLARE_TOKEN_ENV]: "good-token",
          ...env,
        },
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("close", (code) => resolve({ code, output }));
    });

  try {
    let ran = await run("auth");
    const [published] = records.values();
    r.check(
      "the hook publishes the challenge as a TXT record",
      ran.code === 0 && records.size === 1 && published.type === "TXT" && published.name === "_acme-challenge.app.esempio.it",
      ran.output
    );
    r.check("it finds the zone through the name's parent", asked.includes("GET /zones?name=app.esempio.it") && asked.includes("GET /zones?name=esempio.it"));
    ran = await run("cleanup");
    r.check("cleanup removes it, quoted as it came back", ran.code === 0 && records.size === 0, ran.output);
    ran = await run("auth", { [render.CLOUDFLARE_TOKEN_ENV]: "bad-token" });
    r.check("a refused token fails it with Cloudflare's reason", ran.code === 1 && ran.output.includes("RunPanel: ") && ran.output.includes("Invalid access token"), ran.output);
    ran = await run("auth", { [render.CLOUDFLARE_TOKEN_ENV]: "" });
    r.check("without a token it says where to put one", ran.code === 1 && ran.output.includes("RunPanel: manca il token"), ran.output);
    ran = await run("auth", { CERTBOT_DOMAIN: "app.altro.it" });
    r.check("a name outside the account is named", ran.code === 1 && ran.output.includes("app.altro.it") && records.size === 0, ran.output);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
