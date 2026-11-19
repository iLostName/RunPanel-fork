import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireUser, type AuthContext } from "@/lib/auth-guard";
import { audit } from "@/lib/audit";
import { isClusterSession } from "@/lib/auth";
import { githubLinkOf, githubLoginAvailable, unlinkGithub } from "@/lib/github-login";
import { refuseCrossOrigin } from "@/lib/request-origin";
import { getUser } from "@/lib/users";

/**
 * One's own GitHub account: which one is linked, and unlinking it. Linking is
 * a trip to GitHub (`/api/auth/github/start`, intent `link`).
 *
 * Under `/api/auth` like two-step sign-in, and for the same reasons: an API
 * token never reaches it (only the proxy marks a token as a session, and the
 * proxy does not cover this prefix), and an MCP tool cannot call it
 * (`services/mcp/panel-api.ts` blocks the prefix). How a person signs in is for
 * that person, in a browser. The cross-origin check is made here.
 */

function browserOnly(ctx: AuthContext): NextResponse | null {
  if (!ctx.session.apiToken && !isClusterSession(ctx.session.sessionId)) return null;
  return NextResponse.json({ error: "L'accesso con GitHub si gestisce dal pannello, con il browser" }, { status: 403 });
}

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = browserOnly(ctx);
  if (refused) return refused;

  const [link, available, user] = await Promise.all([
    githubLinkOf(ctx.session.user.id),
    githubLoginAvailable(),
    getUser(ctx.session.user.id),
  ]);
  return NextResponse.json(
    {
      available,
      linked: link ? { login: link.login, linkedAt: link.linkedAt, lastUsedAt: link.lastUsedAt } : null,
      hasPassword: Boolean(user?.password_hash),
    },
    { headers: noStore }
  );
}

/**
 * Unlink. Refused while the account has no password: GitHub would be its only
 * way in, and unlinking would shut its owner out for good.
 */
export async function DELETE(request: NextRequest) {
  const crossOrigin = refuseCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;
  const refused = browserOnly(ctx);
  if (refused) return refused;

  const userId = ctx.session.user.id;
  const user = await getUser(userId);
  if (!user) return NextResponse.json({ error: "Account non trovato" }, { status: 404 });
  if (!user.password_hash) {
    return NextResponse.json(
      {
        error: "Entri solo con GitHub: imposta prima una password, o non potresti più entrare.",
        code: "password_required",
      },
      { status: 409 }
    );
  }

  const removed = await unlinkGithub(userId);
  if (!removed) return NextResponse.json({ error: "Nessun account GitHub collegato" }, { status: 409 });
  await audit({
    userId,
    category: "security",
    action: "account.github.unlink",
    scope: "user",
    scopeId: userId,
    detail: `@${removed.login} (id ${removed.githubId})`,
    request,
  });
  return NextResponse.json({ success: true }, { headers: noStore });
}
