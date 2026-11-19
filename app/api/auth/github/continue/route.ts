import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { createSession } from "@/lib/auth";
import { trustedClientIp } from "@/lib/client-ip";
import { markGithubSignIn, takePendingCookie } from "@/lib/github-login";
import { refuseCrossOrigin } from "@/lib/request-origin";
import { claimLoginChallenge, isRememberedDevice, isTwoFactorEnabled, readLoginChallenge } from "@/lib/two-factor";
import { getUser, recordLogin } from "@/lib/users";
import { isNodeOnly } from "@/services/cluster/state";

/**
 * The end of a sign-in with GitHub, asked for by the sign-in page as soon as
 * the return from GitHub lands on it (`/login?github=continue`).
 *
 * GitHub vouched for who this is; the panel's own rules come now, the same
 * ones a password meets. An account with two-step sign-in gets the token for
 * the code step and goes on through `/api/auth/login/two-factor` — unless this
 * browser was remembered for it, which is read here, from a request of the
 * panel's own pages, because the remembered-device cookie is `Strict` and the
 * return from github.com could not see it. A disabled account is refused
 * (`readLoginChallenge` reads the account again). Everything else opens the
 * session, and the activity log says it came through GitHub.
 *
 * Its only credential is the `Strict` cookie the return left, which is spent
 * here whatever the outcome; no session is needed, so it is public and checks
 * the origin itself.
 */

const expired = () =>
  NextResponse.json(
    { error: "L'accesso con GitHub è scaduto: riprova.", code: "challenge_expired" },
    { status: 401, headers: { "Cache-Control": "no-store" } }
  );

export async function POST(request: NextRequest) {
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  if (await isNodeOnly()) {
    return NextResponse.json({ error: "Questo server è gestito da un altro RunPanel: accedi da lì." }, { status: 403 });
  }

  const token = await takePendingCookie();
  const challenge = await readLoginChallenge(token);
  // Only a sign-in GitHub began: the password step hands its token to the page, never to this cookie.
  if (!challenge || challenge.via !== "github" || !token) return expired();

  let remembered = false;
  if (await isTwoFactorEnabled(challenge.userId)) {
    remembered = await isRememberedDevice(challenge.userId);
    if (!remembered) {
      return NextResponse.json({ twoFactorRequired: true, challenge: token }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  // Spent once: the same return finished twice still opens one session.
  if (!(await claimLoginChallenge(challenge.id))) return expired();
  const user = await getUser(challenge.userId);
  if (!user || user.disabled === 1) return expired();

  await createSession(user.id, {
    userAgent: request.headers.get("user-agent") ?? undefined,
    ip: trustedClientIp(request) ?? undefined,
  });
  await recordLogin(user.id);
  await markGithubSignIn(user.id);
  await audit({
    userId: user.id,
    category: "security",
    action: "auth.login",
    scope: "user",
    scopeId: user.id,
    detail: remembered ? "con GitHub, dispositivo ricordato, senza codice" : "con GitHub",
    request,
  });
  return NextResponse.json({ success: true, emailRequired: user.email === null }, { headers: { "Cache-Control": "no-store" } });
}
