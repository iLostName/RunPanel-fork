import { z } from "zod";
import { panelVersion } from "@/lib/version";
import { ROUTES } from "./catalog";
import { PanelCallError, callPanel, type PanelCall, type PanelCaller, type PanelReply } from "./panel-api";

/**
 * The MCP server behind `/api/mcp`: JSON-RPC over Streamable HTTP, stateless.
 *
 * Small on purpose. Every request is answered with one JSON body — the spec
 * allows that instead of an SSE stream — and nothing is kept between requests,
 * so there is no session id to issue, expire or leak. That covers what an
 * assistant needs: `initialize`, `tools/list`, `tools/call`, `ping`.
 *
 * The tools are thin. A handful of everyday operations have their own, with a
 * schema the assistant can fill without guessing; everything else goes
 * through `api_get` / `api_request` after a look at `list_endpoints`, so the
 * whole panel is reachable — see `services/mcp/catalog.ts`. All of them end in
 * `callPanel`, which means the panel's own routes and guards decide.
 */

export interface McpContext {
  caller: PanelCaller;
  /** A `read` token: write tools are neither listed nor callable. */
  readOnly: boolean;
}

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `RunPanel is a self-hosted deploy panel. It manages projects (apps deployed from GitHub or a ZIP, run with a node/static/docker/compose/custom runtime), services (PostgreSQL, MySQL, Redis, MongoDB containers), backups, domains and HTTPS, users and permissions, panel updates, and possibly several servers joined in a cluster.
Every call runs as the user who owns the token, with exactly that user's permissions.
Prefer the dedicated tools. For anything else, call list_endpoints to find the endpoint, then api_get (reads) or api_request (writes).
Ids come from the list_* tools. Pass \`server\` (an id from list_servers) to act on another server of the cluster; omit it for this panel.
Long operations (deploy, backups, restores, updates) answer 202 at once: poll the matching GET until they finish.
Error messages from the panel are in Italian.`;

// --- tools ---

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  /** Changes something: hidden from a read-only token. */
  write: boolean;
  /** Can delete or overwrite what cannot be got back. */
  destructive?: boolean;
  run(args: never, ctx: McpContext): Promise<ToolResult>;
}

function tool<S extends z.ZodObject>(def: Omit<Tool, "input" | "run"> & { input: S; run(args: z.infer<S>, ctx: McpContext): Promise<ToolResult> }): Tool {
  return def as unknown as Tool;
}

const server = z.string().optional().describe("Cluster server id from list_servers. Omit for this panel.");
const query = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe("Query-string parameters.");
const apiPath = z.string().describe("Endpoint path from list_endpoints with its {params} filled in, e.g. /api/projects/abc123/logs. No query string.");
const id = (what: string) => z.string().min(1).describe(`The ${what} id.`);
const enc = encodeURIComponent;

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function reply(r: PanelReply): ToolResult {
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return text(`HTTP ${r.status}\n${body}`, r.status >= 400);
}

async function call(ctx: McpContext, request: PanelCall): Promise<ToolResult> {
  return reply(await callPanel(ctx.caller, request));
}

