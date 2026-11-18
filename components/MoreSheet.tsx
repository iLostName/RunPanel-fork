"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Drawer } from "@heroui/react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, isActiveNav, type NavGroupId, type NavItem } from "@/lib/nav";
import { useExpertMode } from "@/components/Providers";
import { useMe } from "@/lib/hooks/useMe";
import { useNode, useServerHref } from "@/lib/hooks/useNode";
import { usePanelUpdate } from "@/lib/hooks/usePanelUpdate";
import { hasUpdate } from "@/lib/panel-update";
import { startInstall, useInstall } from "@/lib/pwa/install";
import { useShellInbox } from "@/components/notifications/InboxProvider";
import { ServerSelector } from "@/components/ServerSelector";
import { ThemeModePicker } from "@/components/ui/ThemeModePicker";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { initialsOf, useLogout } from "@/components/UserMenu";

/** The groups of the rail, then the footer (Impostazioni), each with its heading. */
const GROUPS: { id: NavGroupId; label: string }[] = [
  ...NAV_GROUPS.map((group) => ({ id: group.id, label: group.label ?? "" })),
  { id: "footer", label: "" },
];

/** A titled block of rows, the way a phone's settings are laid out. */
function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section>
      {label && <p className="text-muted text-meta mb-1.5 px-1 tracking-wider uppercase">{label}</p>}
      <div className="bg-surface-secondary divide-separator divide-y overflow-hidden rounded-[var(--radius)]">{children}</div>
    </section>
  );
}

const ROW =
  "touch-chrome flex min-h-12 w-full items-center gap-3 px-4 text-left text-sm transition-colors active:bg-default focus-visible:-outline-offset-2";

function RowLink({
  href,
  icon,
  label,
  active = false,
  trailing,
  onNavigate,
}: {
  href: string;
  icon: string;
  label: string;
  active?: boolean;
  trailing?: React.ReactNode;
  onNavigate: () => void;
}) {
  return (
    <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cn(ROW, "text-foreground")}>
      <Icon icon={icon} width={20} aria-hidden className={cn("shrink-0", active ? "text-accent" : "text-muted")} />
      <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{label}</span>
      {trailing}
      <Icon icon="solar:alt-arrow-right-linear" width={16} aria-hidden className="text-muted/60 shrink-0" />
    </Link>
  );
}

/**
 * "Altro": everything the tab bar has no room for, in one sheet.
 *
 * On a desktop these live in four places — the rest of the rail, the server
 * selector and the bell in the top bar, the account menu under the avatar. A
 * phone has room for none of them, and the old drawer from the right carried
 * only the navigation; the bell and the account had been squeezed into a top
 * bar too narrow for them. Here they are rows, each a thumb's height, in the
 * order they are reached for: where you are (server), what happened
 * (notifications), where else to go, then you (theme, account, sign out).
 *
 * The navigation rows are the sidebar's own entries, filtered by the same
 * permissions (`useAllowedNav`) and grouped under the same headings.
 */
export function MoreSheet({
  isOpen,
  onOpenChange,
  items,
  version,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** The entries not already in the tab bar, already filtered for the account. */
  items: NavItem[];
  version: string;
}) {
  const pathname = usePathname();
  const href = useServerHref();
  const me = useMe();
  const { isSolo } = useNode();
  const { expert, setExpert } = useExpertMode();
  const install = useInstall();
  const logout = useLogout();
  const unread = useShellInbox().data?.unread ?? 0;
  const updateReady = hasUpdate(usePanelUpdate().status);
  const close = () => onOpenChange(false);

  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={onOpenChange}>
      <Drawer.Content placement="bottom">
        <Drawer.Dialog aria-label="Altro" className="max-h-[88dvh]">
          <Drawer.Handle />
          <Drawer.Header className="pb-2">
            <div className="flex items-center gap-3">
              <span className="bg-surface-tertiary text-foreground border-border grid size-10 shrink-0 place-items-center rounded-full border text-xs font-semibold">
                {initialsOf(me.email)}
              </span>
              <div className="min-w-0">
                <Drawer.Heading className="truncate text-sm">{me.email ?? "Account senza email"}</Drawer.Heading>
                <p className="text-muted text-xs">{me.isOwner ? "Proprietario del pannello" : "Membro del team"}</p>
              </div>
            </div>
          </Drawer.Header>

          <Drawer.Body className="space-y-5 pb-1">
            {/* Renders nothing in solo mode. */}
            {!isSolo && (
              <section>
                <p className="text-muted text-meta mb-1.5 px-1 tracking-wider uppercase">Server</p>
                <ServerSelector className="w-full sm:w-full" />
              </section>
            )}

            <Group>
              <RowLink
                href={href("/notifications")}
                icon={unread > 0 ? "solar:bell-bing-linear" : "solar:bell-linear"}
                label="Notifiche"
                active={pathname.startsWith("/notifications")}
                onNavigate={close}
                trailing={
                  unread > 0 ? (
                    <span className="bg-danger text-danger-foreground grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-meta font-semibold">
                      {unread > 99 ? "99+" : unread}
                      <span className="sr-only"> da leggere</span>
                    </span>
                  ) : null
                }
              />
            </Group>

            {GROUPS.map((group) => {
              const rows = items.filter((item) => item.group === group.id);
              if (rows.length === 0) return null;
              return (
                <Group key={group.id} label={group.label || undefined}>
                  {rows.map((item) => {
                    const active = isActiveNav(pathname, item);
                    return (
                      <RowLink
                        key={item.href}
                        href={href(item.href)}
                        icon={active ? item.iconActive : item.icon}
                        label={item.label}
                        active={active}
                        onNavigate={close}
                      />
                    );
                  })}
                </Group>
              );
            })}

            <Group label="Preferenze">
              <div className="space-y-2 px-4 py-3">
                <p className="text-foreground text-sm">Tema</p>
                <ThemeModePicker />
              </div>
              <div className="px-4 py-3">
                <SettingToggle
                  label="Modalità esperto"
                  description="Dettagli tecnici e sezioni avanzate già aperte."
                  isSelected={expert}
                  onChange={setExpert}
                />
              </div>
            </Group>

            <Group>
              <RowLink href={href("/account")} icon="solar:user-circle-linear" label="Il mio account" onNavigate={close} />
              {install.ready && !install.standalone && (
                <button
                  type="button"
                  className={cn(ROW, "text-foreground")}
                  onClick={() => {
                    close();
                    void startInstall();
                  }}
                >
                  <Icon icon="solar:monitor-smartphone-linear" width={20} aria-hidden className="text-muted shrink-0" />
                  <span className="min-w-0 flex-1 truncate">Installa l&apos;app</span>
                </button>
              )}
              <button type="button" className={cn(ROW, "text-danger")} onClick={() => void logout()}>
                <Icon icon="solar:logout-2-linear" width={20} aria-hidden className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">Esci</span>
              </button>
            </Group>

            <p className="text-muted/70 text-meta flex items-center justify-center gap-1.5 pt-1 font-mono">
              {version}
              {updateReady && (
                <>
                  <span className="bg-accent size-1.5 rounded-full" aria-hidden />
                  <span className="sr-only">Aggiornamento disponibile</span>
                </>
              )}
            </p>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
