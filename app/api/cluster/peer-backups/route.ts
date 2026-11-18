import { NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

/**
 * Another server of the cluster asking what it may keep here: the protocol
 * this server speaks, its limit, what it holds already and how much room is
 * left. Behind its "Verifica", and the first thing that tells an older
 * version (a 404) from a server that is down.
 *
 * Signed and for no user, like every route under /api/cluster/peer-backups:
 * `requireMember` refuses a call forwarded for an account through
 * /api/nodes, so no person reaches another server's copies this way. The
 * caller is the member the signature names, and it only ever sees its own.
 */
export async function GET() {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  try {
    return NextResponse.json(await peerHost().info(denied.member.id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return peerFailure(err);
  }
}
