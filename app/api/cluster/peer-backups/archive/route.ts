import fs from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * One of the caller's own copies, streamed back: a restore, a download or an
 * integrity check on the server that made it. `ref` is resolved only inside
 * the caller's own folder, after its shape is checked, so another server's
 * copy is simply not there. The sender compares what it reads with the
 * sha256 it recorded, as it does for every destination.
 */
export async function GET(request: NextRequest) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  try {
    const found = peerHost().locate(denied.member.id, request.nextUrl.searchParams.get("ref") ?? "");
    if (!found) return NextResponse.json({ error: "L'archivio non c'è più", code: "NOT_FOUND" }, { status: 404, headers: NO_STORE });
    return new Response(Readable.toWeb(fs.createReadStream(found.file)) as ReadableStream, {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(found.bytes), ...NO_STORE },
    });
  } catch (err) {
    return peerFailure(err);
  }
}

/** Delete one of the caller's copies: its retention, or the run deleted there. Gone already is fine. */
export async function DELETE(request: NextRequest) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  try {
    const removed = peerHost().remove(denied.member.id, request.nextUrl.searchParams.get("ref") ?? "");
    return NextResponse.json({ ok: true, removed }, { headers: NO_STORE });
  } catch (err) {
    return peerFailure(err);
  }
}
