import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { firstIssue, mailActionSchema, smtpSettingsSchema } from "@/lib/notify-schema";
import { clearSmtpConfig, publicSmtpConfig, readSmtpConfig, sendMail, writeSmtpConfig } from "@/services/mail";

/**
 * The panel's mail server.
 *
 * The owner's alone, and not the Notifications permission's: this server will
 * also carry invitations and password-reset links, and whoever can point it
 * somewhere else can read those. The password is write-only like every other
 * secret: the screen is told whether there is one.
 */

export async function GET() {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  return NextResponse.json(await publicSmtpConfig(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  return withAudit(request, { category: "system", action: "mail.settings" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = smtpSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error.issues), details: parsed.error.issues }, { status: 400 });
    }

    const current = await readSmtpConfig();
    const password = parsed.data.password || undefined;
    if (parsed.data.username && !password && !current?.password) {
      return NextResponse.json({ error: "Con un nome utente serve anche la password" }, { status: 400 });
    }

    await writeSmtpConfig({
      host: parsed.data.host,
      port: parsed.data.port,
      security: parsed.data.security,
      username: parsed.data.username,
      from: parsed.data.from,
      allowInvalidCert: parsed.data.allowInvalidCert ?? false,
      password,
    });
    return NextResponse.json(await publicSmtpConfig());
  });
}

/** `test` sends one email to the address given; `clear` forgets the server. */
export async function POST(request: NextRequest) {
  // Read first only to name the entry in the activity log; the guard below
  // still runs before anything is done with it.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const clearing = (raw as { action?: unknown } | null)?.action === "clear";

  return withAudit(request, { category: "system", action: clearing ? "mail.clear" : "mail.test" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const parsed = mailActionSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: firstIssue(parsed.error.issues) }, { status: 400 });
    }

    if (parsed.data.action === "clear") {
      await clearSmtpConfig();
      return NextResponse.json(await publicSmtpConfig());
    }

    const limit = await consumeRateLimit(`mail-test:${denied.session.user.id}`, 5, 60_000);
    if (!limit.allowed) {
      return NextResponse.json({ error: `Troppe prove di fila: riprova tra ${limit.retryAfter} secondi.` }, { status: 429 });
    }

    const result = await sendMail({
      to: parsed.data.to,
      subject: "[RunPanel] Email di prova",
      text: "Se leggi questo messaggio, il pannello sa mandare email: notifiche, e in futuro inviti e recupero della password.\n\n—\nRunPanel",
    });
    return NextResponse.json(result.ok ? { ok: true } : { ok: false, error: result.error });
  });
}
