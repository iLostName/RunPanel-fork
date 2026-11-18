import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { isPeerMemberId } from "@/lib/backup-peer";
import { peerQuotaSchema } from "@/lib/validation";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost, setPeerQuota } from "@/services/backup/peer-hosting";
import { hostedSource } from "@/services/backup/peer-sources";

type Params = { params: Promise<{ memberId: string }> };

const notFound = () => NextResponse.json({ error: "Server non trovato" }, { status: 404 });

/**
 * How much room another server's copies may take here: a number of bytes,
 * null for no limit of its own (the disk keeps its reserve all the same), or
 * 0 to refuse its new copies. What it already keeps stays, over the limit or
 * not: a limit stops the next copy, it never deletes one. The owner's call,
 * as this server's disk is.
 */
export async function PUT(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.hosted.quota", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const { memberId } = await params;
    if (!isPeerMemberId(memberId)) return notFound();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }
    const parsed = peerQuotaSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }
    // A server this one knows: a member, or a folder of one that was.
    const source = await hostedSource(memberId);
    if (!source) return notFound();

    await setPeerQuota(memberId, parsed.data.quotaBytes);
    return NextResponse.json({ ...source, quotaBytes: parsed.data.quotaBytes });
  });
}

/**
 * Delete every copy another server keeps here. Its backups lose this copy —
 * a restore there reads another one, if it has one — so it takes the owner
 * and the server's name typed, checked here and not only in the browser.
 * Refused while that server is sending one. A server that is still linked
 * goes on sending copies afterwards, unless its limit is set to refuse them.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return withAudit(request, { category: "backup", action: "backup.hosted.delete", scope: "permission", scopeId: "backup" }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;

    const { memberId } = await params;
    if (!isPeerMemberId(memberId)) return notFound();
    const source = await hostedSource(memberId);
    if (!source) return notFound();

    const confirm = request.nextUrl.searchParams.get("confirm")?.trim();
    if (confirm !== source.name) {
      return NextResponse.json(
        { error: `Per confermare scrivi esattamente il nome del server: ${source.name}`, archives: source.archives },
        { status: 400 }
      );
    }

    try {
      const removed = peerHost().removeSource(memberId);
      // A server that is gone leaves nothing behind, its limit included.
      if (!source.linked) await setPeerQuota(memberId, null);
      return NextResponse.json({ ok: true, archives: removed.archives, bytes: removed.bytes });
    } catch (err) {
      return peerFailure(err);
    }
  });
}
