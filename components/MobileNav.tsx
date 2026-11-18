"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, isActiveNav } from "@/lib/nav";
import { useAllowedNav } from "@/lib/hooks/useMe";
import { useServerHref } from "@/lib/hooks/useNode";
import { useShellInbox } from "@/components/notifications/InboxProvider";
import { MoreSheet } from "./MoreSheet";

/**
 * Navigation for a phone, the way an app does it: a tab bar along the bottom
 * edge, under the thumb, and "Altro" for the rest.
 *
 * Four destinations and "Altro". The four are the first of these the account
 * may open, in the order they are used day to day: the overview, projects,
 * databases, backups — then health and domains for an account without some
 * of them, so the bar is never half empty. Everything else, together with the
 * server selector, notifications and the account, is in the "Altro" sheet
 * (components/MoreSheet.tsx), which replaced a drawer that slid in from the
 * right edge with the navigation only.
 *
 * Permissions are the sidebar's (`useAllowedNav`), on the sidebar's own list,
 * so the bar cannot offer a page the rail would hide.
 *
 * "Altro" is lit on any page that is not one of the four, so the bar always
 * says where you are; it carries a dot while there are unread notifications.
 */

const CANDIDATES = ["/home", "/projects", "/services", "/backups", "/health", "/domains", "/team"];
const TABS = 4;

/** The tab bar's own items: a tap target the full height of the bar and a quarter-to-a-fifth of its width. */
const TAB =
  "touch-chrome group flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[var(--radius)] text-meta font-medium transition-colors focus-visible:-outline-offset-2";

function TabIcon({ icon, active }: { icon: string; active: boolean }) {
  return (
    // The pill is the active marker and the press feedback at once: it fills
    // under the selected icon, and shrinks a touch under any finger.
    <span
      className={cn(
        "relative grid h-7 w-14 place-items-center rounded-full transition-[transform,background-color] duration-150 ease-out group-active:scale-90",
        active ? "selected-quiet" : "group-active:bg-default"
      )}
    >
      <Icon icon={icon} width={22} aria-hidden className={cn(active && "text-accent")} />
    </span>
  );
}

export function MobileNav({ version }: { version: string }) {
  const pathname = usePathname();
  const serverHref = useServerHref();
  const allowed = useAllowedNav();
  const [open, setOpen] = useState(false);
  const unread = useShellInbox().data?.unread ?? 0;

  // Closed when the page changes, whatever changed it: a row tapped in the
  // sheet closes it itself, but a navigation held by the unsaved-changes
  // guard and then confirmed arrives without that click.
  const [seen, setSeen] = useState(pathname);
  if (seen !== pathname) {
    setSeen(pathname);
    if (open) setOpen(false);
  }

  const items = NAV_ITEMS.filter(allowed);
  const tabs = CANDIDATES.map((href) => items.find((item) => item.href === href))
    .filter((item): item is (typeof items)[number] => Boolean(item))
    .slice(0, TABS);
  const rest = items.filter((item) => !tabs.includes(item));
  const elsewhere = !tabs.some((item) => isActiveNav(pathname, item));

  return (
    <>
      <nav
        aria-label="Navigazione principale"
        className="border-border bg-surface/90 fixed inset-x-0 bottom-0 z-30 border-t pr-[var(--safe-right)] pb-[var(--safe-bottom)] pl-[var(--safe-left)] backdrop-blur-xl md:hidden"
      >
        <ul className="flex h-[var(--tab-bar-height)] items-stretch">
          {tabs.map((item) => {
            const active = isActiveNav(pathname, item);
            return (
              <li key={item.href} className="flex min-w-0 flex-1">
                <Link
                  href={serverHref(item.href)}
                  aria-current={active ? "page" : undefined}
                  className={cn(TAB, active ? "text-foreground" : "text-muted")}
                >
                  <TabIcon icon={active ? item.iconActive : item.icon} active={active} />
                  <span className="max-w-full truncate px-1">{item.label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-label={unread > 0 ? `Altro, ${unread} notifiche da leggere` : "Altro"}
              className={cn(TAB, elsewhere || open ? "text-foreground" : "text-muted")}
            >
              <span className="relative">
                <TabIcon icon={elsewhere ? "solar:menu-dots-circle-bold-duotone" : "solar:menu-dots-circle-linear"} active={elsewhere} />
                {unread > 0 && (
                  <span aria-hidden className="bg-danger ring-surface absolute top-0.5 right-3 size-2.5 rounded-full ring-2" />
                )}
              </span>
              <span className="max-w-full truncate px-1">Altro</span>
            </button>
          </li>
        </ul>
      </nav>

      <MoreSheet isOpen={open} onOpenChange={setOpen} items={rest} version={version} />
    </>
  );
}
