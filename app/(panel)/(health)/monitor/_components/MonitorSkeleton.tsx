"use client";

import { PageSkeleton } from "@/components/ui/Skeletons";
import { useNode } from "@/lib/hooks/useNode";
import { monitorDescription } from "./copy";

/** The page before its first answer: the real header, then the placeholders. */
export function MonitorSkeleton() {
  const { isSolo } = useNode();
  return <PageSkeleton title="Monitor" description={monitorDescription(isSolo)} tiles={0} />;
}
