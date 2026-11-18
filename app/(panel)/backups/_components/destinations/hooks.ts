"use client";

import { useEffect } from "react";
import { useResource } from "@/lib/hooks/useResource";
import type { DestinationTools, KindState } from "./types";

/**
 * Tells the form what the fields would send, whenever it changes.
 *
 * Compared as text, so a re-render that produces the same config is not a
 * change: the form re-renders on every report, and an object compared by
 * identity would report forever.
 */
export function useReport(state: KindState, onChange: (state: KindState) => void): void {
  const serialized = JSON.stringify(state);
  useEffect(() => {
    onChange(JSON.parse(serialized) as KindState);
  }, [serialized, onChange]);
}

/** Whether the server has `ssh` and `rclone`, asked once per form. */
export function useDestinationTools(api: (path: string) => string): DestinationTools | null {
  return useResource<DestinationTools>(api("/api/backups/destinations/tools")).data;
}
