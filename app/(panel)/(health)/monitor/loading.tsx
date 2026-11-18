"use client";

import { PageSkeleton } from "@/components/ui/Skeletons";
import { useNode } from "@/lib/hooks/useNode";
import { monitorDescription } from "./_components/copy";

/** The page draws this too while its first answer is on its way, so the two hand over without a jump. */
export default function MonitorLoading() {
  const { isSolo } = useNode();
  return <PageSkeleton title="Monitor" description={monitorDescription(isSolo)} tiles={0} />;
}
