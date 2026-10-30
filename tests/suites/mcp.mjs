import { client, createReporter, SETUP_TOKEN } from "../harness.mjs";

/**
 * API tokens and the MCP endpoint built on them.
 *
 * A token is its user minus what `access` takes away, behind a switch only the
 * owner holds. What must hold: nothing works while the switch is off; a
 * read-only token is refused every write, directly and through MCP; a token
 * cannot manage tokens; the routes the proxy does not cover never take a
 * token; and revoking or switching off ends a token at once.
 */
export const meta = { name: "mcp", needsDocker: false, drivers: ["sqlite"] };

export async function run({ base }) {
  const r = createReporter("mcp");
  const owner = client(base);

  await owner.call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ setup: true, email: "owner@runpanel.test", setupToken: SETUP_TOKEN, password: "mcp-owner-pw-1" }),
  });

  const bearer = (token) => async (path, init = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  };
  const rpc = (api) => async (method, params, id = 1) =>
    api("/api/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

  // --- the switch -----------------------------------------------------------
  const refused = await owner.call("/api/api-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "early", access: "full", expiresInDays: null }),
  });
  r.check("no token while API access is off", refused.status === 409, `status ${refused.status}`);

  const on = await owner.call("/api/api-tokens", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  r.check("the owner turns API access on", on.status === 200 && on.body.enabled === true, JSON.stringify(on.body));

  const full = await owner.call("/api/api-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "claude", access: "full", expiresInDays: 30 }),
  });
  const read = await owner.call("/api/api-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "viewer", access: "read", expiresInDays: null }),
  });
  r.check("tokens are created", full.status === 201 && read.status === 201 && /^rpk_/.test(full.body.token ?? ""),
    `${full.status} ${read.status}`);
  r.check("the list never holds a token value",
    !JSON.stringify(read.body.tokens).includes(full.body.token) && read.body.tokens.length === 2);

  const asFull = bearer(full.body.token);
  const asRead = bearer(read.body.token);

  // --- REST with a token ----------------------------------------------------
  r.check("a token reads the API", (await asFull("/api/projects")).status === 200);
  r.check("a read-only token reads the API", (await asRead("/api/projects")).status === 200);
  r.check("an unknown token is refused", (await bearer("rpk_nope")("/api/projects")).status === 401);

  const created = await asFull("/api/folders", { method: "POST", body: JSON.stringify({ name: "via-token" }) });
  r.check("a full token writes", created.status === 201, `status ${created.status}`);
  const blocked = await asRead("/api/folders", { method: "POST", body: JSON.stringify({ name: "nope" }) });
  r.check("a read-only token is refused a write", blocked.status === 403, `status ${blocked.status}`);

  r.check("a token cannot list tokens", (await asFull("/api/api-tokens")).status === 403);
  const minted = await asFull("/api/api-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "child", access: "full", expiresInDays: null }),
  });
  r.check("a token cannot mint a token", minted.status === 403, `status ${minted.status}`);

  // The upload route is outside the proxy: it must not take a token, forged mark or not.
  const upload = await asRead("/api/upload", {
    method: "POST",
    headers: { "x-runpanel-api-token": "0".repeat(64) },
    body: "{}",
  });
  r.check("a route outside the proxy does not take a token", upload.status === 401, `status ${upload.status}`);

  // --- MCP ------------------------------------------------------------------
  const init = await rpc(asRead)("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  r.check("initialize answers", init.status === 200 && init.body.result?.serverInfo?.name === "runpanel",
    JSON.stringify(init.body).slice(0, 200));
  r.check("the asked protocol version is kept", init.body.result?.protocolVersion === "2025-06-18");

  const note = await asRead("/api/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  r.check("a notification gets 202", note.status === 202, `status ${note.status}`);

  const readTools = (await rpc(asRead)("tools/list", {})).body.result?.tools ?? [];
  const fullTools = (await rpc(asFull)("tools/list", {})).body.result?.tools ?? [];
  const names = (tools) => tools.map((t) => t.name);
  r.check("a read-only token sees no write tool",
    names(readTools).includes("api_get") && !names(readTools).includes("api_request") && !names(readTools).includes("deploy_project"),
    names(readTools).join(","));
  r.check("a full token sees the write tools", names(fullTools).includes("api_request") && names(fullTools).includes("deploy_project"));

  const listed = await rpc(asRead)("tools/call", { name: "api_get", arguments: { path: "/api/folders" } });
  const listedText = listed.body.result?.content?.[0]?.text ?? "";
  r.check("a tool calls the panel as the token's user", listedText.startsWith("HTTP 200") && listedText.includes("via-token"),
    listedText.slice(0, 200));

  const sneaky = await rpc(asRead)("tools/call", {
    name: "api_request",
    arguments: { method: "POST", path: "/api/folders", body: { name: "sneaky" } },
  });
  r.check("a read-only token cannot call a write tool", sneaky.body.error?.code === -32602, JSON.stringify(sneaky.body));

  const viaMcp = await rpc(asFull)("tools/call", {
    name: "api_request",
    arguments: { method: "POST", path: "/api/folders", body: { name: "via-mcp" } },
  });
  r.check("a full token writes through MCP", (viaMcp.body.result?.content?.[0]?.text ?? "").startsWith("HTTP 201"),
    JSON.stringify(viaMcp.body).slice(0, 200));

  const outside = await rpc(asFull)("tools/call", { name: "api_get", arguments: { path: "/api/api-tokens" } });
  r.check("tools cannot reach the token routes", outside.body.result?.isError === true);

  const catalog = await rpc(asFull)("tools/call", { name: "list_endpoints", arguments: { search: "deploy" } });
  r.check("the catalog is searchable", (catalog.body.result?.content?.[0]?.text ?? "").includes("/api/projects/{projectId}/deploy"));

  const badArgs = await rpc(asFull)("tools/call", { name: "control_project", arguments: { projectId: "x", action: "explode" } });
  r.check("bad arguments are a tool error, not a crash", badArgs.body.result?.isError === true);

  // --- ending a token -------------------------------------------------------
  const revoked = await owner.call(`/api/api-tokens?id=${encodeURIComponent(full.body.id)}`, { method: "DELETE" });
  r.check("the owner revokes a token", revoked.status === 200 && revoked.body.tokens.length === 1);
  r.check("a revoked token stops working", (await asFull("/api/projects")).status === 401);

  await owner.call("/api/api-tokens", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  r.check("switching API access off ends every token", (await asRead("/api/projects")).status === 401);
  r.check("the browser session is untouched", (await owner.call("/api/projects")).status === 200);

  return r.result();
}
