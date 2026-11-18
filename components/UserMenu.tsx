"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button, Dropdown } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useExpertMode, useThemeMode } from "@/components/Providers";
import { useMe } from "@/lib/hooks/useMe";
import { useServerHref } from "@/lib/hooks/useNode";
import { startInstall, useInstall } from "@/lib/pwa/install";
import { cn } from "@/lib/utils";
import type { ThemeMode } from "@/lib/theme-mode";

const THEMES: { id: ThemeMode; label: string; icon: string }[] = [
  { id: "light", label: "Tema chiaro", icon: "solar:sun-2-linear" },
  { id: "dark", label: "Tema scuro", icon: "solar:moon-linear" },
  { id: "system", label: "Tema del sistema", icon: "solar:monitor-linear" },
];

/** Two letters from the address, for the avatar: "mario.rossi@…" → "MR". */
export function initialsOf(email: string | null): string {
  const name = (email ?? "?").split("@")[0];
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

/** Signs out and goes to the login page; shared with the phone's "Altro" sheet. */
export function useLogout(): () => Promise<void> {
  const router = useRouter();
  return useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }, [router]);
}

/**
 * Who is signed in, and the preferences that belong to them.
 *
 * The shell never said who you were: the only control was an "Esci" button.
 * The avatar opens your account, expert mode and the theme, which used to sit
 * two levels down in Impostazioni › Account — and, until it runs as one,
 * installing the panel as an app. On a phone all of this lives in the "Altro"
 * sheet instead (components/MoreSheet.tsx).
 */
export function UserMenu() {
  const me = useMe();
  const router = useRouter();
  const href = useServerHref();
  const logout = useLogout();
  const { expert, setExpert } = useExpertMode();
  const { mode, setMode } = useThemeMode();
  const install = useInstall();

  return (
    <Dropdown>
      <Button variant="ghost" size="sm" aria-label={`Account: ${me.email ?? "senza email"}`} className="h-9 gap-2 px-1.5">
        <span className="bg-surface-tertiary text-foreground border-border grid size-7 place-items-center rounded-full border text-[11px] font-semibold">
          {initialsOf(me.email)}
        </span>
        <Icon icon="solar:alt-arrow-down-linear" width={12} className="text-muted hidden sm:block" aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end" className="min-w-64">
        <div className="border-separator border-b px-3 py-2.5">
          <p className="text-foreground truncate text-sm font-medium">{me.email ?? "Account senza email"}</p>
          <p className="text-muted text-xs">{me.isOwner ? "Proprietario del pannello" : "Membro del team"}</p>
        </div>
        <Dropdown.Menu
          aria-label="Il tuo account"
          onAction={(key) => {
            if (key === "account") router.push(href("/account"));
            else if (key === "expert") setExpert(!expert);
            else if (key === "install") void startInstall();
            else if (key === "logout") void logout();
            else {
              const theme = THEMES.find((t) => t.id === key);
              if (theme) setMode(theme.id);
            }
          }}
        >
          <Dropdown.Item id="account" textValue="Il mio account">
            <Icon icon="solar:user-circle-linear" width={16} aria-hidden />
            <span className="flex-1">Il mio account</span>
          </Dropdown.Item>
          <Dropdown.Item id="expert" textValue="Modalità esperto">
            <Icon icon="solar:code-scan-linear" width={16} aria-hidden />
            <span className="flex-1">Modalità esperto</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-meta font-medium",
                expert ? "bg-accent/15 text-accent" : "bg-default text-muted"
              )}
            >
              {expert ? "Attiva" : "Spenta"}
            </span>
          </Dropdown.Item>
          {THEMES.map((theme) => (
            <Dropdown.Item key={theme.id} id={theme.id} textValue={theme.label}>
              <Icon icon={theme.icon} width={16} aria-hidden />
              <span className="flex-1">{theme.label}</span>
              {mode === theme.id && <Icon icon="solar:check-read-linear" width={15} className="text-accent" aria-label="in uso" />}
            </Dropdown.Item>
          ))}
          {/* Not offered inside the installed app itself. */}
          {install.ready && !install.standalone ? (
            <Dropdown.Item id="install" textValue="Installa l'app">
              <Icon icon="solar:monitor-smartphone-linear" width={16} aria-hidden />
              <span className="flex-1">Installa l&apos;app</span>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="logout" textValue="Esci" className="text-danger">
            <Icon icon="solar:logout-2-linear" width={16} aria-hidden />
            <span className="flex-1">Esci</span>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
