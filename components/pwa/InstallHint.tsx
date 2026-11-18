"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Image from "next/image";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useIsPhone } from "@/lib/hooks/useMediaQuery";
import { startInstall, useInstall } from "@/lib/pwa/install";
import logo from "@/components/logo.svg";

const DISMISSED_KEY = "runpanel:install-hint";
/** After the overview has settled, so the card is not the first thing that moves. */
const SHOW_AFTER_MS = 2500;

function readDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // Storage blocked: without a way to remember "no", do not ask at all.
    return true;
  }
}

/**
 * "Installa RunPanel", once, on a phone.
 *
 * A card above the tab bar on the overview — the page with no form on it, so it
 * can never sit on top of a save bar — shown only where installing can actually
 * happen: a browser that offered its install dialog, or iOS, where the steps
 * are explained. Not on plain HTTP, where it cannot (the menu entry explains
 * why), and not inside the installed app.
 *
 * Either button retires it for good in this browser: one suggestion, not a
 * nag. The same entry stays in the "Altro" sheet for later.
 */
export function InstallHint() {
  const install = useInstall();
  const phone = useIsPhone();
  const onOverview = usePathname() === "/home";
  // Read once, in the initialiser: nothing renders before `install.ready`,
  // which is false during hydration, so there is no mismatch to fear.
  const [dismissed, setDismissed] = useState(readDismissed);
  const [due, setDue] = useState(false);

  const eligible =
    install.ready &&
    phone &&
    onOverview &&
    !dismissed &&
    !install.standalone &&
    !install.installed &&
    install.secure &&
    (install.canPrompt || install.ios);

  useEffect(() => {
    if (!eligible) return;
    const timer = setTimeout(() => setDue(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [eligible]);

  if (!eligible || !due) return null;

  function retire() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      /* it simply comes back next time */
    }
  }

  return (
    <div
      role="region"
      aria-label="Installa l'app"
      className="animate-in fade-in slide-in-from-bottom-4 fixed inset-x-3 bottom-[calc(var(--tab-bar-height)+var(--safe-bottom)+0.75rem)] z-30 duration-300 md:hidden"
    >
      <div className="border-border bg-overlay shadow-overlay flex items-center gap-3 rounded-[var(--radius)] border p-3">
        <Image src={logo} alt="" aria-hidden width={40} height={40} className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-medium">Installa RunPanel</p>
          <p className="text-muted text-xs">Si apre dalla sua icona, a tutto schermo, come un&apos;app.</p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onPress={() => {
            retire();
            void startInstall();
          }}
        >
          Installa
        </Button>
        <Button size="sm" variant="ghost" isIconOnly aria-label="Non ora" className="text-muted -mr-1" onPress={retire}>
          <Icon icon="solar:close-circle-linear" width={18} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
