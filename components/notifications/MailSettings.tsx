"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Field } from "@/components/ui/Field";
import { FormError } from "@/components/ui/FormError";
import { Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { Advanced } from "@/components/ui/Technical";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useResource } from "@/lib/hooks/useResource";
import { useMe } from "@/lib/hooks/useMe";
import { useNodeApi } from "@/lib/hooks/useNode";
import { EMAIL_PATTERN } from "@/lib/notify-channels";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";

type Security = "starttls" | "tls" | "none";

interface MailConfig {
  configured: boolean;
  host: string;
  port: number;
  security: Security;
  username: string;
  from: string;
  allowInvalidCert: boolean;
  passwordSet: boolean;
  passwordUnreadable: boolean;
}

type ProviderId = "gmail" | "outlook" | "m365" | "icloud" | "aruba" | "brevo" | "mailgun" | "custom";

/**
 * The providers people actually use, with what each one wants. Picking one
 * fills host, port and security; the address and the password stay theirs.
 */
const PROVIDERS: Record<ProviderId, { label: string; host: string; port: number; security: Security; note?: string }> = {
  gmail: {
    label: "Gmail",
    host: "smtp.gmail.com",
    port: 587,
    security: "starttls",
    note: "Serve una «password per le app» (Account Google › Sicurezza › Verifica in due passaggi › Password per le app), non quella dell'account.",
  },
  outlook: { label: "Outlook.com / Hotmail", host: "smtp-mail.outlook.com", port: 587, security: "starttls" },
  m365: { label: "Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls", note: "L'amministratore deve aver attivato «SMTP AUTH» per questa casella." },
  icloud: { label: "iCloud", host: "smtp.mail.me.com", port: 587, security: "starttls", note: "Serve una password specifica per le app, da appleid.apple.com." },
  aruba: { label: "Aruba", host: "smtps.aruba.it", port: 465, security: "tls" },
  brevo: { label: "Brevo", host: "smtp-relay.brevo.com", port: 587, security: "starttls", note: "Utente e password sono quelli SMTP del tuo account Brevo, non quelli di accesso." },
  mailgun: { label: "Mailgun", host: "smtp.mailgun.org", port: 587, security: "starttls" },
  custom: { label: "Altro server", host: "", port: 587, security: "starttls" },
};

function providerOf(host: string): ProviderId {
  const found = (Object.keys(PROVIDERS) as ProviderId[]).find((id) => id !== "custom" && PROVIDERS[id].host === host);
  return found ?? "custom";
}

const DEFAULT_PORT: Record<Security, number> = { starttls: 587, tls: 465, none: 25 };

/**
 * The panel's mail server, for its owner.
 *
 * Email channels send through it, and so will invitations and password resets
 * — which is why it is configured once, here, and is the owner's alone. Saved
 * with the bar that appears on the first change; the password is write-only.
 */
export function MailSettings() {
  const api = useNodeApi();
  const me = useMe();
  const { data, loading, error, refresh } = useResource<MailConfig>(api("/api/mail"));
  if (!data && error) return <LoadError what="il server di posta" error={error} onRetry={() => void refresh()} />;
  if (loading || !data) return <SkeletonBlock className="h-40" />;
  // Keyed by what was loaded, so a save or a reset starts the form again from it.
  return <MailForm key={JSON.stringify(data)} data={data} ownerEmail={me.email} onSaved={refresh} />;
}

