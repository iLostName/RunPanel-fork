import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requireOwner, requireUser, type AuthContext } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import {
  API_TOKENS_SETTING,
  API_TOKEN_EXPIRY_DAYS,
  apiTokensEnabled,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "@/lib/api-tokens";
import { setSetting } from "@/lib/settings";
import { isNodeOnly } from "@/services/cluster/state";

/**
 * Your API tokens — what an AI assistant (MCP) or a script signs in with.
 *
 * Managed only from a signed-in browser: a token cannot list, mint or revoke
 * tokens, so a leaked one cannot make itself a longer-lived successor. The
 * panel-wide switch (`PATCH`) is the owner's.
 */

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    access: z.enum(["read", "full"]),
    expiresInDays: z.literal([...API_TOKEN_EXPIRY_DAYS]).nullable(),
  })
  .strict();

const switchSchema = z.object({ enabled: z.boolean() }).strict();

function refuseToken(ctx: AuthContext): NextResponse | null {
  if (!ctx.session.apiToken) return null;
  return NextResponse.json({ error: "I token si gestiscono dal pannello, non con un token" }, { status: 403 });
}

async function listing(userId: string) {
  return { enabled: await apiTokensEnabled(), tokens: await listApiTokens(userId) };
}

export async function GET() {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = refuseToken(ctx);
  if (refused) return refused;
  return NextResponse.json(await listing(ctx.session.user.id), { headers: { "Cache-Control": "no-store" } });
}

/** Mint a token. The response is the only time its value is ever shown. */
export async function POST(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = refuseToken(ctx);
  if (refused) return refused;

  if (!(await apiTokensEnabled())) {
    return NextResponse.json({ error: "L'accesso via token è spento: il proprietario può attivarlo" }, { status: 409 });
  }
  if (await isNodeOnly()) {
    return NextResponse.json({ error: "Questo server è gestito da un altro RunPanel: crea il token da lì." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi", details: parsed.error.issues }, { status: 400 });

  const { id, token } = await createApiToken(ctx.session.user.id, parsed.data);
  await audit({
    userId: ctx.session.user.id,
    category: "security",
    action: "api-token.create",
    scope: "user",
    scopeId: ctx.session.user.id,
    detail: `${parsed.data.name} (${parsed.data.access === "full" ? "controllo completo" : "sola lettura"})`,
    request,
  });
  return NextResponse.json({ id, token, ...(await listing(ctx.session.user.id)) }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = refuseToken(ctx);
  if (refused) return refused;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Serve il parametro id" }, { status: 400 });
  if (!(await revokeApiToken(ctx.session.user.id, id))) {
    return NextResponse.json({ error: "Token non trovato" }, { status: 404 });
  }
  await audit({ userId: ctx.session.user.id, category: "security", action: "api-token.revoke", scope: "user", scopeId: ctx.session.user.id, request });
  return NextResponse.json(await listing(ctx.session.user.id));
}

/** Turn API access on or off for the whole panel. Off ends every token at once. */
export async function PATCH(request: NextRequest) {
  const ctx = await requireOwner();
  if (isDenied(ctx)) return ctx;
  const refused = refuseToken(ctx);
  if (refused) return refused;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = switchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Dati non validi" }, { status: 400 });

  await setSetting(API_TOKENS_SETTING, parsed.data.enabled ? "1" : "0");
  await audit({
    userId: ctx.session.user.id,
    category: "security",
    action: parsed.data.enabled ? "api-tokens.enable" : "api-tokens.disable",
    request,
  });
  return NextResponse.json(await listing(ctx.session.user.id));
}
