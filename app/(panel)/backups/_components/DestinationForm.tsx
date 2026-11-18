"use client";

import { useCallback, useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { FormDialog } from "@/components/ui/FormDialog";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Field } from "@/components/ui/Field";
import { Advanced, Technical } from "@/components/ui/Technical";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { MSG } from "@/lib/copy";
import { useNodeApi } from "@/lib/hooks/useNode";
import { PROVIDERS, PROVIDER_IDS, detectProvider, type ProviderId } from "./providers";
import { REMOTE_KINDS, remoteKind } from "./destinations/kinds";
import type { KindState } from "./destinations/types";

/** `local`, `s3`, or one of the remote kinds in destinations/kinds.ts. */
type Kind = string;

/** An S3 destination as the edit form gets it: everything but the secret. */
interface S3Detail {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  prefix: string;
  forcePathStyle: boolean;
  hasSecret: boolean;
}

/** What `GET /api/backups/destinations/:id` returns: everything but the secrets. */
export interface DestinationDetail {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  /** S3's fields for S3, the remote kind's own view (kinds.ts on the server) for the others, null for the local disk. */
  config: S3Detail | Record<string, unknown> | null;
}

interface CheckResult {
  ok?: boolean;
  warning?: boolean;
  message?: string;
  code?: string;
  detail?: string | null;
  /** What the check learned and the destination keeps: an SFTP server's host key. */
  learned?: Record<string, string>;
}

/** What a check found, as a toast: the same words after creating and after editing. */
function announceCheck(name: string, verdict: CheckResult, done: string) {
  if (verdict.ok && verdict.warning) {
    toast.warning(`«${name}» ${done}, con un limite`, { description: verdict.message });
  } else if (verdict.ok) {
    toast.success(`«${name}» ${done}: verificata, si può scrivere e rileggere.`);
  } else {
    toast.warning(`«${name}» ${done} senza una verifica riuscita`, {
      description: verdict.message ?? "Controlla i dati della destinazione, poi premi Verifica.",
    });
  }
}

/**
 * A place for backups to go: a new one, or one being edited.
 *
 * Before saving, what the form holds is tried for real (a file written, read
 * back and deleted), so a wrong key shows up now and not on the night it is
 * needed — after an edit as much as when creating. A failed check saves
 * nothing and says why; "Salva comunque" is there for a bucket that is
 * deliberately unreachable from here today.
 *
 * Editing never shows the stored secret: the field stays empty, and empty
 * means "keep the one you have". The type cannot change, because an archive's
 * path means one thing on a disk and another in a bucket.
 *
 * The local disk and S3 are laid out here; every other type brings its own
 * fields (destinations/kinds.ts) and reports its config and whether it is
 * complete, and goes through the same check and save as S3. What a check
 * learns — an SFTP server's host key on first contact — is saved with it.
 */
