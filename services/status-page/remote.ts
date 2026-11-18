import { randomBytes } from "node:crypto";
import { entryKey, readProjectStatus, type EntryOutcome, type StatusPageEntry } from "@/lib/status-page";
import { signedFetch } from "../cluster/client";
import { clusterState, listMembers } from "../cluster/state";

/**
 * The projects of the page that live on other servers of the cluster.
 *
 * Each server checks its own apps and keeps its own figures, so the panel
 * serving the page asks each of them once per snapshot — one signed request
 * per server, made at the cache's pace whatever the traffic — through
 * `/api/cluster/status-page`, which answers only another panel, with no user,
 * and only with the public status of the ids asked for. What comes back is
 * rebuilt field by field (`readProjectStatus`) before it reaches the page.
 *
 * A server that does not answer in time, has left the cluster or runs a
 * release without the route makes its projects "no data", never an error.
 * One that says a project does not exist makes it `missing`, off the page.
 */

/** Time for the headers; the page waits this long only when its cache is cold. */
const HEADERS_TIMEOUT_MS = 4_000;
/** And for the body, which the client's own timeout no longer covers once headers are in. */
const BODY_TIMEOUT_MS = 3_000;

async function readJson(res: Response): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), BODY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([res.json(), late]);
  } catch (err) {
    void res.body?.cancel().catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function remoteProjectStatuses(
  entries: readonly StatusPageEntry[],
  offsetMinutes: number
): Promise<Map<string, EntryOutcome>> {
  const out = new Map<string, EntryOutcome>();
  if (entries.length === 0) return out;

  const cluster = await clusterState();
  const members = cluster ? await listMembers() : [];
  const byServer = new Map<string, StatusPageEntry[]>();
  for (const entry of entries) {
    if (entry.server === null) continue;
    byServer.set(entry.server, [...(byServer.get(entry.server) ?? []), entry]);
  }

  await Promise.all(
    [...byServer].map(async ([server, list]) => {
      const unavailable = () => list.forEach((entry) => out.set(entryKey(entry), "unavailable"));
      const member = members.find((m) => m.id === server);
      if (!cluster || !member || member.id === cluster.selfId) return unavailable();
      try {
        const ids = encodeURIComponent(list.map((entry) => entry.projectId).join(","));
        // Unique per call, like every fan-out: two snapshots made in the same
        // millisecond would otherwise carry the same signature, and the second
        // would be refused as a replay.
        const nonce = randomBytes(6).toString("hex");
        const res = await signedFetch(member, `/api/cluster/status-page?ids=${ids}&tz=${offsetMinutes}&_n=${nonce}`, {
          headersTimeoutMs: HEADERS_TIMEOUT_MS,
        });
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          return unavailable();
        }
        const body = (await readJson(res)) as { projects?: Record<string, unknown> } | null;
        const projects = body && typeof body.projects === "object" && body.projects !== null ? body.projects : {};
        for (const entry of list) {
          const value = Object.hasOwn(projects, entry.projectId) ? projects[entry.projectId] : undefined;
          out.set(entryKey(entry), value === null ? "missing" : (readProjectStatus(value) ?? "unavailable"));
        }
      } catch {
        unavailable();
      }
    })
  );
  return out;
}
