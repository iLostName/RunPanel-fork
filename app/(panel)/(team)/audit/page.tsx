"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { FieldHint } from "@/components/ui/Hint";
import { LinkButton } from "@/components/ui/LinkButton";
import { Technical } from "@/components/ui/Technical";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import { formatWhen } from "@/lib/format";
import { AUDIT_CATEGORIES, type AuditCategory } from "@/lib/audit-filter";
import { useNode, useNodeApi } from "@/lib/hooks/useNode";
import { ServerSelector } from "@/components/ServerSelector";
import { ACTION_LABEL, CATEGORY_LABEL, SCOPE_LABEL } from "@/lib/audit-labels";
import { AuditFilters, auditQuery, useAuditFilters } from "./_components/AuditFilters";

interface Entry {
  id: string;
  at: string;
  userId: string | null;
  email: string | null;
  category: string;
  action: string;
  scope: string | null;
  scopeId: string | null;
  scopeName: string | null;
  detail: string | null;
  ip: string | null;
}

/** Who did what, filtered to what the reader may see. */
export default function AuditPage() {
  const me = useMe();
  // Each server keeps its own log: say whose this is, and let it be switched here.
  const { isSolo, current } = useNode();
  const api = useNodeApi();
  const [filters, setFilters] = useAuditFilters();
  const query = auditQuery(filters).toString();
  const exportHref = (separator?: "comma") => {
    const sp = auditQuery(filters);
    if (separator) sp.set("separator", separator);
    const qs = sp.toString();
    return api(`/api/audit/export${qs ? `?${qs}` : ""}`);
  };

  return (
    <>
      <PageHeader
        title="Registro attività"
        description={isSolo ? "Chi ha fatto cosa, e quando" : `Chi ha fatto cosa, e quando, su ${current?.name ?? "questo server"}`}
        actions={
          <>
            {/* What is on screen, as a file a spreadsheet opens: same filters, same visibility. */}
            <LinkButton href={exportHref()} download variant="secondary" aria-label="Esporta in CSV le voci filtrate">
              <Icon icon="solar:file-download-linear" width={15} aria-hidden />
              Esporta CSV
            </LinkButton>
            <Technical>
              <LinkButton href={exportHref("comma")} download aria-label="Esporta in CSV con la virgola come separatore">
                CSV con virgola
              </LinkButton>
            </Technical>
            <ServerSelector className="sm:hidden" />
          </>
        }
      />

      <div className="space-y-4">
        <AuditFilters filters={filters} onChange={setFilters} />

        {/* Remounted per filter, so a new search starts from a clean list. */}
        <AuditList key={query} query={query} />

        {me.isOwner && <AuditSettings />}
      </div>
    </>
  );
}

function AuditList({ query: filterQuery }: { query: string }) {
  const api = useNodeApi();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const query = useCallback(
    (before?: string) => {
      const sp = new URLSearchParams(filterQuery);
      sp.set("limit", "50");
      if (before) sp.set("before", before);
      return fetch(api(`/api/audit?${sp}`)).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Il server ha risposto ${res.status}`);
        return data as { entries: Entry[]; nextBefore: string | null };
      });
    },
    [filterQuery, api]
  );

  useEffect(() => {
    let cancelled = false;
    query()
      .then((data) => {
        if (cancelled) return;
        setError(null);
        setEntries(data.entries);
        setNext(data.nextBefore);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [query, attempt]);

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const data = await query(next);
      setEntries((prev) => [...(prev ?? []), ...data.entries]);
      setNext(data.nextBefore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Caricamento non riuscito");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      {error ? (
        <LoadError what="il registro" error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : entries === null ? (
        <SkeletonBlock className="h-64" />
      ) : entries.length === 0 ? (
        <EmptyState icon="solar:history-linear" title="Nessuna attività" description="Niente da mostrare con questi filtri." />
      ) : (
        <Panel padding="flush" className="overflow-hidden">
          <ul className="divide-border divide-y">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                <span className="text-meta shrink-0 text-xs tabular-nums sm:w-40">{formatWhen(e.at)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-foreground text-sm">
                    <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                    {e.detail && <span className="text-muted"> · {e.detail}</span>}
                  </p>
                  <p className="text-meta truncate text-xs">
                    {e.email ?? (e.userId ? "account eliminato" : "il pannello")}
                    {e.scope && e.scope !== "permission" && ` · ${SCOPE_LABEL[e.scope] ?? e.scope} ${e.scopeName ?? e.scopeId ?? ""}`}
                    {e.ip && ` · ${e.ip}`}
                  </p>
                </div>
                <span className="text-meta shrink-0 text-xs">
                  {CATEGORY_LABEL[e.category]?.label ?? e.category}
                </span>
              </li>
            ))}
          </ul>
          {next && (
            <div className="border-border border-t p-3 text-center">
              <Button variant="ghost" size="sm" isPending={loadingMore} onPress={more}>
                Carica altre
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

/** The owner's choice of what is recorded and for how long. */
function AuditSettings() {
  const api = useNodeApi();
  const settings = useResource<{ categories: AuditCategory[]; retentionDays: number }>(api("/api/audit/settings"));
  return (
    <Section title="Cosa registrare" summary="Categorie e conservazione — solo il proprietario">
      {settings.error && !settings.data ? (
        <LoadError what="le impostazioni del registro" error={settings.error} onRetry={settings.refresh} />
      ) : !settings.data ? (
        <SkeletonBlock className="h-40" />
      ) : (
        <AuditSettingsForm key={JSON.stringify(settings.data)} initial={settings.data} onSaved={settings.refresh} />
      )}
    </Section>
  );
}

function AuditSettingsForm({
  initial,
  onSaved,
}: {
  initial: { categories: AuditCategory[]; retentionDays: number };
  onSaved: () => Promise<void>;
}) {
  const api = useNodeApi();
  const [categories, setCategories] = useState<AuditCategory[]>(initial.categories);
  const [days, setDays] = useState(String(initial.retentionDays));
  const [saving, setSaving] = useState(false);

  async function save() {
    const retentionDays = Number.parseInt(days, 10);
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      toast.error("La conservazione va da 1 a 3650 giorni");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(api("/api/audit/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories, retentionDays }),
      });
      if (!res.ok) throw new Error();
      toast.success("Impostazioni del registro salvate");
      await onSaved();
    } catch {
      toast.error("Salvataggio non riuscito");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {AUDIT_CATEGORIES.map((c) => (
        <SettingToggle
          key={c}
          label={CATEGORY_LABEL[c].label}
          description={CATEGORY_LABEL[c].description}
          isSelected={c === "security" || categories.includes(c)}
          isDisabled={c === "security"}
          onChange={(on) => setCategories(on ? [...categories, c] : categories.filter((x) => x !== c))}
        />
      ))}
      <div>
        <TextField value={days} onChange={setDays} className="max-w-40">
          <Label>Conservazione (giorni)</Label>
          <Input inputMode="numeric" />
        </TextField>
        <FieldHint>Le voci più vecchie vengono cancellate dalla pulizia periodica, ogni 6 ore.</FieldHint>
      </div>
      <Button variant="primary" isPending={saving} onPress={save}>
        Salva
      </Button>
    </div>
  );
}
