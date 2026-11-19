[← RunPanel](../../README.md) · [Italiano](../it/domains.md) · **English**

---

# Domains

Every project with a port can be served on an address over HTTPS: `app.example.com` instead of `203.0.113.7:3001`. The panel writes the server blocks for the **nginx** already on the machine and asks **certbot** for a Let's Encrypt certificate per address; the blocks you wrote yourself are never touched.

## What you need

- Linux, with nginx and certbot installed (for instance `sudo apt install nginx certbot`).
- A domain you own, and at its DNS provider a record per address — or **one wildcard record**, `*.example.com` → the server's public address (`A`, plus `AAAA` if it has IPv6), which covers every subdomain at once. Each address gets its own certificate. The domain itself (`example.com`) needs a record of its own: the wildcard does not cover it. You do not have to know any of this up front: when you add an address, the project shows the exact records to create and checks them.
- Ports 80 and 443 reaching nginx: port 80 is where Let's Encrypt checks the name, for the first certificate and every renewal. For domains on [Cloudflare](#domains-on-cloudflare) the check goes through DNS instead.

## Setting nginx up

Once per server, either from the **Domini** page or straight from a project's address dialog, which shows the same step (it needs the *Accesso all'host* permission):

- **nginx missing**: the panel says so and gives the install command; then press **Li ho installati**.
- **Panel running as root**: press **Prepara nginx**.
- **Otherwise**: the commands to paste in a terminal with sudo, then **Ho eseguito i comandi**. Only this step shows sudo commands, and only when the panel cannot take it itself.
- **certbot missing**: addresses are served over HTTP only until it is installed.

The setup adds one file to nginx's configuration, `/etc/nginx/conf.d/runpanel.conf`, which includes `/var/lib/runpanel-proxy/sites/*.conf`. That directory, the certbot webroot and the certificates live under `/var/lib/runpanel-proxy`, owned by the panel's user, so certbot runs without root. Testing and reloading nginx is the only thing that needs root, and the panel gets it in one of three ways:

