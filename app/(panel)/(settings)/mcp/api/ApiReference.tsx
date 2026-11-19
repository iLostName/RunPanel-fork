"use client";

import { useDeferredValue, useMemo, useState, useSyncExternalStore } from "react";
import { Disclosure, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { EmptyState } from "@/components/ui/EmptyState";
import { Code, Hint } from "@/components/ui/Hint";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { SUBPAGE_TITLES } from "@/lib/nav";
import type { RouteEntry } from "@/services/mcp/catalog";

/**
 * The catalog as a reference: grouped by area, searchable, each endpoint with a
 * curl line to copy. The summaries are the catalog's own, in English, because
 * they are the very text an AI assistant reads; everything around them is the
 * panel's language.
 */

type Method = RouteEntry["method"];

const METHOD_TONE: Record<Method, BadgeTone> = {
  GET: "success",
  POST: "accent",
  PUT: "warning",
  PATCH: "warning",
  DELETE: "danger",
};

/** The first segment after `/api/`, named as the sidebar names it. */
const AREA_LABEL: Record<string, string> = {
  account: "Account",
  audit: "Registro attività",
  autostart: "Avvio automatico",
  backups: "Backup",
  cluster: "Server collegati",
  deployments: "Deploy",
  diagnostics: "Diagnostica",
  domains: "Domini",
  "env-groups": "Variabili condivise",
  folders: "Cartelle",
  github: "GitHub",
  metrics: "Monitor",
  monitor: "Monitor",
  network: "Rete",
  notifications: "Notifiche",
  onboarding: "Primi passi",
  presets: "Preset di deploy",
  projects: "Progetti",
  registries: "Registry",
  "server-summary": "Riepilogo del server",
  services: "Database",
  sessions: "Sessioni",
  settings: "Impostazioni",
  storage: "Spazio disco",
  updates: "Aggiornamenti",
  users: "Utenti",
};

function areaOf(path: string): string {
  const segment = path.split("/")[2] ?? "";
  return AREA_LABEL[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
}

const noSubscription = () => () => {};

/** This panel's address, read in the browser; empty on the server so the first render matches. */
function useOrigin(): string {
  return useSyncExternalStore(noSubscription, () => window.location.origin, () => "");
}

function curlFor(route: RouteEntry, origin: string): string {
  const url = `${origin || "https://pannello.example.com"}${route.path}`;
  const lines = [`curl${route.method === "GET" ? "" : ` -X ${route.method}`} "${url}"`, `  -H "Authorization: Bearer $RUNPANEL_TOKEN"`];
  if (route.body) lines.push(`  -H "Content-Type: application/json"`, `  -d '{}'`);
  return lines.join(" \\\n");
}

const METHOD_FILTERS = [
  { value: "all", label: "Tutti" },
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
  { value: "PATCH", label: "PATCH" },
  { value: "DELETE", label: "DELETE" },
] as const;

export function ApiReference({ routes }: { routes: RouteEntry[] }) {
  const origin = useOrigin();
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState<(typeof METHOD_FILTERS)[number]["value"]>("all");
  const query = useDeferredValue(search.trim().toLowerCase());

  const groups = useMemo(() => {
    const words = query.split(/\s+/).filter(Boolean);
    const shown = routes.filter((route) => {
      if (method !== "all" && route.method !== method) return false;
      const haystack = `${route.method} ${route.path} ${route.summary} ${route.query} ${route.body} ${areaOf(route.path)}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    const byArea = new Map<string, RouteEntry[]>();
    for (const route of shown) {
      const area = areaOf(route.path);
      byArea.set(area, [...(byArea.get(area) ?? []), route]);
    }
    return [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b, "it"));
  }, [routes, query, method]);

  const count = groups.reduce((sum, [, list]) => sum + list.length, 0);

  return (
    <>
      <PageHeader
        back={{ href: "/mcp", label: "Torna a AI e API" }}
        title={SUBPAGE_TITLES["/mcp/api"]}
        description={`${routes.length} endpoint: metodo, percorso, parametri e corpo di ognuno`}
      />

      <div className="max-w-4xl space-y-4">
        <Hint tone="info" title="Come si chiama">
          Ogni richiesta porta un token, creato nella pagina AI e API, nell&apos;intestazione{" "}
          <Code>Authorization: Bearer …</Code>. Un token in sola lettura può usare solo <Code>GET</Code>. I corpi sono JSON;
          gli errori sono sempre <Code>{"{ error }"}</Code> in italiano, con uno stato 4xx o 5xx. Le descrizioni sono in
          inglese: sono le stesse che legge l&apos;assistente AI.
        </Hint>

        <Panel className="space-y-3">
          <PanelHeader title="Per iniziare" description="Salva il token in una variabile, poi copia gli esempi qui sotto" />
          <CommandBlock
            commands={[`export RUNPANEL_TOKEN="rpk_…"`, `curl "${origin || "https://pannello.example.com"}/api/projects" -H "Authorization: Bearer $RUNPANEL_TOKEN"`]}
            label="Comando copiato"
          />
        </Panel>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <TextField value={search} onChange={setSearch} className="min-w-0 flex-1">
            <Label>Cerca</Label>
            <Input placeholder="progetti deploy, /api/backups, restart…" />
          </TextField>
          <Segmented label="Metodo" value={method} onChange={setMethod} options={[...METHOD_FILTERS]} />
        </div>
        <p className="text-muted text-xs" aria-live="polite">
          {count === routes.length ? `${count} endpoint` : `${count} di ${routes.length} endpoint`}
        </p>

        {groups.length === 0 ? (
          <EmptyState icon="solar:code-square-linear" title="Nessun endpoint" description="Niente corrisponde alla ricerca." />
        ) : (
          groups.map(([area, list]) => (
            <Panel key={area} padding="flush" className="overflow-hidden">
              <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
                <h2 className="text-foreground text-sm font-medium">{area}</h2>
                <span className="text-muted text-xs">{list.length}</span>
              </div>
              <ul className="divide-border divide-y">
                {list.map((route) => (
                  <li key={`${route.method} ${route.path}`}>
                    <RouteRow route={route} origin={origin} />
                  </li>
                ))}
              </ul>
            </Panel>
          ))
        )}
      </div>
    </>
  );
}

function RouteRow({ route, origin }: { route: RouteEntry; origin: string }) {
  return (
    <Disclosure>
      <Disclosure.Heading>
        <Disclosure.Trigger className="hover:bg-surface-hover flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors">
          <Badge tone={METHOD_TONE[route.method]} mono className="mt-0.5 w-14 justify-center">
            {route.method}
          </Badge>
          <span className="min-w-0 flex-1">
            <span className="text-foreground block font-mono text-xs break-all">{route.path}</span>
            <span className="text-muted mt-0.5 block text-xs">{route.summary}</span>
          </span>
          {route.kind !== "json" && <Badge>{route.kind === "stream" ? "SSE" : "file"}</Badge>}
          <Disclosure.Indicator className="text-muted mt-0.5 shrink-0" />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <div className="space-y-3 px-4 pt-1 pb-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted">Parametri</dt>
            <dd className="text-foreground font-mono break-words">{route.query || "—"}</dd>
            <dt className="text-muted">Corpo</dt>
            <dd className="text-foreground font-mono break-words">{route.body || "—"}</dd>
            <dt className="text-muted">Risposta</dt>
            <dd className="text-foreground">
              {route.kind === "stream"
                ? "flusso SSE che resta aperto: non si legge via MCP"
                : route.kind === "binary"
                  ? "un file da scaricare"
                  : "JSON"}
            </dd>
          </dl>
          <CommandBlock commands={[curlFor(route, origin)]} label="Comando copiato" />
          {route.path.includes("{") && (
            <p className="text-muted text-xs">
              <Icon icon="solar:info-circle-linear" width={13} className="mr-1 inline align-[-2px]" aria-hidden />
              Sostituisci le parti tra graffe, per esempio <Code>{"{projectId}"}</Code>, con l&apos;id vero.
            </p>
          )}
        </div>
      </Disclosure.Content>
    </Disclosure>
  );
}
