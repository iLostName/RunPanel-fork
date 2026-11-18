import { NextRequest } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { loadPrincipal } from "@/lib/principal";
import { watchAccess } from "@/lib/stream-guard";
import { authzEvents } from "@/services/events";
import { centerEvents } from "@/services/notify/center";
import { canSee } from "@/services/notify/inbox";

/**
 * The bell's live feed, as Server-Sent Events.
 *
 * It carries no content, only "something changed": a notification this user
 * may see was filed (`created`), or their read state changed in another tab
 * (`read`). The page then asks `/api/notifications` again, so what is shown is
 * always decided by the one function that decides it, and nothing a user may
 * not see ever travels down this connection — not even its title.
 *
 * Visibility is checked against the account as it is now: a grant given or
 * taken while the stream is open is picked up from `authzEvents`, and losing
 * the session or the account ends the stream (`watchAccess`).
 */
export async function GET(request: NextRequest) {
  const ctx = await requireUser();
  if (isDenied(ctx)) return ctx;

  const user = ctx.session.user;
  let principal = ctx.principal;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let unsubscribeAuthz: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribeAuthz?.();
        stopWatching?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed by the client going away */
        }
      };

      send({ type: "ready" });

      unsubscribe = centerEvents.subscribe((event) => {
        if (event.type === "read") {
          if (event.userId === user.id) send({ type: "read" });
          return;
        }
        void canSee(principal, event)
          .then((visible) => {
            if (visible) send({ type: "created", id: event.id });
          })
          .catch(() => {
            /* unable to confirm is not confirmed */
          });
      });

      unsubscribeAuthz = authzEvents.subscribe(user.id, () => {
        void loadPrincipal(user)
          .then((next) => {
            principal = next;
          })
          .catch(() => {});
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          cleanup();
        }
      }, 25_000);

      // Any signed-in account may hold this stream; what it may see is
      // decided per event above.
      stopWatching = watchAccess({ userId: user.id, sessionId: ctx.session.sessionId }, async () => true, cleanup);

      request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      unsubscribe?.();
      unsubscribeAuthz?.();
      stopWatching?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
