"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { CRUMBS_WITHOUT_PAGE, NAV_SECTIONS, SEGMENT_LABELS, isActiveNav } from "@/lib/nav";
import { SearchButton } from "@/components/SearchButton";
import { UserMenu } from "@/components/UserMenu";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { useCrumbLabels } from "@/lib/hooks/useCrumbLabel";
import { ServerSelector } from "@/components/ServerSelector";
import { useNode, useServerHref } from "@/lib/hooks/useNode";

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
    // A page-provided name (a project's, a service's) wins over the raw id.
    const known = named.get(segment) ?? SEGMENT_LABELS[segment];
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

export function TopBar() {
  const pathname = usePathname();
  const crumbs = buildCrumbs(pathname, useCrumbLabels());
  const href = useServerHref();
  // A page about another server says so first, so a deep link is never ambiguous.
  const { isSolo, serverParam, selfId, nameOf } = useNode();
  const serverCrumb = !isSolo && serverParam && serverParam !== selfId ? nameOf(serverParam) : null;

  // The padding is on the RIGHT below `md`: that is where the menu button moved,
  // so the breadcrumb would otherwise run underneath it. It used to be on the
  // left, for a hamburger that sat in the corner furthest from a thumb.
  return (
    <header className="border-border bg-background/70 sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b pr-14 pl-3 backdrop-blur-xl md:px-6">
      {/* Crumbs are links, not spans — the old version rendered dead text and
          leaked raw project ids into the trail. */}
      <nav aria-label="Percorso" className="min-w-0">
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
        <SearchButton />
        <ServerSelector className="hidden lg:block" />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