function MailForm({ data, ownerEmail, onSaved }: { data: MailConfig; ownerEmail: string | null; onSaved: () => Promise<void> }) {
  const api = useNodeApi();
  const [provider, setProvider] = useState<ProviderId>(data.configured ? providerOf(data.host) : "gmail");
  const [host, setHost] = useState(data.configured ? data.host : PROVIDERS.gmail.host);
  const [port, setPort] = useState(String(data.configured ? data.port : PROVIDERS.gmail.port));
  const [security, setSecurity] = useState<Security>(data.configured ? data.security : PROVIDERS.gmail.security);
  const [username, setUsername] = useState(data.username);
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState(data.from);
  const [allowInvalidCert, setAllowInvalidCert] = useState(data.allowInvalidCert);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testTo, setTestTo] = useState(ownerEmail ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const initial = {
    host: data.configured ? data.host : PROVIDERS.gmail.host,
    port: String(data.configured ? data.port : PROVIDERS.gmail.port),
    security: data.configured ? data.security : PROVIDERS.gmail.security,
  };
  const dirty =
    host !== initial.host ||
    port !== initial.port ||
    security !== initial.security ||
    username !== data.username ||
    password !== "" ||
    from !== data.from ||
    allowInvalidCert !== data.allowInvalidCert ||
    (!data.configured && Boolean(username || from));

  const portNumber = Number(port);
  const fromAddress = /<([^>]+)>\s*$/.exec(from)?.[1] ?? from;
  const problems = {
    host: host.trim() && /[:/\s]/.test(host.trim()) ? "Solo il nome del server, per esempio smtp.esempio.it: senza smtp:// e senza porta" : null,
    port: !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535 ? "Una porta da 1 a 65535" : null,
    from: from.trim() && !EMAIL_PATTERN.test(fromAddress.trim()) ? "Un indirizzo email, oppure Nome <indirizzo@esempio.it>" : null,
    password: username.trim() && !password && !data.passwordSet ? "Con un nome utente serve anche la password" : null,
  };
  const incomplete = !host.trim() || !from.trim();
  const invalid = Object.values(problems).some(Boolean);
  const note = PROVIDERS[provider].note;

  function chooseProvider(next: ProviderId) {
    setProvider(next);
    if (next !== "custom") {
      setHost(PROVIDERS[next].host);
      setPort(String(PROVIDERS[next].port));
      setSecurity(PROVIDERS[next].security);
    }
  }

  function chooseSecurity(next: Security) {
    // Follow the port only while it is one of the usual ones; a port typed by
    // hand is somebody's reason, and is left alone.
    if (Object.values(DEFAULT_PORT).includes(Number(port))) setPort(String(DEFAULT_PORT[next]));
    setSecurity(next);
  }

  async function save() {
    if (incomplete || invalid) {
      setSaveError(incomplete ? "Compila server e mittente" : "Correggi i campi segnati");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(api("/api/mail"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: host.trim(),
          port: portNumber,
          security,
          username: username.trim(),
          ...(password ? { password } : {}),
          from: from.trim(),
          allowInvalidCert,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSaveError(body.error ?? MSG.saveFailed);
        return;
      }
      toast.success("Server di posta salvato");
      await onSaved();
    } catch {
      setSaveError(MSG.unreachable);
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(api("/api/mail"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", to: testTo.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setTestResult(res.ok ? { ok: Boolean(body.ok), error: body.error } : { ok: false, error: body.error ?? MSG.loadFailed });
    } catch {
      setTestResult({ ok: false, error: MSG.unreachable });
    } finally {
      setTesting(false);
    }
  }

  async function clear() {
    const res = await fetch(api("/api/mail"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    });
    if (!res.ok) {
      toast.error(MSG.removeFailed);
      return false;
    }
    toast.success("Server di posta rimosso");
    await onSaved();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {data.configured ? <Badge tone="success" icon="solar:check-circle-linear">Configurato</Badge> : <Badge>Non configurato</Badge>}
        <span className="text-muted text-xs">
          Serve per le notifiche via email, e in futuro per inviti e recupero della password.
        </span>
      </div>

      {data.passwordUnreadable && (
        <Hint tone="warn" title="La password salvata non è più leggibile">
          È stata cifrata con un&apos;altra chiave del pannello. Inseriscila di nuovo e salva.
        </Hint>
      )}

      <SelectField
        label="Servizio"
        value={provider}
        onChange={chooseProvider}
        options={(Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({ value: id, label: PROVIDERS[id].label }))}
      />
      {note && <Hint tone="tip">{note}</Hint>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Utente" hint="Di solito il tuo indirizzo email. Vuoto se il server non chiede di accedere.">
          <TextField value={username} onChange={setUsername} aria-label="Utente">
            <Input placeholder="avvisi@esempio.it" autoComplete="off" spellCheck={false} />
          </TextField>
        </Field>
        <Field
          label="Password"
          hint={data.passwordSet ? "Lascia vuoto per tenere quella salvata." : "Salvata cifrata; da qui non si rilegge più."}
          error={problems.password}
        >
          <TextField value={password} onChange={setPassword} type="password" aria-label="Password" isInvalid={Boolean(problems.password)}>
            <Input placeholder={data.passwordSet ? "••••••••  (configurata)" : ""} autoComplete="new-password" />
          </TextField>
        </Field>
      </div>

      <Field
        label="Mittente"
        hint="Chi appare come mittente: un indirizzo, oppure Nome <indirizzo>. Molti servizi accettano solo il tuo indirizzo."
        error={problems.from}
      >
        <TextField value={from} onChange={setFrom} aria-label="Mittente" isInvalid={Boolean(problems.from)}>
          <Input placeholder="RunPanel <avvisi@esempio.it>" spellCheck={false} />
        </TextField>
      </Field>

      <Advanced summary="server, porta, sicurezza, certificati" defaultExpanded={provider === "custom" ? true : undefined}>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field label="Server SMTP" error={problems.host}>
            <TextField
              value={host}
              onChange={(next) => {
                setHost(next);
                setProvider(providerOf(next.trim()));
              }}
              aria-label="Server SMTP"
              isInvalid={Boolean(problems.host)}
            >
              <Input placeholder="smtp.esempio.it" className="font-mono text-sm" spellCheck={false} />
            </TextField>
          </Field>
          <Field label="Porta" error={problems.port}>
            <TextField value={port} onChange={setPort} aria-label="Porta" isInvalid={Boolean(problems.port)}>
              <Input inputMode="numeric" className="font-mono text-sm" />
            </TextField>
          </Field>
        </div>
        <div>
          <span className="text-foreground mb-2 block text-sm">Connessione cifrata</span>
          <Segmented
            label="Connessione cifrata"
            value={security}
            onChange={chooseSecurity}
            options={[
              { value: "starttls", label: "STARTTLS (587)" },
              { value: "tls", label: "TLS (465)" },
              { value: "none", label: "Nessuna" },
            ]}
          />
          <p className="text-muted text-meta mt-1.5 leading-relaxed">
            {security === "none"
              ? "Solo per un server di posta dentro la tua rete: password e messaggi viaggiano in chiaro."
              : "Se la prova dice che la connessione cifrata non corrisponde alla porta, prova l'altra opzione."}
          </p>
        </div>
        <SettingToggle
          label="Accetta certificati non verificati"
          description="Solo per un server interno con un certificato tuo. Su internet lascialo spento: chiunque in mezzo potrebbe leggere la password."
          isSelected={allowInvalidCert}
          onChange={setAllowInvalidCert}
        />
      </Advanced>

      {data.configured && !dirty && (
        <div className="border-border space-y-2 rounded-[var(--radius)] border p-3">
          <span className="text-foreground block text-sm">Invia un&apos;email di prova</span>
          <div className="flex flex-wrap items-start gap-2">
            <TextField value={testTo} onChange={setTestTo} aria-label="Destinatario della prova" className="min-w-0 flex-1">
              <Input placeholder="tu@esempio.it" spellCheck={false} />
            </TextField>
            <Button variant="secondary" isPending={testing} isDisabled={!EMAIL_PATTERN.test(testTo.trim())} onPress={() => void sendTest()}>
              <Icon icon="solar:plain-linear" width={15} aria-hidden />
              Invia una prova
            </Button>
          </div>
          {testResult?.ok && <p className="text-success text-xs">Inviata: controlla la casella (e lo spam).</p>}
          <FormError>{testResult && !testResult.ok ? (testResult.error ?? "Invio non riuscito") : null}</FormError>
        </div>
      )}

      {data.configured && (
        <Button variant="ghost" size="sm" className="text-danger" onPress={() => setConfirmClear(true)}>
          Rimuovi il server di posta
        </Button>
      )}

      <FormError>{saveError}</FormError>

      <StickySaveBar
        isDirty={dirty}
        isPending={saving}
        onSave={() => void save()}
        onReset={() => {
          setProvider(data.configured ? providerOf(data.host) : "gmail");
          setHost(initial.host);
          setPort(initial.port);
          setSecurity(initial.security);
          setUsername(data.username);
          setPassword("");
          setFrom(data.from);
          setAllowInvalidCert(data.allowInvalidCert);
          setSaveError(null);
        }}
        message="Server di posta: modifiche non salvate"
      />

      <ConfirmDialog
        isOpen={confirmClear}
        onOpenChange={setConfirmClear}
        title="Rimuovere il server di posta?"
        description="Le notifiche via email smettono di partire finché non ne configuri un altro. I canali email restano."
        confirmLabel="Rimuovi"
        destructive
        onConfirm={clear}
      />
    </div>
  );
}
