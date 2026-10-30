import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { apiTokensEnabled } from "@/lib/api-tokens";
import { handleMessage, rpcError, type McpContext } from "@/services/mcp/server";

/**
 * MCP over Streamable HTTP, for an AI assistant such as Claude.
 *
 *   claude mcp add --transport http runpanel https://<panel>/api/mcp \
 *     --header "Authorization: Bearer rpk_…"
 *
 * Signed in with an API token (see `lib/api-tokens.ts`) and off unless the
 * owner turned API access on. Stateless: each POST carries one JSON-RPC
 * message (or a batch) and gets one JSON answer; there is no server-sent
 * stream to open, so GET and DELETE answer 405 as the spec allows.
 */

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  if (!(await apiTokensEnabled())) {
    return NextResponse.json({ error: "L'accesso via token (MCP) è spento" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const mcp: McpContext = {
    caller: {
      userId: ctx.session.user.id,
      authorization: request.headers.get("authorization"),
      cookie: request.headers.get("cookie"),
    },
    readOnly: ctx.session.apiToken?.access === "read",
  };

  if (Array.isArray(payload)) {
    const replies = [];
    for (const message of payload) {
      const reply = await handleMessage(message, mcp);
      if (reply) replies.push(reply);
    }
    return replies.length ? NextResponse.json(replies, { headers: NO_STORE }) : new NextResponse(null, { status: 202 });
  }

  const reply = await handleMessage(payload, mcp);
  return reply ? NextResponse.json(reply, { headers: NO_STORE }) : new NextResponse(null, { status: 202 });
}

export async function GET() {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  return new NextResponse(null, { status: 405, headers: { Allow: "POST" } });
}
