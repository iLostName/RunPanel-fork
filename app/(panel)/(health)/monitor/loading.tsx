"use client";

import { PageSkeleton } from "@/components/ui/Skeletons";
import { useNode } from "@/lib/hooks/useNode";

/** The page draws this too while its first answer is on its way, so the two hand over without a jump. */
export default function MonitorLoading() {
  const { isSolo } = useNode();
  const description = isSolo ? "Processi e servizi in esecuzione su questo host" : "Processi e servizi in esecuzione su ogni server";
  return <PageSkeleton title="Monitor" description={description} tiles={0} />;
}
