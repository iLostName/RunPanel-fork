import { UPTIME_TIMEOUT_MS, causeOfError, judgeStatus, type UptimeCause } from "@/lib/uptime-math";

export interface ProbeResult {
  ok: boolean;
  /** The HTTP status, when anything answered. */
  status: number | null;
  /** Milliseconds to the response headers: what a visitor waits before anything happens. */
  latencyMs: number | null;
  cause: UptimeCause | null;
}

/**
 * One request to an app on this machine, the way its health check asks.
 *
 * The URL is built and then checked against its own origin, for the reason the
 * deploy probe gives in `services/deploy-steps.ts`: `${port}${path}` looks as
 * if it can only reach loopback, and with a path of `@example.com/` it reaches
 * example.com. The path is panel-only, but this closes the shape of the bug
 * rather than trusting who typed it.
 *
 * Redirects are not followed — a redirect is an answer — and the body is not
 * read: the question is whether the app answers, and a large page downloaded
 * every minute for every app is bandwidth nobody asked to spend.
 */
export async function probeApp(
  port: number,
  path: string,
  expectStatus: readonly number[],
  timeoutMs = UPTIME_TIMEOUT_MS
): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${port}`;
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    return { ok: false, status: null, latencyMs: null, cause: "path" };
  }
  if (url.origin !== new URL(base).origin) return { ok: false, status: null, latencyMs: null, cause: "path" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
      cache: "no-store",
      headers: { "user-agent": "RunPanel-Uptime" },
    });
    const latencyMs = Math.round(performance.now() - started);
    void res.body?.cancel().catch(() => undefined);
    const verdict = judgeStatus(res.status, expectStatus);
    return { ok: verdict.ok, status: res.status, latencyMs, cause: verdict.cause };
  } catch (err) {
    return { ok: false, status: null, latencyMs: null, cause: causeOfError(err) };
  } finally {
    clearTimeout(timer);
  }
}
