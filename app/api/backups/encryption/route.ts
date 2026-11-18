import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner, requirePermission } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { backupEncryptionSchema } from "@/lib/validation";
import { BackupPasswordError, disableEncryption, encryptionStatus, setBackupPassword } from "@/services/backup/keyring";

/**
 * The backup password of this server: whether new archives are encrypted,
 * since when, and how many older passwords are kept for older archives.
 *
 * Anyone holding `backup` may see the state — their archives are encrypted
 * too. Only the owner sets, changes or turns it off: it decides what every
 * archive is sealed with, everyone's included. The password itself never
 * comes back out of the API.
 */
export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;
  return NextResponse.json(await encryptionStatus());
}

/** Set the password, or replace it: the previous one stays, for the archives it sealed. */
export async function PUT(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.encryption.set", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = backupEncryptionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      return NextResponse.json(await setBackupPassword(parsed.data.password));
    } catch (err) {
      if (err instanceof BackupPasswordError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
  });
}

/** New archives in clear again. Those already encrypted stay so, and stay readable here. */
export async function DELETE(request: NextRequest) {
  return withAudit(request, { category: "backup", action: "backup.encryption.disable", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;
    const changed = await disableEncryption();
    return NextResponse.json({ ...(await encryptionStatus()), changed });
  });
}
