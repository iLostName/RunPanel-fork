import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * When the session cookie is `Secure`.
 *
 * Always, in production, used to be the answer, and browsers refuse to store a
 * `Secure` cookie sent over plain http to anything but localhost: signing in on
 * the address a fresh install has, `http://<ip>:3000`, or on a Tailscale
 * address, answered "ok" and landed back on the sign-in form. It follows the
 * scheme the browser is on now, and stays `Secure` whenever that is https or
 * nothing says otherwise.
 */
export const meta = { name: "cookie-security-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("cookie-security-unit");
  const { sessionCookieSecure, isLoopbackHost } = await import(pathToFileURL(join(repoRoot, "lib", "cookie-security.ts")).href);

  const prod = (origin, forwardedProto = null) => sessionCookieSecure({ production: true, origin, forwardedProto });

  r.check("development never sets it", sessionCookieSecure({ production: false, origin: "https://panel.example.com", forwardedProto: "https" }) === false);
  r.check("a browser on https gets it", prod("https://panel.example.com") === true);
  r.check("a browser on plain http to an address does not", prod("http://100.93.105.14:3000") === false);
  r.check("the browser's scheme wins over a proxy header that disagrees", prod("https://panel.example.com", "http") === true);
  r.check("behind a TLS proxy with no Origin, the proxy's scheme decides", prod(null, "https") === true);
  r.check("the first hop of a chained header is the one the client used", prod(null, "https, http") === true && prod(null, "http, https") === false);
  r.check("the header's case does not matter", prod(null, "HTTPS") === true);
  r.check("an opaque origin falls through to the proxy header", prod("null", "http") === false);
  r.check("with nothing to go on it stays Secure, as before", prod(null) === true && prod("null") === true);
  r.check("an origin that is not a URL does not decide", prod("garbage", null) === true);

  r.check("localhost is loopback", isLoopbackHost("localhost") && isLoopbackHost("app.localhost"));
  r.check("127.x is loopback", isLoopbackHost("127.0.0.1") && isLoopbackHost("127.1.2.3"));
  r.check("::1 is loopback, bracketed or not", isLoopbackHost("[::1]") && isLoopbackHost("::1"));
  r.check("a LAN address is not", !isLoopbackHost("192.168.0.7"));
  r.check("a Tailscale address is not", !isLoopbackHost("100.93.105.14"));
  r.check("a name that only starts like loopback is not", !isLoopbackHost("127.0.0.1.example.com") && !isLoopbackHost("localhost.example.com"));

  return r.result();
}
