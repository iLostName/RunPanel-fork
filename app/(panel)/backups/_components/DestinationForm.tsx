"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { FormDialog } from "@/components/ui/FormDialog";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Field } from "@/components/ui/Field";
import { Advanced } from "@/components/ui/Technical";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { MSG } from "@/lib/copy";
import { useNodeApi } from "@/lib/hooks/useNode";

type Kind = "local" | "s3";

type ProviderId = "aws" | "r2" | "b2" | "hetzner" | "wasabi" | "custom";

/**
 * The S3-compatible services people actually use, with what each one wants.
 *
 * The form used to ask for an endpoint, a region and an "addressing style" up
 * front, which is three questions nobody can answer without the provider's
 * documentation open. Picking the provider fills them; the region is the only
 * one most people change, and the endpoint follows it.
 */
const PROVIDERS: Record<
  ProviderId,
  { label: string; region: string; endpoint: (region: string) => string; pathStyle: boolean; regionHint: string; note?: string }
> = {
  aws: {
    label: "Amazon S3",
    region: "eu-central-1",
    endpoint: (r) => `https://s3.${r}.amazonaws.com`,
    pathStyle: false,
    regionHint: "Per esempio eu-central-1 (Francoforte), eu-west-1 (Irlanda), eu-south-1 (Milano).",
  },
  r2: {
    label: "Cloudflare R2",
    region: "auto",
    endpoint: () => "https://<account-id>.r2.cloudflarestorage.com",
    pathStyle: false,
    regionHint: "Con R2 resta «auto».",
    note: "Sostituisci <account-id> nell'endpoint con l'ID del tuo account: lo trovi nella pagina R2 di Cloudflare.",
  },
  b2: {
    label: "Backblaze B2",
    region: "eu-central-003",
    endpoint: (r) => `https://s3.${r}.backblazeb2.com`,
    pathStyle: false,
    regionHint: "È nella pagina del bucket, nell'endpoint: per esempio eu-central-003.",
  },
  hetzner: {
    label: "Hetzner Object Storage",
    region: "fsn1",
    endpoint: (r) => `https://${r}.your-objectstorage.com`,
    pathStyle: false,
    regionHint: "fsn1 (Falkenstein), nbg1 (Norimberga) o hel1 (Helsinki).",
  },
  wasabi: {
    label: "Wasabi",
    region: "eu-central-1",
    endpoint: (r) => `https://s3.${r}.wasabisys.com`,
    pathStyle: false,
    regionHint: "Per esempio eu-central-1 (Amsterdam) o eu-south-1 (Milano).",
  },
  custom: {
    label: "Altro (MinIO, Garage, un tuo server)",
    region: "us-east-1",
    endpoint: () => "",
    pathStyle: true,
    regionHint: "Molti server propri accettano qualsiasi valore: us-east-1 va bene.",
  },
};

/**
 * A new place for backups to go.
 *
 * Right after saving, the destination is tested (a real file written and
 * read back), so a wrong key shows up now and not on the night it is needed.
 */
