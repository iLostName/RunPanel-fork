/**
 * Where a sign-in may send the browser afterwards: a page of this panel, and
 * nothing that only looks like one.
 *
 * The value arrives from outside — a `next` in a URL, a field in a request —
 * and a sign-in that redirects wherever it is told is how a link to a real
 * panel ends on a copy of its login page somewhere else. Every spelling a
 * browser reads as "another host" is refused rather than repaired:
 * `//evil.example`, `/\evil.example` (backslashes count as slashes in a URL),
 * `/%2F%2Fevil.example` for whatever decodes before reading, a scheme, a tab or
 * a newline that the URL parser silently drops. What is left is resolved
 * against a placeholder origin and kept only if it is still there.
 *
 * API routes are refused too: after a sign-in a browser is sent to a page, and
 * a GET on an endpoint is not one. So are the sign-in and invitation pages,
 * which would only send it round again.
 *
 * Zero imports: the sign-in page and the routes share it, and the unit suite
 * loads it directly.
 */

const PLACEHOLDER = "http://runpanel.invalid";
const MAX_LENGTH = 512;

export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // Any backslash, control character or whitespace: a browser normalises or
  // drops them, so what it opens is not what was checked.
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw)) return null;
  // Encoded slashes and backslashes, anywhere: decoded once by anything in
  // between, `/%2F%2Fevil.example` is `//evil.example`.
  if (/%(?:2f|5c)/i.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER) return null;
  if (url.username || url.password) return null;

  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) return null;
  if (path === "/login" || path.startsWith("/login/") || path.startsWith("/invite/")) return null;

  return `${path}${url.search}${url.hash}`;
}
