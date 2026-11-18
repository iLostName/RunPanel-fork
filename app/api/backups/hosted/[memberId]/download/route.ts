import fs from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { isPeerMemberId } from "@/lib/backup-peer";
import { archiveContentType } from "@/services/backup/paths";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

type Params = { params: Promise<{ memberId: string }> };

/**
 * One archive another server keeps here, as stored: the way back for a
 * server that was lost. Encrypted when its server had the backup password
 * on, and then it asks for that password where it is restored.
 *
 * The ref is checked for its shape and resolved inside that server's folder
 * only; the owner reads the copies of whichever server they choose, as they
 * could from this server's disk.
 */
export async function GET(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.hosted.download", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const { memberId } = await params;
    if (!isPeerMemberId(memberId)) return NextResponse.json({ error: "Server non trovato" }, { status: 404 });
    try {
      const ref = request.nextUrl.searchParams.get("ref") ?? "";
      const found = peerHost().locate(memberId, ref);
      if (!found) return NextResponse.json({ error: "L'archivio non c'è più" }, { status: 404 });
      const fileName = ref.slice(ref.lastIndexOf("/") + 1);
      return new Response(Readable.toWeb(fs.createReadStream(found.file)) as ReadableStream, {
        headers: {
          "Content-Type": archiveContentType(fileName),
          "Content-Length": String(found.bytes),
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return peerFailure(err);
    }
  });
}