export function DestinationForm({
  isOpen,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const api = useNodeApi();
  const [kind, setKind] = useState<Kind>("s3");
  const [name, setName] = useState("");

  const [providerId, setProviderId] = useState<ProviderId>("aws");
  const provider = PROVIDERS[providerId];
  const [region, setRegion] = useState(PROVIDERS.aws.region);
  /** Null while the endpoint follows the provider and the region. */
  const [endpointTyped, setEndpointTyped] = useState<string | null>(null);
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState("");
  const [pathStyleTyped, setPathStyleTyped] = useState<"virtual" | "path" | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);

  const endpoint = endpointTyped ?? provider.endpoint(region.trim() || provider.region);
  const pathStyle = pathStyleTyped ?? (provider.pathStyle ? "path" : "virtual");

  function chooseProvider(next: ProviderId) {
    setProviderId(next);
    setRegion(PROVIDERS[next].region);
    setEndpointTyped(null);
    setPathStyleTyped(null);
  }

  const trimmedEndpoint = endpoint.trim();
  const privateHost =
    /^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(trimmedEndpoint);
  const endpointError =
    trimmedEndpoint.includes("<")
      ? "Completa l'endpoint: sostituisci la parte tra < >"
      : trimmedEndpoint && !/^https:\/\//i.test(trimmedEndpoint) && !privateHost
        ? "Serve https://, oppure http:// verso un indirizzo privato"
        : undefined;

  const incomplete =
    !name.trim() ||
    (kind === "s3" && (!trimmedEndpoint || !region.trim() || !bucket.trim() || !accessKeyId.trim() || !secretAccessKey));

  async function submit() {
    const res = await fetch(api("/api/backups/destinations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        type: kind,
        isDefault: makeDefault,
        config:
          kind === "s3"
            ? {
                endpoint: trimmedEndpoint,
                region: region.trim(),
                bucket: bucket.trim(),
                accessKeyId: accessKeyId.trim(),
                secretAccessKey,
                prefix: prefix.trim() || undefined,
                forcePathStyle: pathStyle === "path",
              }
            : {},
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.createFailed);
      throw new Error(body.error ?? "destination failed");
    }

    // Tested straight away: a wrong key or bucket is found now, by whoever
    // just typed it, rather than by the first scheduled night.
    let verdict: { ok?: boolean; message?: string } = {};
    try {
      const check = await fetch(api(`/api/backups/destinations/${body.id}`), { method: "POST" });
      verdict = await check.json();
    } catch {
      /* the destination exists; the check can be repeated from the list */
    }
    if (verdict.ok) toast.success(`«${name.trim()}» aggiunta e verificata: si può scrivere e leggere.`);
    else
      toast.warning(`«${name.trim()}» aggiunta, ma la verifica non è riuscita`, {
        description: verdict.message ?? "Controlla endpoint, bucket e chiavi, poi premi Verifica.",
      });

    setName("");
    setSecretAccessKey("");
    onCreated();
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Nuova destinazione"
      submitLabel="Aggiungi e verifica"
      isSubmitDisabled={incomplete || Boolean(endpointError)}
      onSubmit={submit}
    >
      <Segmented
        label="Tipo di destinazione"
        value={kind}
        onChange={setKind}
        options={[
          { value: "s3", label: "Archivio S3 (consigliato)" },
          { value: "local", label: "Disco di questa macchina" },
        ]}
      />

      <TextField value={name} onChange={setName}>
        <Label>Nome</Label>
        <Input placeholder={kind === "s3" ? `Bucket su ${provider.label}` : "Copia locale"} />
      </TextField>

      {kind === "local" ? (
        <FieldHint>
          Gli archivi restano su questa macchina, in <Code>data/backups</Code>. Utile come copia rapida, ma un
          backup che si perde insieme alla macchina che protegge non è un vero backup.
        </FieldHint>
      ) : (
        <>
          <SelectField
            label="Servizio"
            value={providerId}
            onChange={(value) => chooseProvider(value as ProviderId)}
            options={(Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({ value: id, label: PROVIDERS[id].label }))}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <TextField value={bucket} onChange={setBucket}>
                <Label>Bucket</Label>
                <Input placeholder="runpanel-backups" className="font-mono text-sm" />
              </TextField>
              <FieldHint>Crealo prima dal sito del servizio, vuoto e privato.</FieldHint>
            </div>
            <div>
              <TextField value={region} onChange={setRegion}>
                <Label>Regione</Label>
                <Input placeholder={provider.region} className="font-mono text-sm" />
              </TextField>
              <FieldHint>{provider.regionHint}</FieldHint>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField value={accessKeyId} onChange={setAccessKeyId}>
              <Label>Access key ID</Label>
              <Input className="font-mono text-sm" autoComplete="off" />
            </TextField>
            <TextField type="password" value={secretAccessKey} onChange={setSecretAccessKey}>
              <Label>Secret access key</Label>
              <Input className="font-mono text-sm" autoComplete="new-password" />
            </TextField>
          </div>

          {provider.note && <Hint tone="tip">{provider.note}</Hint>}

          <Advanced summary="endpoint, prefisso, indirizzamento" defaultExpanded={providerId === "custom" || providerId === "r2"}>
            <Field label="Endpoint" error={endpointError} hint="Ricavato dal servizio e dalla regione; cambialo solo se serve.">
              <TextField value={endpoint} onChange={setEndpointTyped} aria-label="Endpoint">
                <Input placeholder="https://s3.eu-central-1.amazonaws.com" className="font-mono text-sm" />
              </TextField>
            </Field>

            <div>
              <TextField value={prefix} onChange={setPrefix}>
                <Label>Prefisso</Label>
                <Input placeholder="runpanel/" className="font-mono text-sm" />
              </TextField>
              <FieldHint>Facoltativo: una cartella dentro il bucket.</FieldHint>
            </div>

            <div>
              <span className="text-muted mb-2 block text-sm font-medium">Indirizzamento</span>
              <Segmented
                label="Stile di indirizzamento"
                value={pathStyle}
                onChange={setPathStyleTyped}
                options={[
                  { value: "virtual", label: "bucket nel dominio" },
                  { value: "path", label: "bucket nel percorso" },
                ]}
              />
              <FieldHint>Già scelto per il servizio. MinIO e i server propri di solito vogliono «nel percorso».</FieldHint>
            </div>
          </Advanced>

          <Hint tone="warn" title="La chiave viene salvata cifrata">
            Con la chiave di questo pannello, come ogni altro segreto. Dai alla chiave i permessi minimi:
            lettura, scrittura ed eliminazione su questo solo bucket.
          </Hint>
        </>
      )}

      <SettingToggle
        label="Usala per i nuovi backup"
        description="Il backup notturno e le nuove pianificazioni salveranno qui."
        isSelected={makeDefault}
        onChange={setMakeDefault}
      />
    </FormDialog>
  );
}
