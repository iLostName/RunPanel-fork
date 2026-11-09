/**
 * Refuse a write that a page on another origin sent.
 *
 * The session cookie is SameSite=Lax, which stops other *sites* but not other
 * origins on the same host: an app this panel deployed on another port is
 * same-site, and its pages could send blind state-changing requests carrying
 * the operator's cookie. Browsers tell us where a request came from; anything
 * that is not this exact origin gets no write. Clients that send neither header
 * (curl, the test harness, another member of the cluster) are not browsers and
 * carry no ambient cookie risk.
 *
 * `proxy.ts` applies this to what its matcher covers. Outside it, the routes a
 * browser writes to call it themselves: sign-in, sign-out and invitations, which
 * must work with no session, and the upload and forwarding routes, whose bodies
 * are too large for the proxy. The webhook and the cluster join stay out: no
 * cookie gives them anything, their credential is in the request.
 *
 * Over plain http, as with the panel on its Tailscale IP, browsers send no
 * Sec-Fetch headers and the comparison below is what decides. Origin is then
 * held against every name the request arrived under: a proxy may rewrite Host to
 * its upstream and put the public name in X-Forwarded-Host, or keep Host and send
 * a forwarded name without the port. Accepting either weakens nothing, because a
 * page cannot choose Host, and setting X-Forwarded-Host costs it a preflight
 * nobody here answers.
 *
 * Zero imports: the unit suite loads this file directly.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type IncomingWrite = Pick<Request, "method" | "headers">;

/** `host` as a URL of this scheme writes it: lower case, default port dropped. */
function canonicalHost(protocol: string, host: string): string | null {
  try {
    return new URL(`${protocol}//${host.trim()}`).host;
  } catch {
    return null;
  }
}

export function isCrossOriginWrite(request: IncomingWrite): boolean {
  if (SAFE_METHODS.has(request.method)) return false;

  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";

  const origin = request.headers.get("origin");
  if (!origin) return false;
  let from: URL;
  try {
    from = new URL(origin);
  } catch {
    return true;
  }
  const names = [request.headers.get("host"), ...(request.headers.get("x-forwarded-host") ?? "").split(",")];
  return !names.some((name) => name && canonicalHost(from.protocol, name) === from.host);
}

/** The response to send instead, or null when the request may go on. */
export function refuseCrossOrigin(request: IncomingWrite): Response | null {
  if (!isCrossOriginWrite(request)) return null;
  return Response.json({ error: "Richiesta da un'origine diversa rifiutata" }, { status: 403 });
}
