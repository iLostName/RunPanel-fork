import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { readBodyCapped } from "@/lib/read-body";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

/**
 * Reserve room for one archive: its name, size and sha256, in a small signed
 * body the proxy checks like every other. The answer carries a one-time token
 * that every piece of this upload must present, and this server keeps only
 * its hash. Refused, with the numbers, when the source's limit or the disk —
 * which always keeps a reserve for this server's own work — has no room.
 */
export async function POST(request: NextRequest) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;

  const raw = await readBodyCapped(request, 4096);
  let body: Record<string, unknown>;
  try {
    body = raw ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: "Richiesta non valida", code: "INVALID" }, { status: 400 });
  }
  if (!raw || !body || typeof body !== "object") {
    return NextResponse.json({ error: "Richiesta non valida", code: "INVALID" }, { status: 400 });
  }

  try {
    const reservation = await peerHost().reserve(
      { id: denied.member.id, name: denied.member.name, url: denied.member.url },
      { fileName: body.fileName, bytes: body.bytes, sha256: body.sha256 }
    );
    return NextResponse.json(reservation, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return peerFailure(err);
  }
}
