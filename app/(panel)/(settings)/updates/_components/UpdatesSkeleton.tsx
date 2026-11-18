"use client";

import { PageSkeleton } from "@/components/ui/Skeletons";
import { useNode } from "@/lib/hooks/useNode";

/** The page, and the overview of every server, before their first answer. */
export function UpdatesSkeleton() {
  const { isSolo, serverParam } = useNode();
  return isSolo || serverParam ? (
    <PageSkeleton title="Aggiornamenti" description="La versione di RunPanel installata su questa macchina" tiles={0} />
  ) : (
    <PageSkeleton title="Aggiornamenti" tiles={0} />
  );
}
