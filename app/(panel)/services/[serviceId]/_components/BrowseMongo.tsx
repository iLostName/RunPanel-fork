"use client";

import { useMemo, useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FieldHint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { checkMongoFilter } from "@/lib/db-browser/mongo-wire";
import type { MongoCollection, MongoDocument, MongoDocumentFull, MongoDocumentPage } from "@/lib/db-browser/types";
import {
  BrowseFailureView,
  BrowsePager,
  Elapsed,
  ValueDialog,
  formatCount,
  useBrowseFetch,
  type BrowseCall,
  type BrowseFailure,
} from "./BrowseKit";

/**
 * MongoDB: the collections of one database and its documents, a page at a
 * time, narrowed by a filter written as JSON. A find and nothing else — no
 * aggregation, so nothing in a pipeline can write.
 */

const PAGE_SIZE = 50;

const SORTS = [
  { value: "natural" as const, label: "Come sono salvati" },
  { value: "newest" as const, label: "Più recenti prima (_id)" },
];

export function BrowseMongo({ call, database }: { call: BrowseCall; database: string }) {
  const [collection, setCollection] = useState<MongoCollection | null>(null);
  return collection ? (
    <DocumentsView call={call} database={database} collection={collection} onBack={() => setCollection(null)} />
  ) : (
    <CollectionList call={call} database={database} onPick={setCollection} />
  );
}

function CollectionList({ call, database, onPick }: { call: BrowseCall; database: string; onPick: (c: MongoCollection) => void }) {
  const { data, failure, loading, refresh } = useBrowseFetch<{ collections: MongoCollection[]; truncated: boolean }>(call, {
    action: "collections",
    database,
  });
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = data?.collections ?? [];
    return needle ? all.filter((c) => c.name.toLowerCase().includes(needle)) : all;
  }, [data, search]);

  if (failure) return <BrowseFailureView failure={failure} onRetry={refresh} />;
  if (loading && !data) {
    return (
      <div className="space-y-2">
        <SkeletonBlock className="h-10" />
        <SkeletonBlock className="h-10" />
      </div>
    );
  }
  if (!data || data.collections.length === 0) {
    return <EmptyState icon="solar:database-linear" title="Nessuna collezione" description="In questo database non è ancora stato salvato niente." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <TextField value={search} onChange={setSearch} aria-label="Cerca una collezione" className="flex-1">
          <Input placeholder={`Cerca tra ${formatCount(data.collections.length)} collezioni`} />
        </TextField>
        <Button size="sm" variant="ghost" isPending={loading} onPress={refresh} aria-label="Aggiorna l'elenco">
          <Icon icon="solar:refresh-linear" width={16} aria-hidden />
        </Button>
      </div>
      <ul className="border-border divide-border max-h-[60vh] divide-y overflow-auto rounded-[var(--radius)] border">
        {shown.map((item) => (
          <li key={item.name}>
            <button
              type="button"
              onClick={() => onPick(item)}
              className="hover:bg-surface-hover flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
            >
              <Icon icon={item.type === "view" ? "solar:eye-linear" : "solar:documents-minimalistic-linear"} width={16} className="text-muted shrink-0" aria-hidden />
              <span className="text-foreground min-w-0 flex-1 truncate font-mono text-sm">{item.name}</span>
              {item.type !== "collection" && <span className="text-muted text-meta shrink-0">{item.type === "view" ? "vista" : item.type}</span>}
              {item.count !== null && (
                <span className="text-muted text-meta shrink-0 tabular-nums">
                  circa {formatCount(item.count)} {item.count === 1 ? "documento" : "documenti"}
                </span>
              )}
              <Icon icon="solar:alt-arrow-right-linear" width={15} className="text-muted shrink-0" aria-hidden />
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="text-muted px-3 py-3 text-sm">Nessuna collezione con questo nome.</li>}
      </ul>
      {data.truncated && <FieldHint>Sono elencate le prime {formatCount(data.collections.length)} collezioni.</FieldHint>}
    </div>
  );
}

function DocumentsView({
  call,
  database,
  collection,
  onBack,
}: {
  call: BrowseCall;
  database: string;
  collection: MongoCollection;
  onBack: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"natural" | "newest">("natural");
  const [applied, setApplied] = useState({ filter: "", sort: "natural" as "natural" | "newest", offset: 0 });
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<MongoDocument | null>(null);
  const [full, setFull] = useState<{ id: string; value: MongoDocumentFull } | null>(null);

  const { data, failure, loading, refresh } = useBrowseFetch<MongoDocumentPage>(call, {
    action: "documents",
    database,
    collection: collection.name,
    filter: applied.filter,
    sort: applied.sort,
    offset: applied.offset,
  });
  const [last, setLast] = useState<MongoDocumentPage | null>(null);
  if (data && data !== last) setLast(data);
  const page = data ?? last;

  function apply() {
    const check = checkMongoFilter(filter);
    if (!check.ok) {
      setProblem(check.reason);
      return;
    }
    setProblem(null);
    setOpen(null);
    if (applied.filter === filter && applied.sort === sort && applied.offset === 0) refresh();
    else setApplied({ filter, sort, offset: 0 });
  }

  async function loadFull(): Promise<BrowseFailure | null> {
    if (!open?.id) return null;
    const result = await call<MongoDocumentFull>({ action: "document", database, collection: collection.name, id: open.id });
    if (!result.ok) return result.failure;
    setFull({ id: open.id, value: result.data });
    return null;
  }
  const loaded = open?.id && full?.id === open.id ? full.value : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onPress={onBack}>
          <Icon icon="solar:arrow-left-linear" width={15} aria-hidden />
          Tutte le collezioni
        </Button>
        <span className="text-foreground min-w-0 truncate font-mono text-sm font-medium">{collection.name}</span>
        <span className="ml-auto flex items-center gap-2">
          <Elapsed ms={page?.elapsedMs} />
          <Button size="sm" variant="ghost" isPending={loading} onPress={refresh} aria-label="Ricarica i documenti">
            <Icon icon="solar:refresh-linear" width={16} aria-hidden />
          </Button>
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end">
        <Field label="Filtro" htmlFor="mongo-filter" error={problem ?? undefined}>
          <TextField value={filter} onChange={setFilter} aria-label="Filtro">
            <Input
              id="mongo-filter"
              className="font-mono text-sm"
              placeholder='{ "stato": "attivo" }'
              onKeyDown={(e) => {
                if (e.key === "Enter") apply();
              }}
            />
          </TextField>
        </Field>
        <SelectField label="Ordine" value={sort} onChange={setSort} options={SORTS} />
        <Button variant="primary" size="sm" className="sm:mb-0.5" isPending={loading} onPress={apply}>
          <Icon icon="solar:filter-linear" width={16} aria-hidden />
          Applica
        </Button>
      </div>
      <FieldHint>
        Il filtro è JSON, come in <span className="font-mono">find()</span>: vuoto li mostra tutti. Anche{" "}
        <span className="font-mono">{'{ "_id": { "$oid": "…" } }'}</span> e <span className="font-mono">{'{ "$date": "…" }'}</span>.
      </FieldHint>

      {failure ? (
        <BrowseFailureView failure={failure} onRetry={refresh} />
      ) : !page ? (
        <SkeletonBlock className="h-48" />
      ) : page.docs.length === 0 ? (
        <EmptyState
          icon="solar:documents-minimalistic-linear"
          title={applied.filter.trim() ? "Nessun documento corrisponde al filtro" : page.offset === 0 ? "La collezione è vuota" : "Nessun documento qui"}
        />
      ) : (
        <ol className="border-border divide-border max-h-[60vh] divide-y overflow-auto rounded-[var(--radius)] border">
          {page.docs.map((doc, i) => (
            <li key={`${page.offset}:${i}`}>
              <button
                type="button"
                onClick={() => setOpen(doc)}
                className="hover:bg-surface-hover flex w-full items-start gap-3 px-3 py-2 text-left transition-colors"
                aria-label={`Apri il documento ${formatCount(page.offset + i + 1)}`}
              >
                <span className="text-muted text-meta w-8 shrink-0 pt-0.5 text-right tabular-nums">{formatCount(page.offset + i + 1)}</span>
                <span className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">{doc.json}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {page && !failure && (
        <BrowsePager
          offset={page.offset}
          count={page.docs.length}
          pageSize={PAGE_SIZE}
          hasMore={page.hasMore}
          noun="Documenti"
          busy={loading}
          onChange={(offset) => setApplied({ ...applied, offset })}
        />
      )}

      {open && page && (
        <ValueDialog
          title={collection.name}
          subtitle="Il documento, in Extended JSON"
          value={loaded ? loaded.json : open.json}
          truncated={loaded ? loaded.truncated : open.truncated}
          limitNote={`i primi ${formatCount(loaded ? loaded.limit : page.limit)} caratteri`}
          onLoadFull={open.id && !loaded ? loadFull : undefined}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
