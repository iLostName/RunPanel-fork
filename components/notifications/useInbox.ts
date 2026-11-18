"use client";

import { useCallback, useEffect, useRef } from "react";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { useNotificationPulse } from "./live";

export interface InboxItem {
  id: string;
  event: string;
  level: "ok" | "warn" | "danger" | "info";
  title: string;
  /** The catalogue's HTML dialect: render with `NotifyBody`, never as HTML. */
  body: string;
  href: string | null;
  createdAt: string;
  lastAt: string;
  repeats: number;
  read: boolean;
}

export interface InboxPage {
  items: InboxItem[];
  unread: number;
  nextBefore: string | null;
}

export interface InboxFilter {
  limit: number;
  unreadOnly?: boolean;
  level?: string | null;
  group?: string | null;
  before?: string | null;
}

export function inboxQuery(filter: InboxFilter): string {
  const query = new URLSearchParams({ limit: String(filter.limit) });
  if (filter.unreadOnly) query.set("unread", "1");
  if (filter.level) query.set("level", filter.level);
  if (filter.group) query.set("group", filter.group);
  if (filter.before) query.set("before", filter.before);
  return `/api/notifications?${query.toString()}`;
}

/**
 * The signed-in user's notifications on the server the page is about, kept
 * current by the shared live stream — or, while the stream is down, by a slow
 * poll, so a proxy that buffers SSE costs freshness and not correctness.
 */
export function useInbox(filter: InboxFilter) {
  const api = useNodeApi();
  const refreshRef = useRef<() => void>(() => {});
  const { connected } = useNotificationPulse(api("/api/notifications/stream"), () => refreshRef.current());
  const resource = useResource<InboxPage>(api(inboxQuery(filter)), { intervalMs: connected ? 0 : 60_000 });
  const { refresh } = resource;

  useEffect(() => {
    refreshRef.current = () => void refresh();
  });

  const post = useCallback(
    async (body: { ids: string[] } | { all: true }) => {
      const res = await fetch(api("/api/notifications/read"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    },
    [api, refresh]
  );

  const markRead = useCallback((ids: string[]) => (ids.length ? post({ ids }) : Promise.resolve()), [post]);
  const markAll = useCallback(() => post({ all: true }), [post]);

  return { ...resource, connected, markRead, markAll };
}
