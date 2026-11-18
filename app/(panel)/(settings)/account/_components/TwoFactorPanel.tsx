"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyField } from "@/components/ui/CopyField";
import { FormDialog } from "@/components/ui/FormDialog";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { KeyValue } from "@/components/ui/KeyValue";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Technical } from "@/components/ui/Technical";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { useMe } from "@/lib/hooks/useMe";
import { useNode } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";
import { formatWhen } from "@/lib/format";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { QrCode } from "@/components/ui/QrCode";
import { RecoveryCodes } from "./RecoveryCodes";

/**
 * "Verifica in due passaggi" on the account page: the state, and the dialogs
 * that change it. Every change goes through `/api/auth/two-factor`, which asks
 * for the password again (and, to turn it off, for a code too).
 */

interface Status {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  rememberedDevices: number;
  seedUnreadable: boolean;
}

interface Setup {
  secret: string;
  uri: string;
  issuer: string;
  account: string;
}

const API = "/api/auth/two-factor";

/** POST an action; the body on success, null after saying what went wrong. */
async function send(body: Record<string, unknown>, failure: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error || failure);
      return null;
    }
    return data;
  } catch {
    toast.error(MSG.unreachable);
    return null;
  }
}

export function TwoFactorPanel() {
  const me = useMe();
  const { isSolo } = useNode();
  const status = useResource<Status>(API);
  // A fresh key per opening, so a dialog never starts on the step it was left at.
  const [dialog, setDialog] = useState<{ kind: "setup" | "disable" | "codes"; key: number } | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const open = (kind: "setup" | "disable" | "codes") => setDialog({ kind, key: Date.now() });
  const close = () => setDialog(null);
  const s = status.data;

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Verifica in due passaggi"
        description="Oltre alla password, un codice dal telefono a ogni accesso"
        actions={
          s ? (
            s.enabled ? (
              <Badge tone="success" icon="solar:shield-check-linear">
                Attiva
              </Badge>
            ) : (
              <Badge>Non attiva</Badge>
            )
          ) : undefined
        }
      />

      {status.error && !s ? (
        <LoadError what="la verifica in due passaggi" error={status.error} onRetry={() => void status.refresh()} />
      ) : !s ? (
        <SkeletonBlock className="h-20" />
      ) : s.enabled ? (
        <>
          {s.seedUnreadable && (
            <Hint tone="warn" title="Il pannello non riesce più a controllare i codici dell'app">
              La chiave segreta del pannello è cambiata, per esempio dopo un ripristino su un altro server. Entra con un
              codice di recupero, poi disattiva e riattiva la verifica.
            </Hint>
          )}
          <KeyValue
            items={[
              { label: "Attiva dal", value: s.enabledAt ? formatWhen(s.enabledAt) : "—" },
              { label: "Codici di recupero", value: `${s.recoveryCodesLeft} di 10 ancora validi` },
              {
                label: "Dispositivi ricordati",
                value: s.rememberedDevices === 0 ? "nessuno" : `${s.rememberedDevices}, per 30 giorni dall'accesso`,
              },
            ]}
          />
          {s.recoveryCodesLeft <= 3 && (
            <Hint tone="warn">
              {s.recoveryCodesLeft === 0
                ? "Non hai più codici di recupero: se perdi il telefono non potrai entrare. Generane di nuovi."
                : `Ti restano solo ${s.recoveryCodesLeft} codici di recupero: generane di nuovi.`}
            </Hint>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onPress={() => open("codes")}>
              <Icon icon="solar:key-linear" width={15} aria-hidden />
              Nuovi codici di recupero
            </Button>
            {s.rememberedDevices > 0 && (
              <Button variant="secondary" size="sm" onPress={() => setForgetting(true)}>
                <Icon icon="solar:smartphone-linear" width={15} aria-hidden />
                Dimentica i dispositivi ricordati
              </Button>
            )}
            <Button variant="ghost" size="sm" className="text-danger" onPress={() => open("disable")}>
              Disattiva
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted text-sm">
            Per entrare servirà anche il codice di 6 cifre che un&apos;app sul telefono cambia ogni 30 secondi: chi scopre
            la tua password, da sola, non entra.
          </p>
          <div>
            <Button variant="primary" size="sm" onPress={() => open("setup")}>
              <Icon icon="solar:shield-keyhole-linear" width={15} aria-hidden />
              Attiva
            </Button>
          </div>
        </>
      )}

      {s && (
        <FieldHint>
          {me.isOwner ? (
            <>
              Se perdi telefono e codici di recupero, dal terminale del server puoi sempre rientrare con{" "}
              <Code>node scripts/reset-owner.mjs</Code>.
            </>
          ) : (
            "Se perdi telefono e codici di recupero, chiedi a chi gestisce gli utenti di azzerarla."
          )}
          {!isSolo && " Vale solo per questo server: sugli altri pannelli del cluster si attiva a parte."}
        </FieldHint>
      )}
      <Technical>
        <FieldHint>TOTP (RFC 6238) · HMAC-SHA-1 · 6 cifre · periodo di 30 s · tolleranza ±1 periodo · ogni codice vale una volta.</FieldHint>
      </Technical>

      {dialog?.kind === "setup" && (
        <SetupDialog key={dialog.key} account={me.email ?? ""} onClose={close} onEnabled={() => void status.refresh()} />
      )}
      {dialog?.kind === "codes" && (
        <NewCodesDialog key={dialog.key} account={me.email ?? ""} onClose={close} onDone={() => void status.refresh()} />
      )}
      {dialog?.kind === "disable" && <DisableDialog key={dialog.key} onClose={close} onDone={() => void status.refresh()} />}

      <ConfirmDialog
        isOpen={forgetting}
        onOpenChange={setForgetting}
        title="Dimenticare i dispositivi ricordati?"
        description="Da ogni browser che avevi fatto ricordare servirà di nuovo il codice dell'app al prossimo accesso. Le sessioni aperte restano."
        confirmLabel="Dimentica"
        onConfirm={async () => {
          const data = await send({ action: "forget-devices" }, "Operazione non riuscita");
          if (!data) return false;
          toast.success("Dispositivi dimenticati: al prossimo accesso servirà il codice");
          await status.refresh();
          return true;
        }}
      />
    </Panel>
  );
}

/** The key spelled in groups of four, for typing it into an app by hand; the copy is without spaces. */
function SecretKey({ secret }: { secret: string }) {
  const { copied, copy } = useClipboard();
  return (
    <div className="border-border bg-surface-secondary flex items-center gap-2 rounded-[var(--radius)] border px-3 py-2">
      <code className="text-foreground min-w-0 flex-1 font-mono text-sm tracking-wide break-all">
        {secret.match(/.{1,4}/g)?.join(" ")}
      </code>
      <button
        type="button"
        onClick={() => void copy(secret)}
        className="text-muted hover:text-foreground rounded p-1 transition-colors"
        aria-label="Copia la chiave"
      >
        <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} />
      </button>
    </div>
  );
}

