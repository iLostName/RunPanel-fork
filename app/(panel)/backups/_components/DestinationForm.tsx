"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { FormDialog } from "@/components/ui/FormDialog";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { Field } from "@/components/ui/Field";
import { Advanced, Technical } from "@/components/ui/Technical";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { MSG } from "@/lib/copy";
import { useNode, useNodeApi } from "@/lib/hooks/useNode";
import { PROVIDERS, PROVIDER_IDS, detectProvider, type ProviderId } from "./providers";
import { TelegramFields, type TelegramChoice, type TelegramDetail } from "./TelegramFields";

type Kind = "local" | "s3" | "telegram";

/** What `GET /api/backups/destinations/:id` returns: everything but the secret. */
export interface DestinationDetail {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
  config: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    prefix: string;
    forcePathStyle: boolean;
    hasSecret: boolean;
  } | null;
  /** Absent from a server on an older version. */
  telegram?: TelegramDetail | null;
}

interface CheckResult {
  ok?: boolean;
  warning?: boolean;
  message?: string;
  code?: string;
  detail?: string | null;
}

/** What a check found, as a toast: the same words after creating and after editing. */
function announceCheck(name: string, verdict: CheckResult, done: string) {
  if (verdict.ok && verdict.warning) {
    toast.warning(`«${name}» ${done}, con un limite`, { description: verdict.message });
  } else if (verdict.ok) {
    toast.success(`«${name}» ${done}: verificata, si può scrivere e rileggere.`);
  } else {
    toast.warning(`«${name}» ${done} senza una verifica riuscita`, {
      description: verdict.message ?? "Controlla endpoint, bucket e chiavi, poi premi Verifica.",
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
 * Telegram is checked the other way round: the login already proved the
 * account works, and its channel does not exist until the destination is
 * saved, so the server creates it, checks it and answers with the verdict.
 *
 * Editing never shows the stored secret: the field stays empty, and empty
 * means "keep the one you have". The type cannot change, because an archive's
 * path means one thing on a disk and another in a bucket.
 */
export function DestinationForm({
  isOpen,
  onOpenChange,
  onSaved,
  editing,
  archives = 0,
  canSetDefault = true,
  apiFor,
  memberId,
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
  /** The server the destination lives on, when it is not the one the page is about. */
  apiFor?: (path: string) => string;
  /** That server's id, for the backup password a Telegram destination suggests setting. */
  memberId?: string | null;
}) {
  const nodeApi = useNodeApi();
  const { selected } = useNode();
  const api = apiFor ?? nodeApi;
  const stored = editing?.config ?? null;
  const initialProvider: ProviderId = stored ? detectProvider(stored.endpoint) : "aws";

  const [kind, setKind] = useState<Kind>(
    editing ? (editing.type === "local" ? "local" : editing.type === "telegram" ? "telegram" : "s3") : "s3"
  );
  const [name, setName] = useState(editing?.name ?? "");
  const [telegram, setTelegram] = useState<TelegramChoice>({ linked: null, chat: "channel", channelTitle: "" });

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
    // A new Telegram destination needs a linked account and, for a channel, its name.
    (kind === "telegram" &&
      !editing &&
      (!telegram.linked || (telegram.chat === "channel" && !telegram.channelTitle.trim())));

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

  /** What was checked, so a failure stops counting as soon as a field changes. */
  const signature = JSON.stringify([kind, kind === "s3" ? s3Config() : null]);

  /** Tried with exactly what the form holds, before anything is stored. */
  async function precheck(): Promise<CheckResult> {
    try {
      const res = await fetch(api("/api/backups/destinations/check"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: kind,
          config: kind === "s3" ? s3Config() : {},
          ...(editing ? { destinationId: editing.id } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      return res.ok ? (body as CheckResult) : { ok: false, message: body.error ?? "Verifica non riuscita" };
    } catch {
      return { ok: false, message: MSG.unreachable };
    }
  }

  /**
   * Telegram: the session is on the server, named by the login id. Creating
   * makes the channel and answers with the check run on it; editing renames,
   * and with a new login re-links the account, then checks.
   */
  async function submitTelegram() {
    const res = editing
      ? await fetch(api(`/api/backups/destinations/${editing.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            ...(telegram.linked ? { config: { loginId: telegram.linked.loginId } } : {}),
          }),
        })
      : await fetch(api("/api/backups/destinations"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            type: "telegram",
            isDefault: canSetDefault && makeDefault,
            config: {
              loginId: telegram.linked?.loginId,
              chat: telegram.chat,
              ...(telegram.chat === "channel" ? { channelTitle: telegram.channelTitle.trim() } : {}),
            },
          }),
        });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? (editing ? MSG.saveFailed : MSG.createFailed));
      throw new Error(body.error ?? "destination failed");
    }
    if (body.check) announceCheck(name.trim(), body.check as CheckResult, editing ? "ricollegata" : "aggiunta");
    else toast.success(`«${name.trim()}» salvata.`);
    onSaved();
  }

  async function submit() {
    if (kind === "telegram") return submitTelegram();

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

    const res = editing
      ? await fetch(api(`/api/backups/destinations/${editing.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), ...(kind === "s3" ? { config: s3Config() } : {}) }),
        })
      : await fetch(api("/api/backups/destinations"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            type: kind,
            isDefault: canSetDefault && makeDefault,
            config: kind === "s3" ? { ...s3Config(), prefix: prefix.trim() || undefined } : {},
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
      submitLabel={
        kind === "telegram"
          ? editing
            ? telegram.linked
              ? "Salva e verifica"
              : "Salva"
            : "Aggiungi e verifica"
          : showFailure
            ? "Salva comunque"
            : editing
              ? "Verifica e salva"
              : "Verifica e aggiungi"
      }
      isSubmitDisabled={incomplete || Boolean(kind === "s3" && endpointError)}
      // Room for the QR code beside its instructions, and the two chats side by side.
      wide={kind === "telegram"}
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
        <Segmented
          label="Tipo di destinazione"
          value={kind}
          onChange={setKind}
          options={[
            { value: "s3", label: "Archivio S3 (consigliato)" },
            { value: "telegram", label: "Telegram" },
            { value: "local", label: "Disco di questo server" },
          ]}
        />
      )}

      <TextField value={name} onChange={setName}>
        <Label>Nome</Label>
        <Input placeholder={kind === "s3" ? provider.label : kind === "telegram" ? "Telegram" : "Copia locale"} />
      </TextField>

      {kind === "local" ? (
        <FieldHint>
          Gli archivi restano su questo server, in <Code>data/backups</Code>. Utile come copia rapida, ma un
          backup che si perde insieme al server che protegge non è un vero backup.
        </FieldHint>
      ) : kind === "telegram" ? (
        <TelegramFields
          api={api}
          memberId={memberId ?? selected}
          editing={editing ? { destinationId: editing.id, detail: editing.telegram ?? null } : undefined}
          value={telegram}
          onChange={setTelegram}
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
