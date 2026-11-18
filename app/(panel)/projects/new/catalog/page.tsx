"use client";

import { useMemo, useState } from "react";
import { Input } from "@heroui/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { ServerPicker } from "@/components/cluster/ServerBits";
import { useCan } from "@/lib/hooks/useMe";
import { useServerHref } from "@/lib/hooks/useNode";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { CATALOG, CATEGORY_LABEL, catalogCategories, filterCatalog, type CatalogCategory } from "@/lib/app-catalog";
import { AppCard } from "./_components/AppCard";
import { CatalogLocked } from "./_components/CatalogLocked";

/**
 * The catalogue: apps that install with their own questions only.
 *
 * Bundled rather than fetched — the templates are code that ships with the
 * panel — so the page is there at once and searching costs nothing. Picking one
 * opens its install page; nothing is created until that page's button.
 */
export default function CatalogPage() {
  useCrumbLabel("catalog", "Catalogo");
  const href = useServerHref();
  const canCreate = useCan("projects.create");
  const canHost = useCan("host");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatalogCategory | null>(null);
  const shown = useMemo(() => filterCatalog(CATALOG, { query, category }), [query, category]);

  return (
    <>
      <PageHeader
        title="App pronte"
        description="Scegli un'app: la configuro, la metto online e ti dico cosa fare dopo"
        back={{ href: href("/projects/new"), label: "Nuovo progetto" }}
      />

      {!canCreate || !canHost ? (
        <CatalogLocked missing={canCreate ? "host" : "projects.create"} />
      ) : (
        <div className="space-y-4">
          <ServerPicker className="max-w-sm" description="L'app vivrà su questo server: container, dati e porte stanno lì." />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cerca: blog, statistiche, password…"
              aria-label="Cerca un'app"
              className="sm:max-w-xs"
            />
            <ChoiceGroup label="Categoria" className="flex flex-wrap">
              <ChoiceCard compact selected={category === null} onSelect={() => setCategory(null)} title="Tutte" />
              {catalogCategories().map((id) => (
                <ChoiceCard key={id} compact selected={category === id} onSelect={() => setCategory(id)} title={CATEGORY_LABEL[id]} />
              ))}
            </ChoiceGroup>
          </div>

          {shown.length === 0 ? (
            <EmptyState
              icon="solar:magnifier-linear"
              title="Nessuna app trovata"
              description="Prova con un'altra parola, o togli il filtro della categoria."
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="App">
              {shown.map((template) => (
                <li key={template.id}>
                  <AppCard template={template} href={href(`/projects/new/catalog/${template.id}`)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