/** Password, then scan and first code, then the recovery codes. */
function SetupDialog({ account, onClose, onEnabled }: { account: string; onClose: () => void; onEnabled: () => void }) {
  const [step, setStep] = useState<"password" | "scan" | "codes">("password");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  async function submit(): Promise<boolean> {
    if (step === "password") {
      const data = await send({ action: "setup", password }, "Attivazione non riuscita");
      if (!data) return false;
      setPassword("");
      setSetup(data as unknown as Setup);
      setStep("scan");
      return false;
    }
    if (step === "scan") {
      const data = await send({ action: "enable", code: code.trim() }, "Attivazione non riuscita");
      if (!data) return false;
      setCodes(data.recoveryCodes as string[]);
      setStep("codes");
      onEnabled();
      toast.success("Verifica in due passaggi attivata");
      return false;
    }
    return true;
  }

  return (
    <FormDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={
        step === "password"
          ? "Attiva la verifica in due passaggi"
          : step === "scan"
            ? "Collega l'app di autenticazione"
            : "Salva i codici di recupero"
      }
      description={
        step === "password"
          ? "Prima conferma che sei tu, con la password di questo account."
          : step === "scan"
            ? "Un'app sul telefono genererà i codici: Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden o un'altra."
            : undefined
      }
      submitLabel={step === "password" ? "Continua" : step === "scan" ? "Attiva" : "Fatto"}
      cancelLabel={step === "codes" ? "Chiudi" : "Annulla"}
      isSubmitDisabled={step === "password" ? !password : step === "scan" ? code.replace(/\s/g, "").length !== 6 : !saved}
      wide={step === "scan"}
      onSubmit={submit}
    >
      {step === "password" && (
        <TextField type="password" value={password} onChange={setPassword} autoFocus>
          <Label>Password</Label>
          <Input autoComplete="current-password" />
        </TextField>
      )}

      {step === "scan" && setup && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <div className="border-border shrink-0 rounded-[var(--radius)] border bg-white p-1">
              <QrCode value={setup.uri} label="Codice QR da inquadrare con l'app di autenticazione" />
            </div>
            <ol className="text-muted list-decimal space-y-1.5 pl-5 text-sm">
              <li>Apri l&apos;app sul telefono e scegli di aggiungere un account.</li>
              <li>Inquadra il codice QR.</li>
              <li>Scrivi qui sotto le 6 cifre che compaiono per RunPanel.</li>
            </ol>
          </div>
          <div className="space-y-1.5">
            <span className="text-muted text-xs font-medium">Non riesci a inquadrarlo? Inserisci questa chiave a mano</span>
            <SecretKey secret={setup.secret} />
          </div>
          <Technical>
            <CopyField label="URI otpauth" value={setup.uri} />
            <FieldHint>
              Etichetta «{setup.issuer}: {setup.account}», TOTP con SHA-1, 6 cifre, periodo di 30 secondi.
            </FieldHint>
          </Technical>
          <TextField value={code} onChange={setCode} autoFocus>
            <Label>Codice dell&apos;app</Label>
            <Input inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" maxLength={7} className="font-mono tracking-widest" />
          </TextField>
          <FieldHint>Serve a controllare che il telefono generi i codici giusti: fino ad allora la verifica non è attiva.</FieldHint>
        </div>
      )}

      {step === "codes" && <RecoveryCodes codes={codes} account={account} saved={saved} onSavedChange={setSaved} />}
    </FormDialog>
  );
}

