"use client";

import { createContext, useContext } from "react";
import { useInbox } from "./useInbox";

type Inbox = ReturnType<typeof useInbox>;

const InboxContext = createContext<Inbox | null>(null);

/**
 * The shell's view of the inbox — the latest eight and the unread count —
 * fetched once for every part of the shell that shows it.
 *
 * Two parts do now: the bell in the desktop top bar, and on a phone the badge
 * on "Altro" and the row in its sheet. Each calling `useInbox` would be the
 * same request twice on every change, for one number. The Notifiche page keeps
 * its own, with its own filters.
 */
export function InboxProvider({ children }: { children: React.ReactNode }) {
  const inbox = useInbox({ limit: 8 });
  return <InboxContext.Provider value={inbox}>{children}</InboxContext.Provider>;
}

export function useShellInbox(): Inbox {
  const inbox = useContext(InboxContext);
  if (!inbox) throw new Error("useShellInbox() needs an <InboxProvider> above it");
  return inbox;
}
