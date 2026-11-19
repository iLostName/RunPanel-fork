"use client";

import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { DatabaseForm } from "./_components/DatabaseForm";
import { useServerHref } from "@/lib/hooks/useNode";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { SUBPAGE_TITLES } from "@/lib/nav";

/** The heading when the database is for a project: it is added to something. */
const FOR_PROJECT = "Aggiungi un database";

/**
 * A new database, on its own or for a project.
 *
 * This page used to be a chooser: Database, App, and Nginx/Apache/Caddy cards.
 * The web server cards wrote a `dockerTemplate` nothing read, and "App" opened
 * a second copy of the project's source settings, which now live in the
 * project's own Impostazioni › Sorgente. A database was the only real choice
 * left, so it is the page. Ready-made apps come back with the app catalogue.
 *
 * `?projectId=` links the database to that project: its connection URL then
 * reaches the app at the next deploy.
 */
export default function NewServicePage() {
  const searchParams = useSearchParams();
  const href = useServerHref();
  const projectId = searchParams.get("projectId") ?? "";
  // The same page under another heading: the phone's bar says what the <h1> says.
  useCrumbLabel("new", projectId ? FOR_PROJECT : null);

  return (
    <>
      <PageHeader
        title={projectId ? FOR_PROJECT : SUBPAGE_TITLES["/services/new"]}
        description="PostgreSQL, MySQL, Redis o MongoDB, con backup e console"
        back={
          projectId
            ? { href: href(`/projects/${projectId}`), label: "Torna al progetto" }
            : { href: href("/services"), label: "Torna ai database" }
        }
      />
      <DatabaseForm projectId={projectId || undefined} />
    </>
  );
}
