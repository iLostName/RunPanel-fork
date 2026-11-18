import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { hostedOverview } from "@/services/backup/peer-sources";

/**
 * What this server keeps for the other servers of its cluster — their copies,
 * in a folder each, apart from this server's own backups — and how much space
 * they take: one row per source, linked or not any more, with the limit its
 * owner gave it and the disk's reserve. Names and numbers only: the archives
 * themselves, and what to do with them, are the owner's.
 */
export async function GET() {
  const denied = await requirePermission("backup");
  if (isDenied(denied)) return denied;
  return NextResponse.json(await hostedOverview(), { headers: { "Cache-Control": "no-store" } });
}
