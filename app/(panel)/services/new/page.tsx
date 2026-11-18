"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Code, Hint } from "@/components/ui/Hint";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { AppForm } from "@/components/AppForm";
import { DatabaseForm } from "./_components/DatabaseForm";
import { useServerHref } from "@/lib/hooks/useNode";

type Choice = { kind: "app" } | { kind: "database" };

/**
 * Picks what to add, then hands off to the matching form.
 *
 * `projectId` is optional. Without one this page used to stop at "Nessun
 * progetto selezionato", which made the "Nuovo servizio" button on /services —
 * the only one reachable from the sidebar — a dead end, and left standalone
 * services impossible to create even though the schema and the API had always
 * accepted them.
 *
 * App is a different matter: it PATCHes the project's own app configuration
 * rather than creating a service, so it genuinely needs one.
 *
 * The Nginx, Apache and Caddy cards are gone: they wrote a `dockerTemplate` into
 * the project's configuration that nothing ever read, so choosing one changed
 * nothing. Ready-made apps come back with the app catalogue.
 */
export default function NewServicePage() {
  const searchParams = useSearchParams();
  const href = useServerHref();
  const projectId = searchParams.get("projectId") ?? "";
  const [choice, setChoice] = useState<Choice | null>(null);

  // From the Database list there is only one thing to make: the form itself,
  // not a choice screen where every other card sent you to Projects.
  if (!projectId) {
    return (
      <>
        <PageHeader
          title="Nuovo database"
          description="PostgreSQL, MySQL, Redis o MongoDB, con backup e console"
          back={{ href: href("/services"), label: "Torna ai database" }}
        />
        <DatabaseForm />
      </>
    );
  }

  if (choice) {
    const title = choice.kind === "app" ? "Aggiungi un'app" : "Aggiungi un database";

    return (
      <>
        <PageHeader
          title={title}
          actions={
            <Button variant="ghost" size="sm" onPress={() => setChoice(null)}>
              <Icon icon="solar:arrow-left-linear" width={16} aria-hidden />
              Cambia
            </Button>
          }
        />

        {choice.kind === "app" && projectId && <AppForm projectId={projectId} />}
        {choice.kind === "database" && <DatabaseForm projectId={projectId || undefined} />}
      </>
    );
  }

  const cards = [
    {
      key: "database",
      title: "Database",
      description: "PostgreSQL, MySQL, Redis o MongoDB",
      icon: "solar:database-linear",
      onSelect: () => setChoice({ kind: "database" }),
    },
    {
      key: "app",
      title: "App",
      description: "Il tuo codice, da GitHub o da uno ZIP",
      icon: "solar:code-linear",
      onSelect: () => setChoice({ kind: "app" }),
    },
  ];

  return (
    <>
      <PageHeader
        title="Aggiungi al progetto"
        description="Scegli cosa aggiungere"
      />

      <Hint tone="tip" icon="solar:link-circle-linear" className="mb-4">
        Un progetto tiene insieme l&apos;app e ciò che le serve. Un database aggiunto qui arriva
        all&apos;app come <Code>DATABASE_URL</Code> al prossimo deploy, senza credenziali da copiare.
      </Hint>

      <ChoiceGroup label="Cosa aggiungere" className="gap-3 sm:grid-cols-2">
        {cards.map((card) => (
          <ChoiceCard
            key={card.key}
            selected={false}
            onSelect={card.onSelect}
            title={card.title}
            description={card.description}
            icon={card.icon}
          />
        ))}
      </ChoiceGroup>
    </>
  );
}