| How the panel runs | How it reloads nginx |
|---|---|
| as root | it runs `nginx -t` and `nginx -s reload` itself |
| under systemd (RunPanel's own unit included) | it writes a request file; two root path units run `/usr/local/sbin/runpanel-nginx`, which tests and reloads and leaves the outcome in `/run/runpanel-proxy` |
| without systemd | a sudo rule allowing exactly `nginx -t` and `nginx -s reload` |

The systemd route is not a detour: RunPanel's unit sets `NoNewPrivileges=yes`, under which sudo cannot work — and that flag is worth keeping, because it also stops every native project below the panel from ever using sudo.

Deleting `/etc/nginx/conf.d/runpanel.conf` and reloading takes every managed name down at once — the panel's own HTTPS name too, while the panel stays on its port.

## Giving a project an address

In the project, **Impostazioni › Indirizzi › Aggiungi**:

1. Choose the domain — with none yet, add it right there (`example.com`); it also appears on the **Domini** page.
2. Choose **a subdomain** (`app`, previewed as `https://app.example.com`) or **the domain itself**. What can be known while typing is said at once: an address the project already has, the panel's own address, a label DNS would refuse. A name another project holds comes back when you press **Aggiungi**.
3. For the domain itself or its `www`, tick **Anche www.example.com, che rimanda qui** (or the reverse): see [www](#www).

Then the dialog shows the step that comes next, in order: the server (the nginx setup, if it is still missing), **the DNS record to create** — type, name and value with copy buttons, the value being this server's public address — and the certificate. The record is looked up again every few seconds while it is not right, so it can stay open next to the DNS provider's page; once the record leads here the certificate is asked for, and a few seconds later the address reads *HTTPS attivo*. The same dialog opens from **Verifica** next to any address that is not there yet.

The certificate is asked for **only once the DNS record leads here**. Let's Encrypt allows few failed checks per name and hour, so a request made while the record is missing is a request wasted. Close the dialog and the panel keeps looking by itself — every 2 minutes during the first hour, every 10 during the first day, hourly after that — and asks as soon as the record is right. **Richiedi il certificato** asks at once, whatever the check says.

Next to each address, its state in plain words: *HTTPS attivo*, *In attesa del DNS*, *Certificato in arrivo*, *Il certificato scade tra N giorni* (under 14 days, which means renewals have been failing), *Certificato scaduto*, *Certificato non ottenuto* with what to do (the record is missing, port 80 is not reachable, another server answered, too many attempts…). In expert mode Let's Encrypt's own message is shown as well.

Certificates are renewed by the panel itself, checking twice a day as certbot does: a renewal happens only within 30 days of expiry. Let's Encrypt no longer sends expiry emails, so **Email per Let's Encrypt** (under **Domini › Avanzate**) is optional: it is only the account's contact.

## Checking the DNS

The check asks **public resolvers**, 1.1.1.1 then 8.8.8.8, with a new resolver every time: the server's own resolver is often a cache that would keep answering "no such name" for minutes after the record was created. Where the network lets DNS out only through its own resolver, the check falls back to the server's, and says so in expert mode.

The answer is compared with **this server's public addresses**: the ones on its interfaces, or — behind NAT, and on clouds that hand out public addresses by 1:1 NAT such as EC2 — the IPv4 the outside sees, asked of OpenDNS (`myip.opendns.com`, a DNS query, kept for five minutes). What it can say:

| What the page says | Meaning |
|---|---|
| *Punta a questo server* | every A/AAAA record points at this server (an AAAA record is optional) |
| *Non ancora trovato* | no record yet, or not propagated yet |
| *Punta altrove* | a record points at another machine, which is named — a stale `AAAA` for instance, which also sends Let's Encrypt elsewhere since it tries IPv6 first |
| *Dietro Cloudflare* | the addresses are Cloudflare's proxy (orange cloud), which hides where the name leads: fine for a domain linked to Cloudflare; otherwise link it, or turn the cloud grey until the certificate is there |
| *Da confermare* | the record resolves, but this server's public address is unknown |
| *DNS non raggiungibile* | the resolvers did not answer, which says nothing about the record |

When the addresses do not match what the server knows of itself, the panel asks each of them directly — on port 80, for the name, as Let's Encrypt does — for a token only this nginx answers: if every one hands it back, the name does reach this server (a NAT, a floating address) and the address counts as right. One that does not, such as a stale `AAAA` pointing at an old server, keeps it wrong; a private or loopback address never counts.

## www

The domain itself can come with its `www` (or `www` with the domain itself): a second address of the project that **redirects** to the first one with a 301, path and query kept, in one hop. It has its own certificate and its own DNS record, so it can arrive after the main one without holding it up. It serves nothing else: the project's network rules and password apply on the address it redirects to. Removing the main address removes its twin; the twin alone can be removed from its own menu, and given back from the main address's menu.

## Domains on Cloudflare

When a domain's DNS is on Cloudflare, the panel can get its certificates through Cloudflare's API: they work with the record proxied (orange cloud) and with port 80 closed.

1. On Cloudflare, **My Profile › API Tokens › Create Token**, with the permissions **Zone · Zone · Read** and **Zone · DNS · Edit** on the zones you want to use.
2. In **Domini › Avanzate**, paste the token and press **Collega**: the panel tries it by listing the zones, and refuses it with Cloudflare's reason if it is not enough. A token Cloudflare stops accepting is reported above the fold.
3. The page lists your account's domains: **Aggiungi** adds one to the panel. Domains already added whose zone is active on Cloudflare get the *Cloudflare* label, and their names that were waiting for a certificate, or were refused one on port 80, ask again by themselves.

For a domain on Cloudflare certbot answers the DNS-01 challenge: a hook of the panel's publishes the `_acme-challenge` TXT record through the API, waits until Cloudflare's nameservers give it back, and deletes it once the check is over. The token is encrypted in the panel's store and reaches certbot only through the environment of each run: it is never written to a file or to the renewal settings.

**With the orange cloud.** Set Cloudflare's **SSL/TLS** mode to **Full (strict)**: with *Flexible* Cloudflare speaks HTTP to the server, which once on HTTPS redirects it back to HTTPS, round and round. Behind the proxy every connection comes from Cloudflare, so in these domains' blocks nginx reads the visitor's address from `CF-Connecting-IP`, and only from [Cloudflare's addresses](https://www.cloudflare.com/ips/): the projects' access rules keep holding, and someone going around Cloudflare cannot pick their own address.

If you disconnect Cloudflare, the certificates already issued stay, and at renewal their names go back to the port-80 check. In the same way, a domain that joins or leaves the account switches challenge at its next renewal.

## How a name reaches the app

nginx forwards to the port the app really listens on, over loopback, with `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and WebSockets passed through, and a 100 MB body limit. Changing the project's port or its access rules rewrites the block by itself; deleting the project takes its names and their certificates with it.

**Restricted projects.** An address follows the project's [network rules](network.md): nginx allows the same addresses (and this machine) and refuses the rest. To expose a project **only** over HTTPS, restrict its port with an empty list ("this machine only") and tick **Raggiungibile da tutti tramite l'indirizzo**: the port stays closed to the outside, the address is open.

**Password.** Tick **Chiedi una password** under an address and choose a user and a password (at least 8 characters): nginx asks for them (`auth_basic`) before anything reaches the app, which never sees them. Only the hash is kept (SHA-512 crypt), so a forgotten password is replaced, not recovered. It applies to the address only — the port is unchanged — and with an allow list both must pass. Until the certificate arrives the address is served over HTTP and the password travels in clear.

The addresses a project answers on are also shown under its title, so it opens with one click without going through Settings; a lock marks the ones behind a password.

## Deploys without downtime

A Docker project with [deploys without downtime](deploy.md#deploys-without-downtime) on is not proxied to its own port: its container is published on `127.0.0.1` at a port the panel picks for each deploy (21000–21999), and the block's `proxy_pass` points there. At each deploy the new version starts on a new port and, once it answers, the panel switches nginx with a change of its own, not an ordinary apply:

- it copies the blocks nginx is using and changes **only** the `proxy_pass` port of the project's names — every other line and every other name stay byte for byte, whatever else is waiting to be applied;
- the new set goes through `nginx -t` and a reload, the same way as every apply (the systemd path units, sudo, or directly as root). If nginx refuses it, the previous set comes back, nothing is reloaded, and the old version keeps serving: no name is set aside, which an ordinary apply would do with a refused block;
- the new port is written to the store in the same step, inside the apply queue, so an apply that comes right after renders the same upstream rather than the old one;
- the old container stays up for the drain: nginx's old workers finish the requests they had, then it is stopped.

After a restart of the panel in the middle of a deploy, the containers are settled first and nginx is applied again from the store, which by then names the port of the one container left.

## The panel itself over HTTPS

The panel can open on a name of yours, with the padlock — `https://panel.example.com` instead of `http://203.0.113.7:3000` — through the same nginx and certbot. Owner only, from **Impostazioni › Pannello › Metti il pannello su HTTPS**:

1. With nginx and certbot ready (the section shows the same setup step as the **Domini** page), choose a name: a word under one of the panel's domains, or a name typed whole, for a domain managed elsewhere.
2. The DNS record to create is shown and checked live, as for a project's address; the certificate is asked for once the record leads here.
3. With the certificate, the name is tested twice. From the server: nginx on this machine is asked for the name over TLS, the certificate must be valid for it, the panel's block must answer and the panel must be behind it. From your browser: it must reach `https://<name>` and find this server's token there — DNS, the firewall on 443 and the certificate, as your network sees them.
4. Only then the panel offers to make it its **public address** (**Impostazioni › Pannello › Indirizzo pubblico**): the GitHub webhooks connected from then on, the links in notifications, the address given to a server joining the cluster.

**Nothing is taken away.** The panel keeps listening on its port and the address you use now keeps working: the name is a second way in. The webhooks already on GitHub stay on their old address until **Riallinea** in each project's Webhook section. **Disattiva** removes the block, then the certificate, and — if the name was the public address — puts back what that setting held before. Turned off from the name itself, the page then shows where the panel still is: its port, on the server's public addresses.

**What the block does.** Port 80 answers Let's Encrypt and the routing check, and before the certificate tells anyone else it is on its way: the panel is never served over plain HTTP on the name. Port 443 proxies to the panel's port on loopback with buffering off both ways (the project page's live events, an upload streaming through), an hour between reads, WebSockets passed through and no body limit of nginx's own — each route of the panel enforces its own. It answers only for its own name (`421` for any other), so as nginx's implicit default server it would not hand the panel to every name reaching the machine. The panel must answer on `127.0.0.1:<port>`, and not on 80 or 443: otherwise it is told so before anything is written.

**Forwarded headers.** nginx sets `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`, replacing whatever the visitor sent — `X-Forwarded-For` is the peer's address, not appended to — so through the name nobody can hand the panel values of their choosing. The panel reads them as behind any proxy: `Origin` against `Host` or `X-Forwarded-Host` for the cross-origin check, `Origin` (or `X-Forwarded-Proto`) for the session cookie's `Secure` flag, both deciding only about the request that carries them. `X-Forwarded-For`, the visitor's address for the per-address sign-in limit, is read only with `RUNPANEL_TRUSTED_PROXY_HOPS=1` (see [Configuration](configuration.md#putting-it-on-the-internet)): leave it at `0` while the panel's port is reachable from outside, because there the header is whatever the client typed, and set it to `1` once only nginx can reach the port.

**HSTS.** The panel's own header (two years, `includeSubDomains`) is not passed on: on a name like `example.com` it would pin every project of the domain to HTTPS, some of them still waiting for their certificate. nginx sends its own, without `includeSubDomains`, and only once the name is the public address: one day for the first week, two years after that (the step up happens within minutes of the week's end). Trying the name out sends none, and a name turned off within its first week is forgotten by browsers within a day. While it holds, browsers that opened the name use HTTPS only for it, on any port: `http://panel.example.com:3000` no longer opens there; the server's IP still does. If the public address is changed by hand, nginx follows within two minutes.

**The same name over plain http.** Browsers keep one set of cookies per name, whatever the port, and refuse a plain-http cookie that would replace a secure one. After a sign-in on `https://panel.example.com`, that browser cannot sign in on `http://panel.example.com:3000` until it signs out of the HTTPS address or that session ends (7 days). The section warns when it sees the panel used that way; the IP address is not affected.

**Several servers.** Each server has its own name, set from its own settings (choose it with the server selector). The other servers keep reaching it at the address it was linked with: the name does not change that. If that address is the name itself — a server linked after the name became the public address is given that one — turning the name off cuts the others off until the address is changed, and **Disattiva** says so first.

## A test address without a domain

A project with no address yet can get one at once, from **Impostazioni › Indirizzi › Non ho un dominio: indirizzo di prova**: `app.203-0-113-7.sslip.io`. [sslip.io](https://sslip.io) answers every such name with the address written in it, so there is no DNS record to create.

It is served **over HTTP only**, and the dialog says so before it is created:

- sslip.io — and nip.io, run by the same people — is not on the Public Suffix List, so Let's Encrypt counts every certificate for every name under it against a single weekly limit shared with everyone who uses it. The service has had it raised by hand, up to 250,000, and in 2026 it still ran out within days of an increase. A certificate that may or may not come is not one the panel promises, so none is asked for, for any name under those services.
- The name shows the server's IP, the lookups for it are answered by sslip.io's servers, and it depends on a free service run by volunteers: if sslip.io stops answering, the address stops working. A certificate would also have published the name in the public Certificate Transparency logs, where scanners find new sites within minutes.

For anything real, give the project a domain of its own. A test address is removed like any other; if the server's IP changes it keeps pointing at the old one, so remove it and create a new one. The server's domain row (`203-0-113-7.sslip.io`) shows on the **Domini** page with no record to create. A name under sslip.io that already had its certificate before this version keeps it and keeps renewing it — a renewal does not count against that limit — but no new one is asked for.

## What is refused

- A name already served by another nginx block: nginx would keep only one of the two, and the managed one would win, so the panel leaves it out and says so under the address.
- The panel's own address (**Impostazioni › Pannello › Indirizzo pubblico**) and its HTTPS name, also as a `www` twin.
- An address assigned twice, a project without a port (set it in the **Porta** field of the project's settings), a domain still in use — by a project or by the panel's name — a `www` twin for any subdomain other than `www`.
- As the panel's name: a project's name, a local name, a name under sslip.io or nip.io.

## Limits

- One level of subdomain (`app.example.com`, not `api.app.example.com`), or the domain itself (`example.com`).
- Per server: the wildcard record points at one machine, so with [several servers](multi-server.md) each one has its own domains — `*.s1.example.com`, for instance.
- Unknown names under the wildcard land on nginx's default server. If that is the panel, consider a catch-all block returning `444`.
- The include works where `nginx.conf` loads `/etc/nginx/conf.d/*.conf` inside `http {}`, as Debian, Ubuntu and RHEL do out of the box. With a hand-written `nginx.conf` that does not, add that line yourself.
- With SELinux enforcing (RHEL, Fedora), nginx may be refused access to `/var/lib/runpanel-proxy` until the directory is labelled for it (`semanage fcontext` and `restorecon`).
- The DNS check needs outgoing DNS to 1.1.1.1 and 8.8.8.8 (and to OpenDNS, to learn the address of a server behind NAT). Without it the check says it could not answer and the certificate is asked for anyway, as before the check existed.
- Not available when the panel runs in a container, or with `RUNPANEL_DISABLE_SCHEDULERS`, which keeps a test instance away from the host's nginx.