const TOOLS: Tool[] = [
  tool({
    name: "list_endpoints",
    title: "List API endpoints",
    description:
      "Search the catalog of every RunPanel REST endpoint: method, path, what it does, query parameters and body shape. Use it before api_get / api_request.",
    input: z.object({
      search: z.string().optional().describe("Words that must all appear in the method, path or description, e.g. 'backup policy' or 'domains'."),
    }),
    write: false,
    async run({ search }, ctx) {
      const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const lines = ROUTES.filter((r) => !ctx.readOnly || r.method === "GET")
        .filter((r) => {
          const hay = `${r.method} ${r.path} ${r.summary}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
        .map((r) =>
          [
            `${r.method} ${r.path} — ${r.summary}`,
            r.query && `  query: ${r.query}`,
            r.body && `  body: ${r.body}`,
            r.kind !== "json" && `  (${r.kind}: not readable over MCP)`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      if (lines.length === 0) return text("No endpoint matches. Try fewer or other words.");
      return text(`${lines.length} endpoint(s)${ctx.readOnly ? " (read-only token: GET only)" : ""}\n\n${lines.join("\n")}`);
    },
  }),

  tool({
    name: "api_get",
    title: "Read from the panel API",
    description: "GET any RunPanel endpoint (see list_endpoints) and return its JSON.",
    input: z.object({ path: apiPath, query, server }),
    write: false,
    run: ({ path, query, server }, ctx) => call(ctx, { method: "GET", path, query, server }),
  }),

  tool({
    name: "api_request",
    title: "Change something through the panel API",
    description:
      "POST / PUT / PATCH / DELETE any RunPanel endpoint (see list_endpoints for the body shape). Can create, change, delete and restart anything the user is allowed to.",
    input: z.object({
      method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
      path: apiPath,
      query,
      body: z.unknown().optional().describe("JSON body, as described by list_endpoints."),
      server,
    }),
    write: true,
    destructive: true,
    run: ({ method, path, query, body, server }, ctx) => call(ctx, { method, path, query, body, server }),
  }),

  tool({
    name: "list_servers",
    title: "List servers",
    description: "Every server of the cluster (just this one when there is no cluster): id, name, role, reachability, version, resource summary and warnings.",
    input: z.object({}),
    write: false,
    run: (_args, ctx) => call(ctx, { method: "GET", path: "/api/cluster/servers" }),
  }),

  tool({
    name: "list_projects",
    title: "List projects",
    description: "Projects on one server with their status, runtime, deploy count, last deploy and linked services.",
    input: z.object({ server }),
    write: false,
    run: ({ server }, ctx) => call(ctx, { method: "GET", path: "/api/projects", server }),
  }),

  tool({
    name: "get_project",
    title: "Get a project",
    description: "Everything about one project: settings, source, runtime, build config, access rules, mounts, public names (hosts).",
    input: z.object({ projectId: id("project"), server }),
    write: false,
    run: ({ projectId, server }, ctx) => call(ctx, { method: "GET", path: `/api/projects/${enc(projectId)}`, server }),
  }),

  tool({
    name: "get_project_logs",
    title: "Get project logs",
    description: "The running app's recent output (source=process), or the last 50 deployments with their status (source=deployments).",
    input: z.object({
      projectId: id("project"),
      source: z.enum(["process", "deployments"]).default("process"),
      server,
    }),
    write: false,
    run: ({ projectId, source, server }, ctx) =>
      call(ctx, {
        method: "GET",
        path: `/api/projects/${enc(projectId)}/logs`,
        query: source === "process" ? { source: "process" } : undefined,
        server,
      }),
  }),

  tool({
    name: "get_deployment",
    title: "Get a deployment",
    description: "One deployment's status and build log. Poll it after deploy_project until it is no longer pending/building.",
    input: z.object({
      deploymentId: id("deployment"),
      tail: z.number().int().min(1).max(10000).optional().describe("Only the last N lines of the build log."),
      server,
    }),
    write: false,
    run: ({ deploymentId, tail, server }, ctx) =>
      call(ctx, { method: "GET", path: `/api/deployments/${enc(deploymentId)}`, query: { tail }, server }),
  }),

  tool({
    name: "get_project_env",
    title: "Get project environment variables",
    description: "A project's environment variables. Values are masked unless reveal is true and the user may see them.",
    input: z.object({ projectId: id("project"), reveal: z.boolean().default(false), server }),
    write: false,
    run: ({ projectId, reveal, server }, ctx) =>
      call(ctx, {
        method: "GET",
        path: `/api/projects/${enc(projectId)}/env`,
        query: reveal ? { reveal: "true" } : undefined,
        server,
      }),
  }),

  tool({
    name: "list_services",
    title: "List services",
    description: "Database and cache services (PostgreSQL, MySQL, Redis, MongoDB) on one server, with status and the project each is linked to.",
    input: z.object({ server }),
    write: false,
    run: ({ server }, ctx) => call(ctx, { method: "GET", path: "/api/services", server }),
  }),

  tool({
    name: "get_service",
    title: "Get a service",
    description: "Everything about one service: status, version, ports, env injection, access rules, mounts.",
    input: z.object({ serviceId: id("service"), server }),
    write: false,
    run: ({ serviceId, server }, ctx) => call(ctx, { method: "GET", path: `/api/services/${enc(serviceId)}`, server }),
  }),

  tool({
    name: "deploy_project",
    title: "Deploy a project",
    description:
      "Queue a deploy (pull and build the latest source) or a rebuild of the current one. Answers at once with a deploymentId: follow it with get_deployment.",
    input: z.object({
      projectId: id("project"),
      mode: z.enum(["deploy", "rebuild"]).default("deploy"),
      commitSha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional().describe("Deploy and pin this commit (GitHub source, deploy mode only)."),
      server,
    }),
    write: true,
    run: ({ projectId, mode, commitSha, server }, ctx) =>
      call(ctx, { method: "POST", path: `/api/projects/${enc(projectId)}/deploy`, body: { mode, ...(commitSha ? { commitSha } : {}) }, server }),
  }),

  tool({
    name: "control_project",
    title: "Start, stop or restart a project",
    description: "Start, stop or restart a project's running app.",
    input: z.object({ projectId: id("project"), action: z.enum(["start", "stop", "restart"]), server }),
    write: true,
    run: ({ projectId, action, server }, ctx) =>
      call(ctx, { method: "POST", path: `/api/projects/${enc(projectId)}/control`, body: { action }, server }),
  }),

  tool({
    name: "set_project_env",
    title: "Set project environment variables",
    description:
      "Add, change or remove some of a project's environment variables and keep the rest. Takes effect on the next deploy or restart. Needs the right to see the current values.",
    input: z.object({
      projectId: id("project"),
      set: z.record(z.string(), z.string()).optional().describe("Variables to add or change: { KEY: value }."),
      unset: z.array(z.string()).optional().describe("Keys to remove."),
      server,
    }),
    write: true,
    async run({ projectId, set, unset, server }, ctx) {
      const path = `/api/projects/${enc(projectId)}/env`;
      const current = await callPanel(ctx.caller, { method: "GET", path, query: { reveal: "true" }, server });
      if (current.status >= 400) return reply(current);
      const list = Array.isArray(current.body) ? (current.body as { key: string; value: string }[]) : [];
      // The route replaces the whole set: writing back masked values would
      // replace every secret with the mask.
      if (list.some((v) => v.value === "••••••••")) {
        return text("The current values are masked for this user, so they cannot be kept: use api_request PUT with the complete list instead.", true);
      }
      const merged = new Map(list.map((v) => [v.key, v.value]));
      for (const key of unset ?? []) merged.delete(key);
      for (const [key, value] of Object.entries(set ?? {})) merged.set(key, value);
      return call(ctx, { method: "PUT", path, body: { vars: [...merged].map(([key, value]) => ({ key, value })) }, server });
    },
  }),

  tool({
    name: "control_service",
    title: "Start, stop or restart a service",
    description: "Start, stop or restart a database / cache service container.",
    input: z.object({ serviceId: id("service"), action: z.enum(["start", "stop", "restart"]), server }),
    write: true,
    run: ({ serviceId, action, server }, ctx) =>
      call(ctx, { method: "POST", path: `/api/services/${enc(serviceId)}/control`, body: { action }, server }),
  }),
];

function visibleTools(ctx: McpContext): Tool[] {
  return TOOLS.filter((t) => !ctx.readOnly || !t.write);
}

function describeTool(t: Tool) {
  const inputSchema = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: !t.write,
      destructiveHint: t.write && t.destructive === true,
      openWorldHint: false,
    },
  };
}

async function callTool(name: unknown, args: unknown, ctx: McpContext): Promise<ToolResult | null> {
  const t = visibleTools(ctx).find((candidate) => candidate.name === name);
  if (!t) return null;
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) {
    return text(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, true);
  }
  try {
    return await t.run(parsed.data as never, ctx);
  } catch (err) {
    if (err instanceof PanelCallError) return text(err.message, true);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return text("The panel did not answer in time. The operation may still be running: check with a GET.", true);
    }
    console.error("[mcp] tool failed:", name, err);
    return text("Internal error while running the tool.", true);
  }
}

// --- JSON-RPC ---

type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** One JSON-RPC message in, its response out — or null for a notification. */
export async function handleMessage(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const { id, method, params } = message as { id?: JsonRpcId; method?: unknown; params?: Record<string, unknown> };

  // Notifications (`notifications/initialized`, `…/cancelled`) and responses
  // to requests this server never sends: nothing to answer.
  if (id === undefined || typeof method !== "string") return null;

  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "runpanel", title: "RunPanel", version: panelVersion() },
          instructions: ctx.readOnly
            ? `${INSTRUCTIONS}\nThis token is read-only: only reads are available.`
            : INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: visibleTools(ctx).map(describeTool) } };
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments, ctx);
      if (!result) return rpcError(id, -32602, `Unknown tool: ${String(params?.name)}`);
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
