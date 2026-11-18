import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { isPeerMemberId } from "@/lib/backup-peer";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

type Params = { params: Promise<{ memberId: string }> };

/**
 * The archives another server keeps here, newest first: name, size, when it
 * arrived. Owner only, like downloading them — which is how a server that
 * was lost is restored from here: download, then "Ripristina da un archivio"
 * on the server that replaces it.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;

  const { memberId } = await params;
  if (!isPeerMemberId(memberId)) return NextResponse.json({ error: "Server non trovato" }, { status: 404 });
  try {
    return NextResponse.json({ archives: peerHost().archives(memberId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return peerFailure(err);
  }
}
