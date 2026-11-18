"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code } from "@/components/ui/Hint";
import { InfoTip } from "@/components/ui/Tooltip";
import { RowMenu } from "@/components/ui/ListRow";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Technical } from "@/components/ui/Technical";
import { StatusBadge } from "@/components/StatusBadge";
import { SERVICE_ACTIONS, rowAllows, type Access } from "@/lib/authz";
import { serviceEnvKey, serviceLabel } from "@/lib/service-env";
import { serviceDisplayName } from "@/lib/service-name";
import { toast } from "@/lib/toast";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";

/** A service as `GET /api/services` lists it, with what its link hands the project. */
export interface LinkedService {
  id: string;
  name: string;
  display_name?: string | null;
  type: string;
  status: string;
  project_id: string | null;
  inject_env: number | null;
  env_key: string | null;
  injection?: { from: "host" | "container"; host: string; port: number; network: string | null } | null;
  permission?: Access;
}

/**
 * The variables nobody types: the connection URLs of the linked databases.
 *
 * Listed by variable, where the operator looks for `DATABASE_URL`, rather than
 * by service, which is where they would have to know to look. Read-only on
 * purpose — the value is built at every deploy from the database's own
 * credentials (`services/service-injection.ts`) — with the one thing that can
 * be changed from here: whether the link sets it at all. When the same name is
 * also in the table above, the deploy gives it to the database's value, and
 * the row says so before the deploy does.
 */
export function EnvLinkedVars({
  services,
  userKeys,
  onChanged,
}: {
  services: readonly LinkedService[];
  /** Names defined in the editor right now, saved or not. */
  userKeys: ReadonlySet<string>;
  onChanged: () => void;
}) {
  // Two links that want the same name: the deploy keeps the first and reports
  // the rest, so the page says it too.
  const owners = new Map<string, string[]>();
  for (const service of services) {
    if (service.inject_env !== 1) continue;
    const key = serviceEnvKey(service);
    owners.set(key, [...(owners.get(key) ?? []), serviceDisplayName(service)]);
  }

  return (
    <Panel className="space-y-3">
      <PanelHeader
        title="Dai database collegati"
        description="Impostate da RunPanel a ogni deploy: non serve copiarle"
        actions={
          <InfoTip title="Come viene scelto l'indirizzo">
            Un&apos;app in container raggiunge il database per nome sulla rete del progetto; un processo nativo lo
            raggiunge su <Code>localhost</Code> alla porta pubblicata. RunPanel costruisce l&apos;indirizzo di
            conseguenza, con le credenziali del database.
          </InfoTip>
        }
      />
      <ul className="divide-separator divide-y">
        {services.map((service) => (
          <LinkedVarRow
            key={service.id}
            service={service}
            defined={userKeys.has(serviceEnvKey(service))}
            rivals={(owners.get(serviceEnvKey(service)) ?? []).filter((name) => name !== serviceDisplayName(service))}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </Panel>
  );
}

function LinkedVarRow({
  service,
  defined,
  rivals,
  onChanged,
}: {
  service: LinkedService;
  defined: boolean;
  rivals: readonly string[];
  onChanged: () => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const [injecting, setInjecting] = useState(service.inject_env === 1);
  const [pending, setPending] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const key = serviceEnvKey(service);
  const name = serviceDisplayName(service);
  const canManage = rowAllows(service, SERVICE_ACTIONS.settings);

  async function patch(body: Record<string, unknown>, failure: string) {
    const res = await fetch(api(`/api/services/${service.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? failure);
    }
  }

  async function toggle(next: boolean) {
    // Optimistic, as on the service page: a switch has to move when pressed.
    setInjecting(next);
    setPending(true);
    try {
      await patch({ injectEnv: next }, "Modifica non riuscita");
      onChanged();
    } catch (err) {
      setInjecting(!next);
      toast.error(err instanceof Error ? err.message : "Modifica non riuscita");
    } finally {
      setPending(false);
    }
  }

  const warn = injecting && (defined || rivals.length > 0 || service.status !== "running");
  const line = !injecting
    ? defined
      ? `Spento: l'app usa la ${key} che hai definito qui sopra.`
      : `Spento: RunPanel non imposta ${key}. Se l'app la usa, definiscila tu qui sopra.`
    : rivals.length > 0
      ? `Anche ${rivals.join(", ")} vuole ${key}: al deploy ne vale uno solo. Dai a uno dei due un altro nome di variabile dalla pagina del database.`
      : defined
        ? `Hai definito anche tu ${key} qui sopra: al deploy vince quella del database. Spegni l'interruttore per usare la tua.`
        : service.status !== "running"
          ? "Il database è fermo: avvialo prima del prossimo deploy, o l'app non riuscirà a collegarsi."
          : `L'app riceve ${key} a ogni deploy. Se la definisci anche tu qui sopra, vince questa.`;

  return (
    <li className="space-y-2 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon icon="solar:lock-keyhole-minimalistic-linear" width={15} className="text-muted shrink-0" aria-hidden />
        <Code className={cn(!injecting && "text-muted line-through")}>{key}</Code>
        <span className="text-muted min-w-0 truncate text-sm">
          dal database{" "}
          <Link href={href(`/services/${service.id}`)} className="text-foreground hover:text-accent transition-colors">
            {name}
          </Link>{" "}
          · {serviceLabel(service.type)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <StatusBadge status={service.status} variant="dot" />
          <RowMenu
            label={`Azioni per ${name}`}
            actions={[
              {
                id: "unlink",
                label: "Scollega dal progetto",
                icon: "solar:link-circle-linear",
                danger: true,
                disabled: !canManage,
                onAction: () => setUnlinking(true),
              },
            ]}
          />
        </span>
      </div>

      <p className={cn("text-meta leading-relaxed", warn ? "text-warning" : "text-muted")}>{line}</p>

      {injecting && service.injection && (
        <Technical>
          <p className="text-muted flex flex-wrap items-center gap-1.5 text-meta">
            <span aria-hidden>→</span>
            <Code>
              {service.injection.host}:{String(service.injection.port)}
            </Code>
            {service.injection.network ? `(rete ${service.injection.network})` : "(dall'host, porta pubblicata)"}
          </p>
        </Technical>
      )}

      <SettingToggle
        label={`Imposta ${key} da solo`}
        description={canManage ? undefined : "Per cambiarlo serve il permesso di gestire il database."}
        isSelected={injecting}
        isDisabled={pending || !canManage}
        onChange={(next) => void toggle(next)}
      />

      <ConfirmDialog
        isOpen={unlinking}
        onOpenChange={setUnlinking}
        title={`Scollegare ${name}?`}
        description={
          <>
            Il database e i suoi dati restano. Dal prossimo deploy il progetto non riceve più <Code>{key}</Code>.
          </>
        }
        confirmLabel="Scollega"
        onConfirm={async () => {
          try {
            await patch({ projectId: null }, "Scollegamento non riuscito");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Scollegamento non riuscito");
            return false;
          }
          toast.success(`${name} scollegato`);
          onChanged();
        }}
      />
    </li>
  );
}
