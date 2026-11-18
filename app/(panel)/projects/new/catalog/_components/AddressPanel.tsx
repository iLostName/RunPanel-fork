"use client";

import { Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Code, Hint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { LinkButton } from "@/components/ui/LinkButton";
import type { CatalogTemplate } from "@/lib/app-catalog";

export interface DomainsResponse {
  proxy?: { state: string; detail: string };
  domains?: { id: string; name: string }[];
  hosts?: { hostname: string }[];
}

/**
 * Where the app will answer: a subdomain of a configured domain, as in the new
 * project wizard, read from the same `GET /api/domains`. The name is only
 * chosen here; the install route claims it, together with the project.
 */
export function AddressPanel({
  template,
  domains,
  proxy,
  domainId,
  onDomain,
  subdomain,
  onSubdomain,
  hostname,
  error,
  domainsHref,
}: {
  template: CatalogTemplate;
  domains: { id: string; name: string }[];
  proxy: DomainsResponse["proxy"];
  domainId: string;
  onDomain: (id: string) => void;
  subdomain: string;
  onSubdomain: (value: string) => void;
  hostname: string | null;
  error: string | null;
  domainsHref: string;
}) {
  const required = template.address === "required";

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Indirizzo"
        description={
          required
            ? "Obbligatorio per questa app"
            : template.address === "recommended"
              ? "Consigliato, ma puoi aggiungerlo anche dopo"
              : "Facoltativo: puoi aggiungerlo anche dopo"
        }
      />
      {template.addressNote && template.address !== "optional" && <Hint tone={required ? "warn" : "tip"}>{template.addressNote}</Hint>}

      {domains.length === 0 ? (
        <div className="space-y-3">
          <p className="text-muted text-sm">
            Nessun dominio configurato. Quando ne aggiungi uno in Domini puoi dare all&apos;app un indirizzo come{" "}
            <Code>app.tuodominio.it</Code>
            {required ? ": per questa app serve prima di installarla." : "."}
          </p>
          <LinkButton href={domainsHref} variant="secondary">
            <Icon icon="solar:global-linear" width={16} aria-hidden />
            Vai a Domini
          </LinkButton>
        </div>
      ) : (
        <>
          <SelectField
            label="Dominio"
            value={domainId}
            onChange={onDomain}
            options={[...(required ? [] : [{ value: "", label: "Lo aggiungo dopo" }]), ...domains.map((d) => ({ value: d.id, label: d.name }))]}
          />
          {domainId ? (
            <Field
              label="Sottodominio"
              error={error}
              hint={hostname ? <>L&apos;app sarà su <Code>https://{hostname}</Code>. Vuoto per il dominio intero.</> : undefined}
            >
              <TextField value={subdomain} onChange={onSubdomain} aria-label="Sottodominio">
                <Input placeholder={template.id} className="font-mono text-sm" />
              </TextField>
            </Field>
          ) : (
            error && (
              <p className="text-danger text-sm" role="alert">
                {error}
              </p>
            )
          )}
          {domainId && proxy && proxy.state !== "ready" && (
            <Hint tone="warn" title="Il proxy non è ancora pronto">
              {proxy.detail} L&apos;indirizzo viene salvato e funzionerà appena il proxy è configurato in Domini.
            </Hint>
          )}
        </>
      )}
    </Panel>
  );
}
