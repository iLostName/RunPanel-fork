"use client";

import { useEffect, useRef, useState } from "react";

/**
 * One live connection per tab for the notification centre, however many parts
 * of the page want to hear from it.
 *
 * The bell is on every page, so its stream is open all the time — and a panel
 * reached at `http://ip:3000` speaks HTTP/1.1, where a browser allows six
 * connections per origin across *all* its tabs. A project page already holds
 * one for its logs. A second per tab for the bell, and a third when the
 * Notifiche page is open, would make the seventh request of the session hang
 * with no error at all. So the bell and the page share one `EventSource`, and
 * a tab in the background gives it up and catches up when it comes back.
 *
 * The stream carries only "something changed"; each listener re-reads its own
 * list. Several pings in a row — twenty services stopping at once — are one
 * re-read.
 */

type Listener = () => void;

interface Entry {
  listeners: Set<Listener>;
  statuses: Set<(connected: boolean) => void>;
  source: EventSource | null;
  connected: boolean;
  /** The first `ready` after the page opened says nothing the first fetch did not. */
  greeted: boolean;
}

const entries = new Map<string, Entry>();
let watchingVisibility = false;

function setConnected(entry: Entry, connected: boolean) {
  if (entry.connected === connected) return;
  entry.connected = connected;
  for (const status of entry.statuses) status(connected);
}

function open(url: string, entry: Entry) {
  if (entry.source || document.visibilityState === "hidden") return;
  const source = new EventSource(url);
  source.onopen = () => setConnected(entry, true);
  source.onerror = () => setConnected(entry, false);
  source.onmessage = (message: MessageEvent<string>) => {
    let type = "";
    try {
      type = (JSON.parse(message.data) as { type?: string }).type ?? "";
    } catch {
      /* a malformed frame is still a sign that something changed */
    }
    if (type === "ready" && !entry.greeted) {
      entry.greeted = true;
      return;
    }
    for (const listener of entry.listeners) listener();
  };
  entry.source = source;
}

function close(entry: Entry) {
  entry.source?.close();
  entry.source = null;
  setConnected(entry, false);
}

function onVisibility() {
  for (const [url, entry] of entries) {
    if (document.visibilityState === "hidden") {
      close(entry);
    } else {
      open(url, entry);
      // Whatever happened while the tab was hidden was not heard.
      for (const listener of entry.listeners) listener();
    }
  }
}

function subscribe(url: string, listener: Listener, status: (connected: boolean) => void): () => void {
  let entry = entries.get(url);
  if (!entry) {
    entry = { listeners: new Set(), statuses: new Set(), source: null, connected: false, greeted: false };
    entries.set(url, entry);
  }
  entry.listeners.add(listener);
  entry.statuses.add(status);
  // A second subscriber joins a connection that is already open: tell it so,
  // after the effect that subscribed it has finished.
  if (entry.connected) queueMicrotask(() => status(true));
  open(url, entry);
  if (!watchingVisibility) {
    document.addEventListener("visibilitychange", onVisibility);
    watchingVisibility = true;
  }

  const mine = entry;
  return () => {
    mine.listeners.delete(listener);
    mine.statuses.delete(status);
    if (mine.listeners.size === 0) {
      close(mine);
      entries.delete(url);
    }
  };
}

/**
 * Call `onChange` whenever the notification centre at `url` may have changed.
 *
 * `connected` is for a fallback: while it is false the caller polls, slowly,
 * so a proxy that buffers the stream costs freshness and not correctness.
 */
export function useNotificationPulse(url: string | null, onChange: () => void): { connected: boolean } {
  const [connected, setConnectedState] = useState(false);
  const handler = useRef(onChange);

  useEffect(() => {
    handler.current = onChange;
  });

  useEffect(() => {
    if (!url) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pulse = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        handler.current();
      }, 400);
    };
    const unsubscribe = subscribe(url, pulse, setConnectedState);
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [url]);

  return { connected };
}
