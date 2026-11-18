"use client";

import { useState } from "react";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SelectField } from "@/components/ui/SelectField";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import type { Service } from "./types";
import { useBrowseCall } from "./BrowseKit";
import { BrowseSql } from "./BrowseSql";
import { BrowseRedis } from "./BrowseRedis";
import { BrowseMongo } from "./BrowseMongo";

/**
 * The "Dati" tab: what is inside the database, for reading only.
 *
 * A tab of its own rather than a button in "Database interni": Redis has no
 * named databases to put the button on, and a list of tables, a grid of rows
 * and a query box are a place to stay in, not a row to expand. Every tab of
 * this page stays mounted, so this one asks the database nothing until it is
 * first shown — opening the page must not run a query on production data.
 *
 * Reading rows is reading data: the tab asks for the same permission as the
 * console, and the server asks again on every call.
 */

interface ServiceDatabase {
  name: string;
  primary: boolean;
  present: boolean;
}

const BROWSABLE = new Set(["postgresql", "mysql", "redis", "mongodb"]);

/** Whether this account may read rows: the console's permission. */
export function canBrowseData(permission: Service["permission"]): boolean {
  if (!permission) return true;
  return permission.terminal && (permission.level === "operate" || permission.level === "manage");
}

export function BrowsePanel({
  serviceId,
  type,
  running,
  permission,
  active,
  database,
  onDatabaseChange,
}: {
  serviceId: string;
  type: string;
  running: boolean;
  permission: Service["permission"];
  /** The tab is on screen. */
  active: boolean;
  /** Chosen here or from "Sfoglia" in Database interni; null is the primary one. */
  database: string | null;
  onDatabaseChange: (name: string) => void;
}) {
  // Latched the first time the tab shows, so switching away keeps what was open.
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);

  const api = useNodeApi();
  const call = useBrowseCall(serviceId);
  const allowed = canBrowseData(permission);
  const supported = BROWSABLE.has(type);
  const named = type !== "redis";

  const { data, error, refresh } = useResource<{ supported: boolean; running: boolean; databases: ServiceDatabase[] }>(
    opened && allowed && supported && running && named ? api(`/api/services/${serviceId}/databases`) : null
  );
  const present = (data?.databases ?? []).filter((d) => d.present);
  const primary = present.find((d) => d.primary)?.name;
  const chosen = database && present.some((d) => d.name === database) ? database : (primary ?? present[0]?.name ?? null);

  let body: React.ReactNode;
  if (!allowed) {
    body = (
      <EmptyState
        icon="solar:lock-keyhole-minimalistic-linear"
        title="Serve il permesso Console"
        description="Leggere i dati di un database è come aprirne la console: chiedi a chi gestisce il pannello di dartelo."
      />
    );
  } else if (!supported) {
    body = <EmptyState icon="solar:database-linear" title="Questo tipo di database non si può sfogliare dal pannello" />;
  } else if (!running) {
    body = <Hint tone="warn">Il database è fermo: avvialo per vedere i dati.</Hint>;
  } else if (!opened) {
    body = null;
  } else if (type === "redis") {
    body = <BrowseRedis call={call} />;
  } else if (error && !data) {
    body = <LoadError what="l'elenco dei database" error={error} onRetry={() => void refresh()} />;
  } else if (!data) {
    body = <SkeletonBlock className="h-10" />;
  } else if (!chosen) {
    body = <EmptyState icon="solar:database-linear" title="Nessun database" description="Il motore non ne riporta nessuno: crealo da Database interni." />;
  } else {
    body = (
      <div className="space-y-4">
        {present.length > 1 ? (
          <SelectField
            label="Database"
            value={chosen}
            onChange={onDatabaseChange}
            options={present.map((d) => ({ value: d.name, label: d.primary ? `${d.name} (principale)` : d.name }))}
            className="sm:max-w-xs"
          />
        ) : (
          <p className="text-muted text-sm">
            Database <span className="text-foreground font-mono">{chosen}</span>
          </p>
        )}
        {type === "mongodb" ? (
          <BrowseMongo key={chosen} call={call} database={chosen} />
        ) : (
          <BrowseSql key={chosen} engine={type === "mysql" ? "mysql" : "postgresql"} database={chosen} call={call} />
        )}
      </div>
    );
  }

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Dati"
        description="Guarda cosa c'è nel database. Da qui si legge soltanto: non si può cambiare niente."
        actions={<Badge icon="solar:lock-keyhole-minimalistic-linear">Sola lettura</Badge>}
      />
      {body}
      {allowed && supported && running && (
        <FieldHint>Ogni lettura resta nel registro attività, con la query com&apos;è stata scritta ma senza i dati letti.</FieldHint>
      )}
    </Panel>
  );
}
