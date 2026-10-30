import { MemberUnreachableError, signedFetch } from "@/services/cluster/client";
import { clusterState, getMember } from "@/services/cluster/state";

/**
 * How an MCP tool does anything: it calls the panel's own REST API, as the
 * user behind the token, and reads the answer.
 *
 * Nothing is reimplemented here and nothing is skipped. A call to this panel
 * goes back in over loopback carrying the same `Authorization` header, so it
 * passes the proxy (and its read-only check) and the route's own guard like
 * any request; a call to another server of the cluster goes out signed, for
 * the same user, exactly like the browser's `/api/nodes/<id>/…` forward, and
 * that server applies its own copy of the user's grants. A tool can therefore
 * never do what its user could not do from the browser.
 */

export type PanelMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PanelCall {
  method: PanelMethod;
  /** `/api/...`, with `{param}` already filled in. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** A cluster member id; absent, null or this panel's own id means here. */
  server?: string | null;
}

export interface PanelReply {
  status: number;
  /** Parsed JSON when the answer was JSON, else text or a note on what it was. */
  body: unknown;
}

export interface PanelCaller {
  userId: string;
  /** The incoming request's credentials, sent back in unchanged. */
  authorization: string | null;
  cookie: string | null;
}

export class PanelCallError extends Error {}

/**
 * Off limits to tools: signing in and out, the endpoints only another member
 * of the cluster or GitHub calls, the browser's own forward and upload, the
 * token management (a token cannot manage tokens anyway) and this endpoint.
 */
const BLOCKED = [
  /^\/api\/auth\//,
  /^\/api\/webhooks\//,
  /^\/api\/nodes\//,
  /^\/api\/upload$/,
  /^\/api\/mcp$/,
  /^\/api\/api-tokens$/,
  /^\/api\/cluster\/(join|directory|leave|ping|secret)$/,
];

const MAX_BODY_CHARS = 120_000;
const TIMEOUT_MS = 90_000;

export function checkPath(path: string): string | null {
  if (!/^\/api\/[A-Za-z0-9._~%@:+-]+(\/[A-Za-z0-9._~%@:+-]+)*$/.test(path)) {
    return "Il path deve essere un endpoint /api/... senza query string (usa `query`)";
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return "Path non valido";
  if (BLOCKED.some((re) => re.test(path))) return `${path} non è disponibile da qui`;
  return null;
}

/**
 * This panel's own address. Next records the one it listened on; `localhost`
 * is spelled out as 127.0.0.1 so a host that resolves it to `::1` first does
 * not miss a server bound to IPv4 only.
 */
function selfOrigin(): string {
  const origin = process.env.__NEXT_PRIVATE_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  return origin.replace("//localhost:", "//127.0.0.1:").replace(/\/$/, "");
}

function queryString(query: PanelCall["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function callPanel(caller: PanelCaller, call: PanelCall): Promise<PanelReply> {
  const problem = checkPath(call.path);
  if (problem) throw new PanelCallError(problem);

  const target = `${call.path}${queryString(call.query)}`;
  const body = call.body === undefined || call.method === "GET" ? null : JSON.stringify(call.body);
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  const state = call.server ? await clusterState() : null;
  const remote = call.server && call.server !== state?.selfId;

  let res: Response;
  if (remote) {
    const member = state ? await getMember(call.server!) : null;
    if (!member) throw new PanelCallError(`Server ${call.server} non trovato (vedi list_servers)`);
    try {
      res = await signedFetch(member, target, {
        method: call.method,
        body,
        userId: caller.userId,
        contentType: body === null ? null : "application/json",
        accept: "application/json",
        headersTimeoutMs: 30_000,
        signal,
      });
    } catch (err) {
      const detail = err instanceof MemberUnreachableError ? `: ${err.message}` : "";
      throw new PanelCallError(`${member.name} non raggiungibile${detail}`);
    }
  } else {
    const headers: Record<string, string> = { accept: "application/json" };
    if (caller.authorization) headers.authorization = caller.authorization;
    if (caller.cookie) headers.cookie = caller.cookie;
    if (body !== null) headers["content-type"] = "application/json";
    res = await fetch(`${selfOrigin()}${target}`, { method: call.method, headers, body, signal, redirect: "manual" });
  }

  return { status: res.status, body: await readBody(res) };
}

async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  // A live stream never ends on its own; the snapshot routes beside it answer the same question.
  if (type.includes("text/event-stream")) {
    await res.body?.cancel();
    return "[stream SSE: non leggibile da qui, usa l'endpoint non-stream corrispondente]";
  }
  const textual = type === "" || /json|text|xml|javascript/.test(type);
  if (!textual) {
    await res.body?.cancel();
    return `[contenuto binario ${type}${res.headers.get("content-length") ? `, ${res.headers.get("content-length")} byte` : ""}: non leggibile da qui]`;
  }

  const text = await readCapped(res, MAX_BODY_CHARS);
  if (type.includes("json") && !text.truncated) {
    try {
      return JSON.parse(text.value);
    } catch {
      /* fall through to text */
    }
  }
  return text.truncated ? `${text.value}\n…[troncato a ${MAX_BODY_CHARS} caratteri]` : text.value;
}

async function readCapped(res: Response, max: number): Promise<{ value: string; truncated: boolean }> {
  if (!res.body) return { value: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    value += decoder.decode(chunk, { stream: true });
    if (value.length > max) {
      await reader.cancel();
      return { value: value.slice(0, max), truncated: true };
    }
  }
  value += decoder.decode();
  return { value, truncated: false };
}