export function DestinationForm({
  isOpen,
  onOpenChange,
  onSaved,
  editing,
  archives = 0,
  canSetDefault = true,
  isOwner = canSetDefault,
  apiFor,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  /** Absent when creating. */
  editing?: DestinationDetail;
  /** Archives already stored in the destination being edited. */
  archives?: number;
  /** Only the owner chooses where the safety copies go. */
  canSetDefault?: boolean;
  /** Only the owner pastes an rclone configuration. */
  isOwner?: boolean;
  /** The server the destination lives on, when it is not the one the page is about. */
  apiFor?: (path: string) => string;
}) {
  const nodeApi = useNodeApi();
  const api = apiFor ?? nodeApi;
  const stored = editing?.type === "s3" ? ((editing.config as S3Detail | null) ?? null) : null;
  const initialProvider: ProviderId = stored ? detectProvider(stored.endpoint) : "aws";

  const [kind, setKind] = useState<Kind>(editing ? editing.type : "s3");
  const [name, setName] = useState(editing?.name ?? "");
  /** What a remote kind's fields last reported, tagged with the kind, so a switch never reuses another's. */
  const [remote, setRemote] = useState<{ kind: Kind; state: KindState } | null>(null);
  const remoteEntry = remoteKind(kind);
  const remoteState = remote && remote.kind === kind ? remote.state : null;
  const report = useCallback((state: KindState) => setRemote({ kind, state }), [kind]);

  const [providerId, setProviderId] = useState<ProviderId>(initialProvider);
  const provider = PROVIDERS[providerId];
  const [region, setRegion] = useState(stored?.region ?? PROVIDERS.aws.region);
  /** Null while the endpoint follows the provider and the region. */
  const [endpointTyped, setEndpointTyped] = useState<string | null>(() => {
    if (!stored) return null;
    // A stored endpoint the provider would have produced keeps following the
    // region; anything else was typed by hand and stays as it is.
    return PROVIDERS[initialProvider].endpoint(stored.region) === stored.endpoint ? null : stored.endpoint;
  });
  const [bucket, setBucket] = useState(stored?.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState(stored?.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [prefix, setPrefix] = useState(stored?.prefix ?? "");
  const [pathStyleTyped, setPathStyleTyped] = useState<"virtual" | "path" | null>(() => {
    if (!stored) return null;
    return stored.forcePathStyle === PROVIDERS[initialProvider].pathStyle ? null : stored.forcePathStyle ? "path" : "virtual";
  });
  const [makeDefault, setMakeDefault] = useState(canSetDefault);
  /** The last check that failed, and what it was run on. */
  const [failedCheck, setFailedCheck] = useState<{ signature: string; verdict: CheckResult } | null>(null);

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

  const needsSecret = !editing || !stored?.hasSecret;
  const incomplete =
    !name.trim() ||
    (kind === "s3" &&
      (!trimmedEndpoint || !region.trim() || !bucket.trim() || !accessKeyId.trim() || (needsSecret && !secretAccessKey))) ||
    (remoteEntry !== null && !remoteState?.complete);

  // Where the archives already stored here would be looked for after the edit.
  const movesArchives =
    Boolean(stored) &&
    archives > 0 &&
    (trimmedEndpoint !== stored?.endpoint ||
      bucket.trim() !== stored?.bucket ||
      prefix.trim().replace(/^\/+|\/+$/g, "") !== (stored?.prefix ?? "").replace(/^\/+|\/+$/g, ""));

  const s3Config = () => ({
    endpoint: trimmedEndpoint,
    region: region.trim(),
    bucket: bucket.trim(),
    accessKeyId: accessKeyId.trim(),
    // Empty while editing means "keep the stored one"; the server merges.
    ...(secretAccessKey ? { secretAccessKey } : {}),
    prefix: prefix.trim(),
    forcePathStyle: pathStyle === "path",
  });

  /** The config of whichever type is chosen, as the API takes it. */
  const kindConfig = (): Record<string, unknown> =>
    kind === "s3" ? s3Config() : remoteEntry ? (remoteState?.config ?? {}) : {};

  /** What was checked, so a failure stops counting as soon as a field changes. */
  const signature = JSON.stringify([kind, kind === "local" ? null : kindConfig()]);

  /** Tried with exactly what the form holds, before anything is stored. */
  async function precheck(): Promise<CheckResult> {
    try {
      const res = await fetch(api("/api/backups/destinations/check"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: kind,
          config: kindConfig(),
          ...(editing ? { destinationId: editing.id } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      return res.ok ? (body as CheckResult) : { ok: false, message: body.error ?? "Verifica non riuscita" };
    } catch {
      return { ok: false, message: MSG.unreachable };
    }
  }

  async function submit() {
    // A wrong key or bucket is found now, by whoever just typed it, rather
    // than by the first scheduled night — and before it is saved, so a typo
    // never becomes a destination the nightly can pick.
    const saveAnyway = failedCheck?.signature === signature;
    let verdict: CheckResult = failedCheck?.verdict ?? {};
    if (!saveAnyway) {
      verdict = await precheck();
      if (!verdict.ok) {
        setFailedCheck({ signature, verdict });
        throw new Error("check failed");
      }
    }

    // A remote kind keeps what the check learned — an SFTP server's host key,
    // trusted on this first contact and pinned from now on.
    const remoteConfig = remoteEntry ? { ...(remoteState?.config ?? {}), ...(verdict.learned ?? {}) } : null;
    const res = editing
      ? await fetch(api(`/api/backups/destinations/${editing.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            ...(kind === "s3" ? { config: s3Config() } : remoteConfig ? { config: remoteConfig } : {}),
          }),
        })
      : await fetch(api("/api/backups/destinations"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            type: kind,
            isDefault: canSetDefault && makeDefault,
            config: kind === "s3" ? { ...s3Config(), prefix: prefix.trim() || undefined } : (remoteConfig ?? {}),
          }),
        });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? (editing ? MSG.saveFailed : MSG.createFailed));
      throw new Error(body.error ?? "destination failed");
    }

    announceCheck(name.trim(), verdict, editing ? "salvata" : "aggiunta");
    setSecretAccessKey("");
    onSaved();
  }

  const showFailure = failedCheck?.signature === signature ? failedCheck.verdict : null;

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={editing ? `Modifica «${editing.name}»` : "Nuova destinazione"}
      submitLabel={showFailure ? "Salva comunque" : editing ? "Verifica e salva" : "Verifica e aggiungi"}
      isSubmitDisabled={incomplete || Boolean(kind === "s3" && endpointError)}
      // The type cards side by side, and the longer forms of the remote types.
      wide={!editing || Boolean(remoteEntry)}
      onSubmit={submit}
    >
      {showFailure && (
        <Hint tone="warn" title="La verifica non è riuscita: niente è stato salvato">
          <p>{showFailure.message}</p>
          <Technical>
            {showFailure.detail && (
              <p className="mt-1 font-mono text-meta">
                {showFailure.code ? `${showFailure.code} · ` : ""}
                {showFailure.detail}
              </p>
            )}
          </Technical>
          <p className="mt-1">Correggi e riprova, oppure salva comunque e verifica più tardi dalla lista.</p>
        </Hint>
      )}

      {!editing && (
        <ChoiceGroup label="Tipo di destinazione">
          <div className="grid gap-2 sm:grid-cols-2">
            <ChoiceCard
              selected={kind === "s3"}
              onSelect={() => setKind("s3")}
              icon="solar:cloud-storage-linear"
              title="Archivio S3 (consigliato)"
              description="Amazon S3, Cloudflare R2, Backblaze B2, MinIO."
            />
            {REMOTE_KINDS.map((entry) => (
              <ChoiceCard
                key={entry.type}
                selected={kind === entry.type}
                onSelect={() => setKind(entry.type)}
                icon={entry.icon}
                title={entry.label}
                description={entry.description}
              />
            ))}
            <ChoiceCard
              selected={kind === "local"}
              onSelect={() => setKind("local")}
              icon="solar:server-linear"
              title="Disco di questo server"
              description="Una copia rapida, che però si perde con il server."
            />
          </div>
        </ChoiceGroup>
      )}

      <TextField value={name} onChange={setName}>
        <Label>Nome</Label>
        <Input placeholder={kind === "s3" ? provider.label : remoteEntry ? remoteEntry.label : "Copia locale"} />
      </TextField>

      {kind === "local" ? (
        <FieldHint>
          Gli archivi restano su questo server, in <Code>data/backups</Code>. Utile come copia rapida, ma un
          backup che si perde insieme al server che protegge non è un vero backup.
        </FieldHint>
      ) : remoteEntry ? (
        // Keyed by type: switching starts the next type's fields from scratch.
        <remoteEntry.Fields
          key={remoteEntry.type}
          stored={editing && editing.type === remoteEntry.type ? (editing.config as Record<string, unknown> | null) : null}
          api={api}
          isOwner={isOwner}
          archives={archives}
          onChange={report}
        />
      ) : (
        <>
          <SelectField
            label="Servizio"
            value={providerId}
            onChange={(value) => chooseProvider(value as ProviderId)}
            options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label }))}
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
            <div>
              <TextField type="password" value={secretAccessKey} onChange={setSecretAccessKey}>
                <Label>Secret access key</Label>
                <Input
                  className="font-mono text-sm"
                  autoComplete="new-password"
                  placeholder={needsSecret ? undefined : "invariata"}
                />
              </TextField>
              {!needsSecret && <FieldHint>Lasciala vuota per tenere quella salvata.</FieldHint>}
            </div>
          </div>

          {provider.note && <Hint tone="tip">{provider.note}</Hint>}

          <Advanced
            summary="endpoint, prefisso, indirizzamento"
            defaultExpanded={providerId === "custom" || providerId === "r2" || endpointTyped !== null || undefined}
          >
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

          {movesArchives && (
            <Hint tone="warn" title={`Qui ci sono già ${archives} archivi`}>
              Il pannello li cercherà nel nuovo bucket, endpoint o prefisso. Se non li sposti anche tu, non potrai
              più ripristinarli da qui. Cambiare solo le chiavi o la regione non tocca niente.
            </Hint>
          )}

          <Hint tone="warn" title="La chiave viene salvata cifrata">
            Con la chiave di questo pannello, come ogni altro segreto. Dai alla chiave i permessi minimi:
            lettura, scrittura ed eliminazione su questo solo bucket.
          </Hint>
        </>
      )}

      {!editing && canSetDefault && (
        <SettingToggle
          label="Usala per i nuovi backup"
          description="Il backup notturno, le nuove pianificazioni e il backup di sicurezza dei ripristini salveranno qui."
          isSelected={makeDefault}
          onChange={setMakeDefault}
        />
      )}
    </FormDialog>
  );
}