/** Password, then ten fresh codes; the old ones stop working. */
function NewCodesDialog({ account, onClose, onDone }: { account: string; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(): Promise<boolean> {
    if (codes) return true;
    const data = await send({ action: "recovery-codes", password }, "Generazione non riuscita");
    if (!data) return false;
    setPassword("");
    setCodes(data.recoveryCodes as string[]);
    onDone();
    toast.success("Nuovi codici di recupero creati: i precedenti non valgono più");
    return false;
  }

  return (
    <FormDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title={codes ? "Salva i nuovi codici di recupero" : "Nuovi codici di recupero"}
      description={codes ? undefined : "Ne vengono creati 10 nuovi e tutti quelli di prima smettono di valere, anche se non li hai usati."}
      submitLabel={codes ? "Fatto" : "Crea i codici"}
      cancelLabel={codes ? "Chiudi" : "Annulla"}
      isSubmitDisabled={codes ? !saved : !password}
      onSubmit={submit}
    >
      {codes ? (
        <RecoveryCodes codes={codes} account={account} saved={saved} onSavedChange={setSaved} />
      ) : (
        <TextField type="password" value={password} onChange={setPassword} autoFocus>
          <Label>Password</Label>
          <Input autoComplete="current-password" />
        </TextField>
      )}
    </FormDialog>
  );
}

/** Password and a code: a session alone is not enough to take the second factor away. */
function DisableDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  return (
    <FormDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title="Disattivare la verifica in due passaggi?"
      description="Per entrare tornerà a bastare la password. I codici di recupero e i dispositivi ricordati vengono cancellati."
      submitLabel="Disattiva"
      destructive
      isSubmitDisabled={!password || !code.trim()}
      onSubmit={async () => {
        const data = await send({ action: "disable", password, code: code.trim() }, "Disattivazione non riuscita");
        if (!data) return false;
        toast.success("Verifica in due passaggi disattivata");
        onDone();
        return true;
      }}
    >
      <TextField type="password" value={password} onChange={setPassword} autoFocus>
        <Label>Password</Label>
        <Input autoComplete="current-password" />
      </TextField>
      <div>
        <TextField value={code} onChange={setCode}>
          <Label>Codice dell&apos;app o codice di recupero</Label>
          <Input autoComplete="one-time-code" placeholder="123 456" className="font-mono" />
        </TextField>
        <FieldHint>Senza il telefono va bene anche uno dei codici di recupero.</FieldHint>
      </div>
    </FormDialog>
  );
}
