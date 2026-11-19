"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { CRUMBS_WITHOUT_PAGE, NAV_SECTIONS, isActiveNav, titleOfPath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { SearchButton } from "@/components/SearchButton";
import { UserMenu } from "@/components/UserMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useCrumbLabels } from "@/lib/hooks/useCrumbLabel";
import { ServerSelector } from "@/components/ServerSelector";
import { useNode, useServerHref } from "@/lib/hooks/useNode";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";

interface Crumb {
  label: string;
  href: string;
  /** False for a URL level that has no page of its own. */
  linked: boolean;
  /** Opaque ids get truncated; real labels never do. */
  truncate: boolean;
}

function buildCrumbs(pathname: string, named: ReadonlyMap<string, string>): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [];
  let href = "";

  for (const segment of segments) {
    href += `/${segment}`;
    // A name the page gave (a project's, a database's) first, then the shared
    // title of the path — the one its heading prints — and the raw id last.
    const known = named.get(segment) ?? titleOfPath(href);
    crumbs.push({
      label: known ?? decodeURIComponent(segment),
      href,
      linked: !CRUMBS_WITHOUT_PAGE.has(href),
      truncate: !known,
    });
  }

  // A page that is a tab of a section says so first ("Salute / Monitor"), so
  // the trail names where it sits in the sidebar, not only its own URL.
  const section = Object.values(NAV_SECTIONS).find((s) => s.tabs.some((tab) => isActiveNav(pathname, tab)));
  if (section && crumbs.length > 0) {
    crumbs.unshift({ label: section.label, href: section.href, linked: true, truncate: false });
  }

  return crumbs;
}

/**
 * Where "back" leads from a detail page: the nearest level above it that is a
 * page. Only below a destination — a project, a run, a wizard step — never
 * from a destination itself, which the tab bar already reaches.
 */
function parentOf(pathname: string, crumbs: Crumb[]): Crumb | null {
  if (pathname.split("/").filter(Boolean).length < 2) return null;
  return crumbs.slice(0, -1).reverse().find((crumb) => crumb.linked) ?? null;
}

/**
 * Whether the page's own title, its `<h1>`, is out of sight: scrolled under the
 * bar, or not drawn at all. The phone's bar shows the title only then, the way
 * an app's large title hands over to its navigation bar, instead of printing
 * it twice one above the other.
 *
 * Pages draw their heading when their data arrives, so the `<h1>` is looked
 * for again whenever the content changes, at most once a frame.
 */
function useHeadingOutOfView(active: boolean, pathname: string): boolean {
  const [outOfView, setOutOfView] = useState(false);

  useEffect(() => {
    const main = document.getElementById("main");
    const bar = document.querySelector<HTMLElement>("[data-top-bar]");
    if (!active || !main) return;
    const io = new IntersectionObserver(([entry]) => setOutOfView(!entry.isIntersecting), {
      rootMargin: `-${bar?.offsetHeight ?? 48}px 0px 0px 0px`,
    });
    let observed: Element | null = null;
    let frame = 0;
    const attach = () => {
      frame = 0;
      const heading = main.querySelector("h1");
      if (heading === observed) return;
      if (observed) io.unobserve(observed);
      observed = heading;
      if (heading) io.observe(heading);
      else setOutOfView(true);
    };
    const changes = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(attach);
    });
    changes.observe(main, { childList: true, subtree: true });
    frame = requestAnimationFrame(attach);
    return () => {
      changes.disconnect();
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, pathname]);

  return outOfView;
}

/**
 * The bar at the top of every page.
 *
 * On a desktop: the breadcrumb, search, the server, the bell and the account.
 * On a phone it is an app's navigation bar instead, under the status bar
 * (`--safe-top`, for the notch and the translucent status bar of the
 * installed app): a back control on detail pages, the page's title once its
 * own heading has scrolled away, and search. The bell and the account are in
 * the "Altro" sheet of the tab bar, where there is room for them.
 *
 * Back pops the history when the page before was the parent, so the list
 * comes back where it was scrolled to; otherwise it is a plain link to the
 * parent — which also means the unsaved-changes guard sees it, like any link.
 * An installed app has no browser back button, which is why this exists.
 */
