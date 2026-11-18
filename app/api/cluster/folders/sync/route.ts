import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { folderSetSchema } from "@/lib/cluster-schema";
import { applyFolderSet } from "@/services/cluster/folders";

/**
 * Another member sends its copy of the folders; ours is merged with it and the
 * result is sent back, so one round trip converges both sides, as with
 * `/api/cluster/directory`.
 */
export async function POST(request: NextRequest) {
  const denied = await requireMember();
  if (isDenied(denied)) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = folderSetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Cartelle non valide", details: parsed.error.issues }, { status: 400 });
  }
  return NextResponse.json(await applyFolderSet(parsed.data), { headers: { "Cache-Control": "no-store" } });
}
