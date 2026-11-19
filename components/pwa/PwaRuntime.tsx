"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { isStandalone } from "@/lib/pwa/install";
import { panelPath } from "@/lib/push-rules";

/** How often an open panel asks whether it was updated, besides on coming back to the foreground. */
const CHECK_EVERY_MS = 30 * 60_000;
/** Coming back to the foreground asks too, but not more often than this. */
const CHECK_AT_MOST_MS = 5 * 60_000;
const UPDATE_TOAST = "panel-update-ready";

/**
 * The installed app's runtime: the service worker and the links that leave.
 *
 * Mounted once at the root, so the login page registers the worker too: the
 * installed app starts there whenever the session has expired.
 *
 * **The worker** (lib/pwa/service-worker.ts) is registered only in a
 * production build on a secure origin — browsers refuse it on plain HTTP,
 * and in `next dev` its cache would only serve stale chunks to the developer
 * — and never on the public status page, whose visitors have no use for it.
 *
 * **A new version** of the panel is a new worker, which waits. A toast offers
 * it; nothing reloads until the press, because reloading by itself would
 * throw away whatever form is half filled. On the press the waiting worker
 * takes over and the page reloads once, when it has. Another tab of the panel
 * open at the time only changes its toast to say that a reload is now enough.
 *
 * **Links to other sites**, inside the installed app, open in the browser: in
 * the app they would replace the panel in its own window, with no address bar
 * to come back by.
 *
 * **A notification pressed** while the panel is open: the worker focuses this
 * window and asks it to show the notification's page, which it does with the
 * router, keeping everything already loaded — and on the sign-in page too,
 * where a session that ran out takes it.
 */
export function PwaRuntime() {
  const router = useRouter();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "runpanel:open") router.push(panelPath(data.url));
    };
    container.addEventListener("message", onMessage);
    // A listener added this way, unlike `onmessage`, receives nothing until asked to.
    container.startMessages();
    return () => container.removeEventListener("message", onMessage);
  }, [router]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    if (window.location.pathname.startsWith("/status/")) return;

    const container = navigator.serviceWorker;
    let registration: ServiceWorkerRegistration | null = null;
    let controlled = Boolean(container.controller);
    let asked = false;
    let lastCheck = Date.now();

    const offer = (worker: ServiceWorker) => {
      toast("Nuova versione del pannello", {
        id: UPDATE_TOAST,
        description: "Il pannello è stato aggiornato. Aggiorna per usare la versione nuova.",
        duration: Infinity,
        action: {
          label: "Aggiorna",
          onClick: () => {
            asked = true;
            worker.postMessage({ type: "SKIP_WAITING" });
          },
        },
      });
    };

    const watch = (reg: ServiceWorkerRegistration) => {
      // Already waiting from an earlier visit: only if a worker controls this
      // page, otherwise it is the first install and there is nothing to update.
      if (reg.waiting && container.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const incoming = reg.installing;
        incoming?.addEventListener("statechange", () => {
          if (incoming.state === "installed" && container.controller) offer(incoming);
        });
      });
    };

    const onControllerChange = () => {
      // The first worker claiming a page that had none is not an update.
      if (!controlled) {
        controlled = true;
        return;
      }
      if (asked) {
        window.location.reload();
        return;
      }
      // Updated from another tab: this one runs the old code under the new worker.
      toast("Nuova versione del pannello", {
        id: UPDATE_TOAST,
        description: "È già attiva in un'altra scheda: ricarica questa per usarla.",
        duration: Infinity,
        action: { label: "Ricarica", onClick: () => window.location.reload() },
      });
    };

    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < CHECK_AT_MOST_MS) return;
      lastCheck = Date.now();
      void registration?.update().catch(() => {});
    };

    container.addEventListener("controllerchange", onControllerChange);
    container
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
        watch(reg);
      })
      .catch(() => {
        /* the panel works the same without it */
      });
    const timer = setInterval(() => {
      lastCheck = 0;
      check();
    }, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", check);

    return () => {
      container.removeEventListener("controllerchange", onControllerChange);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  useEffect(() => {
    if (!isStandalone()) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      // mailto: and the like go to the system as they are.
      if (url.origin === window.location.origin || !/^https?:$/.test(url.protocol)) return;
      event.preventDefault();
      window.open(url.href, "_blank", "noopener,noreferrer");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