export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const crumbs = buildCrumbs(pathname, useCrumbLabels());
  const href = useServerHref();
  const phone = useIsPhone();
  // A page about another server says so first, so a deep link is never ambiguous.
  const { isSolo, serverParam, selfId, nameOf } = useNode();
  const serverCrumb = !isSolo && serverParam && serverParam !== selfId ? nameOf(serverParam) : null;

  const parent = parentOf(pathname, crumbs);
  const current = crumbs[crumbs.length - 1];
  const title = current && !current.truncate ? current.label : "";
  const showTitle = useHeadingOutOfView(phone, pathname);

  // The paths visited in this tab, to tell whether "back" is the parent.
  const visited = useRef<string[]>([]);
  useEffect(() => {
    const stack = visited.current;
    if (stack[stack.length - 2] === pathname) stack.pop();
    else if (stack[stack.length - 1] !== pathname) stack.push(pathname);
    if (stack.length > 50) stack.splice(0, stack.length - 50);
  }, [pathname]);

  return (
    <header
      data-top-bar=""
      className="border-border bg-background/90 md:bg-background/70 sticky top-0 z-30 border-b pt-[var(--safe-top)] backdrop-blur-xl md:pt-0"
    >
      {/* Behind the status bar of the installed app on iOS: see globals.css. */}
      <div aria-hidden className="status-bar-scrim md:hidden" />
      <div className="flex h-[var(--top-bar-height)] items-center justify-between gap-3 pr-[max(0.5rem,var(--safe-right))] pl-[max(0.25rem,var(--safe-left))] md:h-14 md:px-6">
        {/* The phone's navigation bar. */}
        <div className="touch-chrome flex min-w-0 flex-1 items-center gap-1 md:hidden">
          {/* Up to 55% of the bar: the parent is named in full now ("Nuovo
              progetto", not "Nuovo"), and at 360px 45% cut it to "Nuovo
              proge…" beside a title that needed far less than the rest. */}
          {parent ? (
            <Link
              href={href(parent.href)}
              onClick={(event) => {
                const stack = visited.current;
                if (stack[stack.length - 2] === parent.href) {
                  event.preventDefault();
                  router.back();
                }
              }}
              aria-label={`Torna a ${parent.label}`}
              className="text-accent flex h-11 max-w-[55%] shrink-0 items-center gap-0.5 rounded-[var(--radius)] pr-2 pl-1 text-sm transition-opacity active:opacity-60"
            >
              <Icon icon="solar:alt-arrow-left-linear" width={24} aria-hidden className="shrink-0" />
              <span className="truncate">{parent.label}</span>
            </Link>
          ) : (
            <span aria-hidden className="w-3 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-foreground truncate text-sm font-semibold transition-opacity duration-200",
                showTitle && title ? "opacity-100" : "opacity-0"
              )}
              aria-hidden={!showTitle}
            >
              {title}
            </p>
            {serverCrumb && (
              <p className="text-muted flex items-center gap-1 truncate text-meta">
                <Icon icon="solar:server-2-linear" width={11} aria-hidden />
                {serverCrumb}
              </p>
            )}
          </div>
        </div>

        {/* Crumbs are links, not spans — the old version rendered dead text and
            leaked raw project ids into the trail. */}
        <nav aria-label="Percorso" className="hidden min-w-0 md:block">
          <ol className="flex items-center gap-1.5 text-sm">
            {serverCrumb && (
              <li className="flex min-w-0 items-center gap-1.5">
                <span className="bg-default text-muted inline-flex max-w-[14ch] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-xs">
                  <Icon icon="solar:server-2-linear" width={12} aria-hidden />
                  {serverCrumb}
                </span>
              </li>
            )}
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              return (
                <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && (
                    <span className="text-muted/50" aria-hidden>
                      /
                    </span>
                  )}
                  {!last && !crumb.linked ? (
                    <span className="text-muted max-w-[12ch] truncate">{crumb.label}</span>
                  ) : last ? (
                    <span
                      className="text-foreground max-w-[16ch] truncate font-medium sm:max-w-[28ch]"
                      aria-current="page"
                    >
                      {crumb.label}
                    </span>
                  ) : (
                    <Link
                      href={href(crumb.href)}
                      className="text-muted hover:text-foreground max-w-[12ch] truncate transition-colors"
                    >
                      {crumb.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>

        {/*
          The label is hidden below `sm` and the icon is `aria-hidden`, so without
          this the sitewide logout button had no accessible name at all on a phone
          — on every page. The attribute is what a screen reader reads when the
          text is not rendered.
        */}
        <div className="flex shrink-0 items-center gap-2">
          <SearchButton className="max-sm:size-11 max-sm:border-transparent max-sm:bg-transparent" />
          <ServerSelector className="hidden lg:block" />
          {/* On a phone these two are in the tab bar's "Altro" sheet. */}
          <div className="hidden items-center gap-2 md:flex">
            <NotificationBell />
            <UserMenu />
          </div>
        </div>
      </div>
    </header>
  );
}
