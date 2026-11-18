/**
 * Whether the session cookie is set `Secure`.
 *
 * It used to be `Secure` in every production build, which browsers refuse to
 * store when the page is plain http on anything but localhost: signing in on
 * `http://<server-ip>:3000`, the first address a fresh install has, or on a
 * Tailscale address, answered "ok" and landed back on the sign-in form with no
 * word about why. Now it follows the scheme the browser is actually on.
 *
 * What says so, most trustworthy first:
 *   - `Origin`, which a browser sends with the sign-in POST and a page cannot
 *     forge. It names the scheme the user is looking at, proxy or not.
 *   - `X-Forwarded-Proto`, for a client that sends no Origin behind a proxy that
 *     terminates TLS. A client lying here only changes its own cookie.
 *   - Neither: `Secure`, as before, so nothing that worked stops working.
 *
 * Over https it stays `Secure`, and HSTS (next.config.ts) keeps the browser from
 * ever asking for that host over http again, so a cookie set on https never
 * travels in the clear. Over plain http the sign-in page says the connection is
 * not encrypted (`app/(auth)/login`).
 *
 * Zero imports: the unit suite loads this file directly.
 */
export function sessionCookieSecure(input: {
  production: boolean;
  origin: string | null;
  forwardedProto: string | null;
}): boolean {
  // Development keeps it off, as it always has: `next dev` is plain http.
  if (!input.production) return false;

  if (input.origin) {
    try {
      const protocol = new URL(input.origin).protocol;
      if (protocol === "https:") return true;
      if (protocol === "http:") return false;
    } catch {
      /* `null` from an opaque origin, or garbage: decided below */
    }
  }

  // The first entry is the client-facing hop when proxies are chained.
  const proto = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  if (proto === "http") return false;

  return true;
}

/** Hosts a browser treats as secure even over plain http. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}
