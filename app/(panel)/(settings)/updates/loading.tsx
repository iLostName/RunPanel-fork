"use client";

import { PageSkeleton } from "@/components/ui/Skeletons";
import { useNode } from "@/lib/hooks/useNode";

/**
 * The page and the overview of every server draw this too while their first
 * answer is on its way, so the two hand over without a jump.
 */
export default function UpdatesLoading() {
  const { isSolo, serverParam } = useNode();
  return isSolo || serverParam ? (
    <PageSkeleton title="Aggiornamenti" description="La versione di RunPanel installata su questa macchina" tiles={0} />
  ) : (
    <PageSkeleton title="Aggiornamenti" tiles={0} />
  );
}
