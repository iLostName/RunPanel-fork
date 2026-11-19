"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useExpertMode } from "@/components/Providers";
import { Badge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { cn } from "@/lib/utils";
import { SelectField, type SelectOption } from "@/components/ui/SelectField";
import { PERMISSION_GROUPS } from "@/components/users/labels";
import { AUDIT_CATEGORIES } from "@/lib/audit-filter";
import { ACTION_LABEL, CATEGORY_LABEL } from "@/lib/audit-labels";
import { useMe } from "@/lib/hooks/useMe";
import { useNodeApi } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";

/**
 * The log's filters, kept in the address bar: a link from a user's or a
 * project's page lands here already narrowed (`?userId=…`,
 * `?scope=project&scopeId=…`), a reload keeps them, and the export downloads
 * exactly what is on screen.
 */

export const FILTER_KEYS = ["category", "from", "to", "userId", "action", "scope", "scopeId"] as const;
export type AuditFilterValues = Record<(typeof FILTER_KEYS)[number], string>;

export function useAuditFilters(): [AuditFilterValues, (patch: Partial<AuditFilterValues>) => void] {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = useMemo(
    () => Object.fromEntries(FILTER_KEYS.map((key) => [key, search?.get(key) ?? ""])) as AuditFilterValues,
    [search]
  );
  const update = useCallback(
    (patch: Partial<AuditFilterValues>) => {
      // Every other parameter, the selected server among them, stays.
      const next = new URLSearchParams(search?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [search, router, pathname]
  );
  return [filters, update];
}

/** The filters as the API reads them: dates become the instants of the local day's bounds. */
export function auditQuery(f: AuditFilterValues): URLSearchParams {
  const sp = new URLSearchParams();
  for (const key of ["category", "userId", "action", "scope"] as const) if (f[key]) sp.set(key, f[key]);
  if (f.scope && f.scopeId) sp.set("scopeId", f.scopeId);
  if (f.from) sp.set("from", new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) sp.set("to", new Date(`${f.to}T23:59:59.999`).toISOString());
  return sp;
}

const SCOPE_OPTIONS: SelectOption<string>[] = [
  { value: "", label: "Tutto" },
  { value: "project", label: "Un progetto" },
  { value: "service", label: "Un database" },
  { value: "folder", label: "Una cartella" },
  { value: "user", label: "Un utente" },
  { value: "permission", label: "Un'area del pannello" },
];

/** The second field's label, for the kind picked in the first. */
const TARGET_LABEL: Record<string, string> = { project: "Progetto", service: "Database", folder: "Cartella", user: "Utente", permission: "Area" };

const AREA_OPTIONS = PERMISSION_GROUPS.flatMap((group) => group.items.map((item) => ({ value: item.key, label: item.label })));

interface Named {
  id: string;
  name?: string;
  display_name?: string | null;
  email?: string | null;
}

/** An option for a value the list does not hold (yet, or for this reader): still shown, never dropped. */
function withCurrent(options: SelectOption<string>[], value: string, label: string): SelectOption<string>[] {
  return value && !options.some((o) => o.value === value) ? [...options, { value, label }] : options;
}

export function AuditFilters({ filters, onChange }: { filters: AuditFilterValues; onChange: (patch: Partial<AuditFilterValues>) => void }) {
  const me = useMe();
  const api = useNodeApi();
  const { expert } = useExpertMode();
  const canListUsers = me.isOwner || me.permissions.includes("users.manage");

  const users = useResource<{ users: Named[] }>(canListUsers ? api("/api/users") : null);
  const projects = useResource<Named[]>(filters.scope === "project" ? api("/api/projects") : null);
  const services = useResource<Named[]>(filters.scope === "service" ? api("/api/services") : null);
  const folders = useResource<Named[]>(filters.scope === "folder" ? api("/api/folders") : null);

  const userOptions = useMemo(() => {
    const listed = (users.data?.users ?? [])
      .filter((u) => u.id !== me.id)
      .map((u) => ({ value: u.id, label: u.email ?? "Account senza email" }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return withCurrent([{ value: "", label: "Tutti" }, { value: me.id, label: `Io (${me.email})` }, ...listed], filters.userId, "Utente selezionato");
  }, [users.data, me.id, me.email, filters.userId]);

  const actionOptions = useMemo(() => {
    const known = Object.entries(ACTION_LABEL)
      .map(([value, label]) => ({ value, label, description: expert ? value : undefined }))
      .sort((a, b) => a.label.localeCompare(b.label, "it"));
    return withCurrent([{ value: "", label: "Tutte" }, ...known], filters.action, filters.action);
  }, [expert, filters.action]);

  const targetOptions = useMemo(() => {
    const named = (rows: Named[] | null | undefined) =>
      (rows ?? []).map((r) => ({ value: r.id, label: r.display_name || r.name || r.email || r.id })).sort((a, b) => a.label.localeCompare(b.label));
    const lists: Record<string, SelectOption<string>[]> = {
      project: named(projects.data),
      service: named(services.data),
      folder: named(folders.data),
      user: named(users.data?.users),
      permission: AREA_OPTIONS,
    };
    return withCurrent([{ value: "", label: "Tutti" }, ...(lists[filters.scope] ?? [])], filters.scopeId, "Selezionato");
  }, [filters.scope, filters.scopeId, projects.data, services.data, folders.data, users.data]);

  const active = FILTER_KEYS.some((key) => filters[key]);
  // The kind and the item it names count as one filter.
  const count = FILTER_KEYS.filter((key) => key !== "scopeId" && filters[key]).length;
  const [open, setOpen] = useState(false);

  return (
    <Panel className={cn("space-y-3", !open && "max-md:space-y-0")}>
      {/*
        On a phone the filters fold behind one row that says how many are on:
        open, the six fields filled the first screen and the log started below
        it, every time the page was opened.
      */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="touch-chrome flex w-full items-center gap-2 text-left md:hidden"
      >
        <Icon icon="solar:filter-linear" width={16} className="text-muted shrink-0" aria-hidden />
        <span className="text-foreground flex-1 text-sm font-medium">Filtri</span>
        {count > 0 && <Badge tone="accent">{count === 1 ? "1 attivo" : `${count} attivi`}</Badge>}
        <Icon icon={open ? "solar:alt-arrow-up-linear" : "solar:alt-arrow-down-linear"} width={16} className="text-muted shrink-0" aria-hidden />
      </button>
      <div className={cn("space-y-3", !open && "max-md:hidden")}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SelectField
            label="Categoria"
            value={filters.category}
            onChange={(category) => onChange({ category })}
            options={[{ value: "", label: "Tutte" }, ...AUDIT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c].label }))]}
          />
          <TextField type="date" value={filters.from} onChange={(from) => onChange({ from })}>
            <Label>Dal</Label>
            <Input />
          </TextField>
          <TextField type="date" value={filters.to} onChange={(to) => onChange({ to })}>
            <Label>Al</Label>
            <Input />
          </TextField>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SelectField label="Chi" value={filters.userId} onChange={(userId) => onChange({ userId })} options={userOptions} />
          <SelectField label="Azione" value={filters.action} onChange={(action) => onChange({ action })} options={actionOptions} />
          <SelectField
            label="Su cosa"
            value={filters.scope}
            onChange={(scope) => onChange({ scope, scopeId: "" })}
            options={SCOPE_OPTIONS}
          />
        </div>
        {filters.scope && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SelectField
              label={TARGET_LABEL[filters.scope] ?? "Quale"}
              value={filters.scopeId}
              onChange={(scopeId) => onChange({ scopeId })}
              options={targetOptions}
            />
          </div>
        )}
        {active && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onChange(Object.fromEntries(FILTER_KEYS.map((key) => [key, ""])) as Partial<AuditFilterValues>)}
            >
              <Icon icon="solar:close-circle-linear" width={15} aria-hidden />
              Azzera i filtri
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
