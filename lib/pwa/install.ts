import { useSyncExternalStore } from "react";

/**
 * Whether the panel can be installed from here, and how.
 *
 * Three different answers, by platform:
 *
 * - **Chromium** (Android, desktop Chrome and Edge) fires `beforeinstallprompt`
 *   once it judges the page installable. The event is kept here so "Installa
 *   l'app" can show the browser's own dialog; `preventDefault` stops Android's
 *   mini-infobar, since the panel offers its own hint.
 * - **iOS** has no such event at all: installing is Condividi › "Aggiungi alla
 *   schermata Home", which the panel can only explain.
 * - **Plain HTTP**: no browser installs an app from an address without the
 *   padlock, and a service worker cannot even register. The panel says so,
 *   and where to fix it.
 *
 * Module-level on purpose: the event can fire before any component that would
 * listen to it has mounted, and it is not fired a second time.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallState {
  /** False on the server and during hydration: nothing below is known yet. */
  ready: boolean;
  /** Already running as an installed app. */
  standalone: boolean;
  ios: boolean;
  /** HTTPS, or localhost. */
  secure: boolean;
  /** The browser handed over its install dialog. */
  canPrompt: boolean;
  /** Installed during this visit. */
  installed: boolean;
  /** The explanation dialog (components/pwa/InstallDialog.tsx) is open. */
  helpOpen: boolean;
}

const SERVER: InstallState = {
  ready: false,
  standalone: false,
  ios: false,
  secure: false,
  canPrompt: false,
  installed: false,
  helpOpen: false,
};

/** iPhone and iPod, and the iPad, which since iPadOS 13 introduces itself as a Mac with a touch screen. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** Opened from the home screen, on any platform: Android and desktop through the manifest, iOS through its own flag. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: minimal-ui)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = SERVER;
const listeners = new Set<() => void>();

function set(patch: Partial<InstallState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  state = {
    ready: true,
    standalone: isStandalone(),
    ios: isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    secure: window.isSecureContext,
    canPrompt: false,
    installed: false,
    helpOpen: false,
  };
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    set({ canPrompt: false, installed: true, helpOpen: false });
  });
  window.matchMedia("(display-mode: standalone)").addEventListener("change", () => set({ standalone: isStandalone() }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInstall(): InstallState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER
  );
}

/**
 * "Installa l'app": the browser's own dialog where there is one, the panel's
 * explanation everywhere else. Resolves with what happened, so a hint can step
 * aside either way.
 */
export async function startInstall(): Promise<"accepted" | "dismissed" | "help"> {
  const event = deferred;
  if (!event) {
    set({ helpOpen: true });
    return "help";
  }
  // A prompt can be shown once; Chromium fires a fresh event if it may be asked again.
  deferred = null;
  set({ canPrompt: false });
  await event.prompt();
  return (await event.userChoice).outcome;
}

export function closeInstallHelp() {
  set({ helpOpen: false });
}
