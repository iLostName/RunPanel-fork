import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { newSealedKeyPair } from "@/services/backup/destinations/kinds";

/**
 * A key pair for an SFTP destination that does not exist yet — or for one
 * whose key is being replaced.
 *
 * The public half has to be on the server before "Verifica" can pass, so it
 * is made before the destination is saved. The private half never leaves the
 * panel in clear: the browser gets it sealed with a key derived for this use
 * alone (`keyToken`), sends it back with the form, and only the save unseals
 * it into the encrypted config. A pair that is never saved is simply lost,
 * and its token stops being accepted after a day. Nothing is stored here.
 */
export async function POST() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;

  const pair = newSealedKeyPair();
  return NextResponse.json({
    publicKey: pair.publicKey,
    fingerprint: pair.fingerprint,
    keyToken: pair.keyToken,
  });
}
