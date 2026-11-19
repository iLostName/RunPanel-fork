"use client";

import { useEffect } from "react";
import { useShellInbox } from "@/components/notifications/InboxProvider";
import { useNode } from "@/lib/hooks/useNode";
import { setAppBadge, syncThisDevice } from "@/lib/pwa/push";

/** Long enough for the page to have settled: the check is for later, not for the first paint. */
const SYNC_DELAY_MS = 3_000;

/**
 * Notifications on this device, while the panel is open: the badge on the
 * app's icon, and the subscription kept in step with the account.
 *
 * **The badge** is the bell's unread count, set whenever it changes and
 * cleared when everything is read, so the icon on the home screen or in the
 * dock agrees with the bell. The service worker sets the same number when a
 * push arrives with the panel closed. Only for this panel's own centre: with
 * a linked server selected, the bell is counting that server's notifications,
 * and the icon keeps saying what this panel has, which is what its pushes
 * carry.
 *
 * **The subscription** is checked once per visit (`syncThisDevice`): let go
 * when the account no longer lists this device, renewed when the panel's keys
 * changed since it subscribed.
 *
 * Mounted once in the panel layout, inside the inbox it reads.
 */
export function PushRuntime() {
  const { data } = useShellInbox();
  const { isRemote } = useNode();
  const unread = data?.unread;

  useEffect(() => {
    if (isRemote || unread === undefined) return;
    setAppBadge(unread);
  }, [unread, isRemote]);

  useEffect(() => {
    const timer = setTimeout(() => void syncThisDevice(), SYNC_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return null;
}
