"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Field } from "@/components/ui/Field";
import { SelectField } from "@/components/ui/SelectField";
import { Segmented } from "@/components/ui/Segmented";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useNodeApi } from "@/lib/hooks/useNode";
import { hostnameFor, instantDomainAddress, wwwTwin } from "@/lib/proxy-names";
import { DOMAIN_RULE, domainNameSchema, subdomainSchema } from "@/lib/validation";
import { PROXY_SERVES, ProxySetup, type ProxyInfo } from "@/app/(panel)/domains/_components/ProxySetup";
import type { HostView } from "@/services/proxy";

export interface AddressFormData {
  hosts: HostView[];
  domains: { id: string; name: string; cloudflare?: boolean }[];
  proxy: ProxyInfo;
  panelHostname?: string | null;
}

type Kind = "sub" | "apex";

const LABEL_HINT = "Una sola parola: minuscole, numeri e trattini, per esempio app o negozio";

/**
 * A new address for the project: which domain, which name under it, and —
 * for the domain itself or its www — the other one redirecting here.
 *
 * Whatever can be known before sending is said while typing: a name the
 * project already has, the panel's own address, a label DNS would refuse.
 * What only the server knows — a name another project holds — comes back
 * under the form, which stays open with what was typed.
 *
 * With no domain yet, the first one is added from here; with nginx not ready,
 * its setup is here too. The DNS record comes after, in the dialog that opens
 * once the address exists: by then the panel serves it and can check it.
 */
