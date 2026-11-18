import { readFile } from "node:fs/promises";
import path from "node:path";
import { serviceWorkerSource } from "@/lib/pwa/service-worker";
import { panelRelease } from "@/services/panel-update/release";

/**
 * The service worker, at the root so its scope is the whole panel.
 *
 * A route rather than a file in `public/` because the text must change with
 * every build: a browser notices a new worker only when the bytes of this
 * file differ, and a new worker is how an installed app learns that the panel
 * under it was updated (lib/pwa/service-worker.ts). The build's own id is the
 * one value that changes exactly then — not on a plain restart, and not only
 * when the version number does.
 *
 * Public, like the manifest and the icons: the proxy only guards `/api`.
 */
export const dynamic = "force-dynamic";

/**
 * Read once per process: the build cannot change under a running server, and a
 * self-update restarts it. `RUNPANEL_DIST_DIR` as in next.config.ts.
 */
let version: Promise<string> | null = null;

async function buildVersion(): Promise<string> {
  try {
    const id = await readFile(path.join(process.cwd(), process.env.RUNPANEL_DIST_DIR || ".next", "BUILD_ID"), "utf8");
    if (id.trim()) return id.trim();
  } catch {
    /* not a build directory we know: fall back to the release */
  }
  return (await panelRelease()).label;
}

export async function GET() {
  version ??= buildVersion();
  return new Response(serviceWorkerSource(await version), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // Browsers already skip their cache for this file when checking for an
      // update; a proxy in front of the panel should do the same.
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
