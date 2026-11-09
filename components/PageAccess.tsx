"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { FORBIDDEN_TEXT } from "@/lib/error-text";
import { useAllowedNav } from "@/lib/hooks/useMe";
import { pageAt } from "@/lib/nav";

/**
 * A page the account may not open, reached by its URL.
 *
 * The menu already hides these, but each page still mounted and found out from
 * its API, one way each: an error with a Riprova that could never work, an
 * "Invita utente" the server would refuse, or a title over nothing. The rule
 * is the menu's, read once here, so the page is not even mounted. The routes
 * check again on their own: this is what the reader sees, not what protects.
 */
export function PageAccess({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const allowed = useAllowedNav();
  const page = pageAt(pathname);
  if (!page || allowed(page)) return children;

  return (
    <>
      <PageHeader title={page.label} />
      <Panel>
        <EmptyState
          icon="solar:lock-keyhole-linear"
          title={FORBIDDEN_TEXT}
          description="Se ti serve, chiedi a chi gestisce il pannello di aggiungerla al tuo account."
        />
      </Panel>
    </>
  );
}
