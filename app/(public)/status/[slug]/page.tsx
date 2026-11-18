import type { Metadata } from "next";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/auth";
import { allowsIndexing, pageAccess, type PageAccess, type StatusPageConfig } from "@/lib/status-page";
import { THEME_COOKIE } from "@/lib/theme-mode";
import { readStatusPageConfig } from "@/services/status-page/store";
import { panelTimeZone, statusSnapshot } from "@/services/status-page/snapshot";
import { AutoRefresh } from "./_components/AutoRefresh";
import { StatusView } from "./_components/StatusView";

/**
 * The public status page: `/status/<slug>`, for anyone with the link.
 *
 * Outside `(panel)` on purpose — that group's layout is what sends a visitor
 * without a session to the login — and not an API: the page is rendered here,
 * on the server, from the store, so there is no public endpoint to exclude
 * from `proxy.ts` and nothing for a script to poll but the page itself.
 *
 * Off, or at any address but the owner's, it is the 404 every mistyped path
 * gets, never a 403 that would say something is there: `proxy.ts` rewrites
 * those requests to the ordinary 404 before this renders, and `notFound()`
 * below repeats the decision for whatever slips between the two. The one
 * exception is the owner, signed in, opening the right address of a page
 * that is off: they get a preview, marked as such, so a page can be checked
 * before it goes public. What it shows comes from `statusSnapshot`, cached for
 * every visitor; see `lib/status-page.ts` for what it may contain.
 */

type Props = { params: Promise<{ slug: string }> };

/** Every minute, like the check itself; only while the page is in view. */
const REFRESH_MS = 60_000;

interface Resolved {
  config: StatusPageConfig;
  access: Exclude<PageAccess, null>;
}

// Shared by the metadata and the page: one read of the store per request.
const resolve = cache(async (slug: string): Promise<Resolved | null> => {
  const config = await readStatusPageConfig();
  let access = pageAccess(config, slug, false);
  // The session is read only when it could change the answer: the right
  // address of a page that is off.
  if (access === null && pageAccess(config, slug, true) === "preview") {
    const session = await getSession();
    access = pageAccess(config, slug, Boolean(session?.user.isOwner));
  }
  return config && access ? { config, access } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await resolve((await params).slug);
  // No `notFound()` here: thrown from the metadata it lands outside the
  // not-found boundary, and Next answers with its error shell and a body
  // drawn in the browser — a 404 that looks like no other 404. The page
  // throws it instead, and this one is the root's title, like any 404.
  if (!page) return {};
  const index = allowsIndexing(page.config, page.access);
  return {
    // Absolute: the panel's " · RunPanel" suffix is not the owner's title.
    title: { absolute: page.config.title },
    description: "Lo stato dei servizi in questo momento, l'uptime degli ultimi 30 giorni e le interruzioni recenti.",
    robots: index ? { index: true, follow: false } : { index: false, follow: false, nocache: true },
    // The panel's installable app is not for the page's visitors: added to a
    // home screen from here it would open the panel's login.
    manifest: null,
    appleWebApp: null,
    other: { "apple-mobile-web-app-capable": "" },
  };
}

/**
 * The panel opens dark unless the browser chose otherwise; a visitor who
 * never opened the panel has chosen nothing, so the page follows their
 * system instead. Inline and first, before anything paints; the same switch
 * `THEME_BOOT_SCRIPT` makes for "Sistema".
 */
const FOLLOW_SYSTEM_SCRIPT = `(function(){try{var e=document.documentElement;e.setAttribute("data-theme-mode","system");var l=window.matchMedia("(prefers-color-scheme: light)").matches;e.setAttribute("data-theme",l?"light":"dark");e.classList.toggle("dark",!l);}catch(_){}})();`;

export default async function StatusPage({ params }: Props) {
  const page = await resolve((await params).slug);
  if (!page) notFound();

  const [snapshot, zone, cookieStore] = await Promise.all([statusSnapshot(page.config), panelTimeZone(), cookies()]);
  const followSystem = !cookieStore.get(THEME_COOKIE)?.value;

  return (
    <>
      {followSystem && <script dangerouslySetInnerHTML={{ __html: FOLLOW_SYSTEM_SCRIPT }} />}
      <StatusView
        title={page.config.title}
        message={page.config.message}
        snapshot={snapshot}
        zone={zone}
        preview={page.access === "preview"}
      />
      <AutoRefresh everyMs={REFRESH_MS} />
    </>
  );
}
