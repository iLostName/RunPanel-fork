import { NextResponse } from "next/server";
import { PeerHostError } from "./peer-host";

/**
 * What a route answers when the copies of another server are refused: its
 * status, its stable code and the numbers behind it (used, limit, free),
 * which the sender turns into its own sentence — it knows what its owner
 * calls this server, this server does not.
 *
 * Apart from peer-hosting.ts so the boot sweep and the scheduler, which use
 * that one, do not load the route machinery.
 */
export function peerFailure(err: unknown): NextResponse {
  if (err instanceof PeerHostError) {
    return NextResponse.json({ error: err.message, code: err.code, ...err.details }, { status: err.status, headers: { "Cache-Control": "no-store" } });
  }
  console.error("[peer-backups]", err);
  return NextResponse.json(
    { error: err instanceof Error ? err.message : "Errore interno", code: "SERVER_ERROR" },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  );
}
