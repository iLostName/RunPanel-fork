import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { PEER_CHUNK_BYTES, PEER_TOKEN_HEADER } from "@/lib/backup-peer";
import { HDR_BODY, sha256Hex } from "@/lib/cluster-sign";
import { readBodyCapped } from "@/lib/read-body";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

type Params = { params: Promise<{ uploadId: string }> };

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * One piece of a reserved upload, at `?offset=`.
 *
 * Each piece is a request signed like any other between members, so the
 * proxy holds its body against the signed hash before this runs — which is
 * why a piece stays under the 10 MB the proxy buffers, and why the archive
 * does not travel as one stream: Node closes a request whose body is still
 * arriving after five minutes, and a large archive on a home uplink takes
 * longer than that. The hash is compared here again, so this route trusts
 * nothing it did not check itself, and the token names the reservation.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  const { uploadId } = await params;

  const offset = Number(request.nextUrl.searchParams.get("offset"));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return NextResponse.json({ error: "Posizione non valida", code: "INVALID" }, { status: 400, headers: NO_STORE });
  }
  const chunk = await readBodyCapped(request, PEER_CHUNK_BYTES);
  if (!chunk) return NextResponse.json({ error: "Pezzo troppo grande", code: "TOO_LARGE" }, { status: 413, headers: NO_STORE });
  if (sha256Hex(chunk) !== request.headers.get(HDR_BODY)) {
    return NextResponse.json({ error: "Firma non valida" }, { status: 401, headers: NO_STORE });
  }

  try {
    const written = await peerHost().writeChunk(denied.member.id, uploadId, request.headers.get(PEER_TOKEN_HEADER), offset, chunk);
    return NextResponse.json(written, { headers: NO_STORE });
  } catch (err) {
    return peerFailure(err);
  }
}

/**
 * Every piece is in: compare the size and sha256 with the reservation and, if
 * they match, give the archive its name. Answers with the ref the sender
 * keeps for reading, checking and deleting it later.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  const { uploadId } = await params;
  try {
    const done = await peerHost().complete(denied.member.id, uploadId, request.headers.get(PEER_TOKEN_HEADER));
    return NextResponse.json(done, { status: 201, headers: NO_STORE });
  } catch (err) {
    return peerFailure(err);
  }
}

/** The sender gave up: its pieces go now. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  const { uploadId } = await params;
  try {
    await peerHost().abort(denied.member.id, uploadId, request.headers.get(PEER_TOKEN_HEADER));
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    return peerFailure(err);
  }
}
