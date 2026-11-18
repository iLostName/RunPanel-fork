import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { peerFailure } from "@/services/backup/peer-failure";
import { peerHost } from "@/services/backup/peer-hosting";

/** Whether one of the caller's copies is still here, and its size: asked before every read. */
export async function GET(request: NextRequest) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;
  try {
    return NextResponse.json(peerHost().stat(denied.member.id, request.nextUrl.searchParams.get("ref") ?? ""), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return peerFailure(err);
  }
}