export function DomainAddDialog({
  projectId,
  isOpen,
  onOpenChange,
  data,
  onAdded,
  onChanged,
}: {
  projectId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  data: AddressFormData;
  onAdded: (host: HostView) => void;
  /** Read the section's data again: after a domain was added, or nginx set up. */
  onChanged: () => Promise<void>;
}) {
  const api = useNodeApi();
  const [domainId, setDomainId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("sub");
  const [subdomain, setSubdomain] = useState("");
  const [www, setWww] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [addingDomain, setAddingDomain] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainError, setNewDomainError] = useState<string | null>(null);
  const [domainBusy, setDomainBusy] = useState(false);

  // A server's instant domain (`203-0-113-7.sslip.io`) is not one to pick here: its names come from "Indirizzo di prova".
  const domains = data.domains.filter((d) => instantDomainAddress(d.name) === null);
  const chosen = domains.find((d) => d.id === domainId) ?? domains[0] ?? null;
  const typing = addingDomain || domains.length === 0;

  // The label as it will be stored, and whether it is one.
  const raw = kind === "apex" ? "" : subdomain.trim().toLowerCase();
  const parsed = subdomainSchema.safeParse(raw);
  // Not the schema's own message: that one offers "empty for the domain itself", which here is the other choice.
  const labelError =
    kind === "sub" && subdomain.trim() !== "" && !parsed.success
      ? "Una sola parola, con minuscole, numeri e trattini (non all'inizio né alla fine)"
      : null;
  const label = kind === "apex" || (parsed.success && raw !== "") ? raw : null;
  const hostname = chosen && label !== null ? hostnameFor(label, chosen.name) : null;

  const ownNames = new Set(data.hosts.map((host) => host.hostname));
  const nameProblem = (name: string) =>
    ownNames.has(name)
      ? `${name} è già un indirizzo di questo progetto.`
      : data.panelHostname === name
        ? `${name} è l'indirizzo del pannello: lì risponde il pannello stesso.`
        : null;
  const problem =
    chosen && label !== null && !hostname
      ? "L'indirizzo completo supera la lunghezza che il DNS consente."
      : hostname
        ? nameProblem(hostname)
        : null;
  const twin = chosen && hostname && label !== null ? wwwTwin(label, chosen.name) : null;
  const twinProblem = twin ? nameProblem(twin.hostname) : null;
  const withTwin = twin !== null && twinProblem === null && www;

  async function addDomain() {
    const parsedDomain = domainNameSchema.safeParse(newDomain);
    if (!parsedDomain.success) {
      setNewDomainError(parsedDomain.error.issues[0]?.message ?? DOMAIN_RULE);
      return;
    }
    setDomainBusy(true);
    try {
      const res = await fetch(api("/api/domains"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: parsedDomain.data }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNewDomainError(body.details?.[0]?.message ?? body.error ?? MSG.saveFailed);
        return;
      }
      toast.success(`${parsedDomain.data} aggiunto ai domini`);
      await onChanged();
      setDomainId(String(body.id));
      setAddingDomain(false);
      setNewDomain("");
      setNewDomainError(null);
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setDomainBusy(false);
    }
  }

  async function submit(): Promise<boolean> {
    if (!chosen || label === null || !hostname || problem) return false;
    try {
      const res = await fetch(api(`/api/projects/${projectId}/hosts`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domainId: chosen.id, subdomain: label, www: withTwin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setServerError(body.details?.[0]?.message ?? body.error ?? MSG.saveFailed);
        return false;
      }
      toast.success(withTwin ? `${hostname} e ${twin?.hostname} aggiunti` : `${hostname} aggiunto`);
      onAdded(body.host as HostView);
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Aggiungi un indirizzo"
      description="Il nome con cui si apre il progetto, in HTTPS: per esempio app.esempio.it."
      submitLabel="Aggiungi"
      isSubmitDisabled={!chosen || typing || label === null || !hostname || problem !== null}
      onSubmit={submit}
      wide
    >
      {!PROXY_SERVES.has(data.proxy.state) && (
        <div className="space-y-3">
          <Hint tone="warn" title="nginx su questo server non è ancora pronto">
            Puoi aggiungere l&apos;indirizzo anche adesso: resta in attesa e parte da solo quando nginx è pronto.
          </Hint>
          <ProxySetup proxy={data.proxy} onChanged={onChanged} />
        </div>
      )}

      {typing ? (
        <div className="space-y-2">
          <Field
            label={domains.length === 0 ? "Il tuo dominio" : "Un altro dominio"}
            hint="Un dominio che possiedi, comprato da un registrar: per esempio esempio.it"
            error={newDomainError ?? undefined}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <TextField
                value={newDomain}
                onChange={(value) => {
                  setNewDomain(value);
                  setNewDomainError(null);
                }}
                aria-label="Dominio"
                className="flex-1"
              >
                <Input placeholder="esempio.it" className="font-mono" />
              </TextField>
              <Button size="sm" variant="secondary" onPress={addDomain} isPending={domainBusy} isDisabled={!newDomain.trim()}>
                <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                Aggiungi il dominio
              </Button>
            </div>
          </Field>
          {domains.length > 0 && (
            <Button size="sm" variant="ghost" onPress={() => setAddingDomain(false)}>
              Usa un dominio che c&apos;è già
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <SelectField
            label="Dominio"
            value={chosen?.id ?? null}
            onChange={(next) => {
              setDomainId(next);
              setServerError(null);
            }}
            options={domains.map((d) => ({ value: d.id, label: d.name }))}
          />
          <Button size="sm" variant="ghost" onPress={() => setAddingDomain(true)}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Un altro dominio
          </Button>
        </div>
      )}

      {chosen && !typing && (
        <>
          <Segmented
            label="Che indirizzo"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setServerError(null);
            }}
            options={[
              { value: "sub", label: "Un sottodominio" },
              { value: "apex", label: `${chosen.name} e basta` },
            ]}
          />

          {kind === "sub" && (
            <Field label="Sottodominio" hint={LABEL_HINT} error={labelError ?? undefined}>
              <div className="flex items-center gap-2">
                <TextField
                  value={subdomain}
                  onChange={(value) => {
                    setSubdomain(value);
                    setServerError(null);
                  }}
                  aria-label="Sottodominio"
                  className="flex-1"
                >
                  <Input placeholder="app" className="font-mono" autoComplete="off" />
                </TextField>
                <span className="text-muted shrink-0 font-mono text-sm">.{chosen.name}</span>
              </div>
            </Field>
          )}

          <div className="bg-surface-secondary rounded-[var(--radius)] px-3 py-2.5">
            <p className="text-muted text-xs">L&apos;indirizzo sarà</p>
            <p className="text-foreground font-mono text-sm break-all">
              https://{hostname ?? (kind === "sub" ? `…${chosen.name}` : chosen.name)}
            </p>
          </div>
          {problem && (
            <p role="alert" className="text-danger text-sm">
              {problem}
            </p>
          )}

          {twin && (
            <CheckboxField
              label={`Anche ${twin.hostname}, che rimanda qui`}
              description={
                twinProblem ??
                "Chi scrive l'indirizzo con o senza www arriva comunque al progetto. Serve un record DNS anche per quello."
              }
              isSelected={withTwin}
              onChange={setWww}
              isDisabled={twinProblem !== null}
            />
          )}

          {chosen.cloudflare && (
            <FieldHint>
              {chosen.name} è sul tuo account Cloudflare: il certificato passa dal DNS di Cloudflare, anche con la
              nuvola arancione.
            </FieldHint>
          )}
          {kind === "apex" && (
            <FieldHint>
              Il dominio intero vuole un record DNS suo: quello per <Code>*.{chosen.name}</Code>, se c&apos;è, non lo
              copre.
            </FieldHint>
          )}
        </>
      )}

      {serverError && (
        <p role="alert" className="text-danger text-sm">
          {serverError}
        </p>
      )}
    </FormDialog>
  );
}
