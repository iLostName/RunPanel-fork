import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/auth";
import { refuseCrossOrigin } from "@/lib/request-origin";

export async function POST(request: NextRequest) {
  const refused = refuseCrossOrigin(request);
  if (refused) return refused;

  await destroySession();
  return NextResponse.json({ success: true });
}
