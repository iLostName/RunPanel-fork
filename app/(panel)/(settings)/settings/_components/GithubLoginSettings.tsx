"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyField } from "@/components/ui/CopyField";
import { Field } from "@/components/ui/Field";
import { FormError } from "@/components/ui/FormError";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { Section } from "@/components/ui/Section";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { Technical } from "@/components/ui/Technical";
import { GithubMark } from "@/components/github/GithubMark";
import { useResource } from "@/lib/hooks/useResource";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";

/**
 * Impostazioni › Generale › Accesso con GitHub: the owner's.
 *
 * A guide as much as a form, because the OAuth App lives on GitHub and the
 * owner has to make it there by hand: where to go, what to type, the exact
 * callback URL with a copy button, then the two values to bring back. Client
 * ID and secret save with the bar; "Verifica" asks GitHub whether it knows
 * them; the switch that lets people in applies at once and says so.
 *
 * Talks to this panel only (`/api/github-login`): the app names this panel's
 * address, and the GitHub links are kept per panel.
 */

interface Stranded {
  id: string;
  email: string | null;
  githubLogin: string;
}

interface GithubLoginData {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  clientId: string;
  secretSet: boolean;
  secretUnreadable: boolean;
  callbackUrl: string | null;
  suggestedCallbackUrl: string | null;
  callbackProblem: "insecure" | "invalid" | null;
  homepageUrl: string | null;
  scope: string;
  linkedUsers: number;
  passwordlessUsers: Stranded[];
  testStandIn: boolean;
}

const API = "/api/github-login";
const NEW_APP_URL = "https://github.com/settings/applications/new";

export function GithubLoginSection({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const { data, error, loading, refresh } = useResource<GithubLoginData>(API);
  const linked = data?.linkedUsers ?? 0;
  const summary = !data
    ? "Gli utenti entrano con il loro account GitHub"
    : data.enabled
      ? `Attivo · ${linked === 1 ? "1 utente collegato" : `${linked} utenti collegati`}`
      : data.configured
        ? "Configurato, ma spento: nessuno entra con GitHub"
        : "Non configurato";

  return (
    <Section title="Accesso con GitHub" summary={summary} defaultExpanded={defaultExpanded}>
      {!data && error ? (
        <LoadError what="l'accesso con GitHub" error={error} onRetry={() => void refresh()} />
      ) : loading || !data ? (
        <SkeletonBlock className="h-48" />
      ) : (
        // Keyed by what was loaded, so a save starts the form again from what the server kept.
        <GithubLoginForm key={JSON.stringify(data)} data={data} onSaved={refresh} />
      )}
    </Section>
  );
}

async function send(method: "PUT" | "POST", body: Record<string, unknown>) {
  const res = await fetch(API, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

function GithubLoginForm({ data, onSaved }: { data: GithubLoginData; onSaved: () => Promise<void> }) {
  const [clientId, setClientId] = useState(data.clientId);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<{ ok: boolean; message: string } | null>(null);
  const [toggling, setToggling] = useState(false);
  // Turning it off (or removing the app) while these users have nothing else to sign in with.
  const [stranded, setStranded] = useState<{ action: "off" | "clear"; users: Stranded[] } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const dirty = clientId.trim() !== data.clientId || secret.trim() !== "";
  const problems = {
    clientId: clientId.trim() && !/^[A-Za-z0-9._-]{8,64}$/.test(clientId.trim()) ? "Solo il Client ID: lettere, cifre, punti e trattini, senza spazi" : null,
    secret: secret.trim() && !/^[A-Za-z0-9_-]{20,128}$/.test(secret.trim()) ? "Solo il Client secret: almeno 20 tra lettere e cifre, senza spazi" : null,
  };
  const needsSecret = !data.secretSet && !secret.trim();
  const callbackChanged =
    data.configured && data.suggestedCallbackUrl !== null && data.callbackUrl !== null && data.suggestedCallbackUrl !== data.callbackUrl;

  async function save(): Promise<boolean> {
    if (!clientId.trim() || needsSecret) {
      setSaveError(needsSecret ? "Incolla anche il Client secret" : "Incolla il Client ID");
      return false;
    }
    if (problems.clientId || problems.secret) {
      setSaveError("Correggi i campi segnati");
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await send("PUT", { clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}) });
      if (!res.ok) {
        setSaveError(typeof res.data.error === "string" ? res.data.error : MSG.saveFailed);
        return false;
      }
      toast.success("App GitHub salvata: ora premi «Verifica»");
      await onSaved();
      return true;
    } catch {
      setSaveError(MSG.unreachable);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function verify() {
    setVerifying(true);
    setVerified(null);
    try {
      const res = await send("POST", { action: "verify" });
      const message = typeof res.data.message === "string" ? res.data.message : typeof res.data.error === "string" ? res.data.error : MSG.loadFailed;
      setVerified({ ok: res.ok && res.data.ok === true, message });
    } catch {
      setVerified({ ok: false, message: MSG.unreachable });
    } finally {
      setVerifying(false);
    }
  }

  async function setEnabled(next: boolean, force = false): Promise<boolean> {
    setToggling(true);
    try {
      const res = await send("PUT", { enabled: next, ...(force ? { force: true } : {}) });
      if (res.status === 409 && res.data.code === "passwordless_users" && Array.isArray(res.data.users)) {
        setStranded({ action: "off", users: res.data.users as Stranded[] });
        return false;
      }
      if (!res.ok) {
        toast.error(typeof res.data.error === "string" ? res.data.error : MSG.saveFailed);
        return false;
      }
      toast.success(next ? "Accesso con GitHub attivato" : "Accesso con GitHub spento: si entra con email e password");
      await onSaved();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setToggling(false);
    }
  }

  async function clear(force = false): Promise<boolean> {
    try {
      const res = await send("POST", { action: "clear", ...(force ? { force: true } : {}) });
      if (res.status === 409 && res.data.code === "passwordless_users" && Array.isArray(res.data.users)) {
        setStranded({ action: "clear", users: res.data.users as Stranded[] });
        return true;
      }
      if (!res.ok) {
        toast.error(typeof res.data.error === "string" ? res.data.error : MSG.removeFailed);
        return false;
      }
      toast.success("App GitHub rimossa: l'accesso con GitHub è spento");
      await onSaved();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {data.enabled ? (
          <Badge tone="success" icon="solar:check-circle-linear">
            Attivo
          </Badge>
        ) : data.configured ? (
          <Badge>Spento</Badge>
        ) : (
          <Badge>Non configurato</Badge>
        )}
        <span className="text-muted text-xs">
          Un account GitHub non crea mai un utente: ognuno collega il suo da Impostazioni › Account, oppure accetta un invito
          con GitHub.
        </span>
      </div>

      {data.testStandIn && (
        <Hint tone="warn" title="GitHub sostituito per i test">
          Il pannello parla con un sostituto locale di GitHub (<Code>RUNPANEL_TEST_GITHUB_URL</Code>). Su un pannello vero
          togli quella variabile.
        </Hint>
      )}

      {data.callbackProblem === "insecure" && (
        <Hint tone="warn" title="Prima serve HTTPS">
          Il pannello risponde su {data.homepageUrl ? <Code>{data.homepageUrl}</Code> : "http"}, senza lucchetto: GitHub
          rimanderebbe il codice di accesso in chiaro, e con lui la sessione. Metti il pannello su HTTPS (qui sopra,{" "}
          <strong className="text-foreground">Metti il pannello su HTTPS</strong>) o imposta un indirizzo pubblico https,
          poi torna qui. Per una prova su questo computer va bene <Code>http://localhost</Code>.
        </Hint>
      )}
      {data.callbackProblem === "invalid" && (
        <Hint tone="warn" title="Indirizzo del pannello sconosciuto">
          Imposta l&apos;indirizzo pubblico del pannello, qui sopra in Preferenze: da lì nasce l&apos;URL da registrare su
          GitHub.
        </Hint>
      )}

      {data.callbackUrl && (
        <>
          <ol className="text-muted list-decimal space-y-4 pl-5 text-sm">
            <li className="space-y-2">
              <p>
                Su GitHub crea un&apos;app OAuth: <strong className="text-foreground">Settings › Developer settings › OAuth Apps ›
                New OAuth App</strong>. Il nome è a tua scelta, per esempio «RunPanel».
              </p>
              <a
                href={NEW_APP_URL}
                target="_blank"
                rel="noreferrer"
                className="border-border bg-surface hover:bg-surface-hover text-foreground inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors"
              >
                <GithubMark size={15} />
                Apri GitHub
                <Icon icon="solar:arrow-right-up-linear" width={14} aria-hidden />
              </a>
            </li>
            <li className="space-y-2">
              <p>Compila i due indirizzi così, copiandoli da qui:</p>
              {data.homepageUrl && <CopyField label="Homepage URL" value={data.homepageUrl} wrap />}
              <CopyField label="Authorization callback URL" value={data.callbackUrl} wrap />
              <FieldHint className="mt-0">
                Deve essere identico, fino all&apos;ultima lettera. Lascia spento «Enable Device Flow», poi «Register
                application».
              </FieldHint>
            </li>
            <li className="space-y-2">
              <p>
                Nella pagina dell&apos;app premi <strong className="text-foreground">Generate a new client secret</strong> e
                copia qui il secret (GitHub lo mostra una volta sola) e il Client ID.
              </p>
            </li>
          </ol>

          {callbackChanged && (
            <Hint tone="warn" title="L'indirizzo del pannello è cambiato">
              Su GitHub è registrato <Code>{data.callbackUrl}</Code>, ma ora il pannello risponde su{" "}
              <Code>{data.suggestedCallbackUrl}</Code>. Aggiorna l&apos;Authorization callback URL dell&apos;app su GitHub,
              poi salva di nuovo qui.
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  isPending={saving}
                  onPress={async () => {
                    setSaving(true);
                    try {
                      const res = await send("PUT", { clientId: data.clientId });
                      if (!res.ok) toast.error(typeof res.data.error === "string" ? res.data.error : MSG.saveFailed);
                      else {
                        toast.success("Nuovo URL di callback salvato");
                        await onSaved();
                      }
                    } catch {
                      toast.error(MSG.unreachable);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Usa il nuovo indirizzo
                </Button>
              </div>
            </Hint>
          )}

          {data.secretUnreadable && (
            <Hint tone="warn" title="Il Client secret salvato non è più leggibile">
              È stato cifrato con un&apos;altra chiave del pannello, per esempio prima di un ripristino su un altro server.
              Generane uno nuovo su GitHub e incollalo qui.
            </Hint>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client ID" error={problems.clientId}>
              <TextField value={clientId} onChange={setClientId} aria-label="Client ID" isInvalid={Boolean(problems.clientId)}>
                <Input placeholder="Ov23li…" className="font-mono text-sm" autoComplete="off" spellCheck={false} />
              </TextField>
            </Field>
            <Field
              label="Client secret"
              hint={data.secretSet ? "Lascia vuoto per tenere quello salvato." : "Salvato cifrato; da qui non si rilegge più."}
              error={problems.secret}
            >
              <TextField value={secret} onChange={setSecret} type="password" aria-label="Client secret" isInvalid={Boolean(problems.secret)}>
                <Input placeholder={data.secretSet ? "••••••••  (salvato)" : ""} autoComplete="new-password" spellCheck={false} />
              </TextField>
            </Field>
          </div>

          <FormError>{saveError}</FormError>

          {data.ready && !dirty && (
            <div className="border-border space-y-2 rounded-[var(--radius)] border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-foreground text-sm">Chiedi a GitHub se riconosce l&apos;app</span>
                <Button variant="secondary" size="sm" isPending={verifying} onPress={() => void verify()}>
                  <Icon icon="solar:shield-check-linear" width={15} aria-hidden />
                  Verifica
                </Button>
              </div>
              {verified && (
                <p role="status" className={verified.ok ? "text-success text-xs" : "text-danger text-xs"}>
                  {verified.message}
                </p>
              )}
            </div>
          )}

          <SettingToggle
            label="Consenti l'accesso con GitHub"
            description={
              data.ready
                ? "Si applica subito: «Accedi con GitHub» compare nella pagina di accesso. Chi ha la verifica in due passaggi deve comunque inserire il codice."
                : "Prima salva Client ID e Client secret."
            }
            isSelected={data.enabled}
            isDisabled={toggling || dirty || (!data.ready && !data.enabled)}
            onChange={(next) => void setEnabled(next)}
          />

          {data.passwordlessUsers.length > 0 && (
            <Hint title={`${data.passwordlessUsers.length === 1 ? "Un utente entra" : `${data.passwordlessUsers.length} utenti entrano`} solo con GitHub`}>
              Non hanno una password: se spegni l&apos;accesso con GitHub resterebbero fuori. Ognuno può impostarla dalla
              sua pagina Account, oppure gli mandi un link da Team › Utenti. {strandedNames(data.passwordlessUsers)}
            </Hint>
          )}

          <Technical>
            <FieldHint>
              Scope <Code>{data.scope}</Code> · Authorization Code con <Code>state</Code> legato a un cookie e PKCE S256 ·
              il token di GitHub serve una volta a leggere id e nome utente, poi viene revocato e non è salvato · il
              collegamento usa l&apos;id numerico di GitHub, non il nome né l&apos;email.
            </FieldHint>
          </Technical>

          {data.configured && (
            <Button variant="ghost" size="sm" className="text-danger" onPress={() => setConfirmClear(true)}>
              Rimuovi l&apos;app GitHub
            </Button>
          )}
        </>
      )}

      <StickySaveBar
        isDirty={dirty}
        isPending={saving}
        onSave={() => void save()}
        onReset={() => {
          setClientId(data.clientId);
          setSecret("");
          setSaveError(null);
        }}
        message="Accesso con GitHub: modifiche non salvate"
      />

      <ConfirmDialog
        isOpen={confirmClear}
        onOpenChange={setConfirmClear}
        title="Rimuovere l'app GitHub?"
        description="Nessuno potrà più entrare con GitHub finché non ne configuri un'altra. Gli account collegati restano collegati, e tornano a funzionare con una nuova app."
        confirmLabel="Rimuovi"
        destructive
        onConfirm={() => clear()}
      />

      <ConfirmDialog
        isOpen={stranded !== null}
        onOpenChange={(open) => !open && setStranded(null)}
        title={stranded?.action === "clear" ? "Rimuovere comunque l'app GitHub?" : "Spegnere comunque l'accesso con GitHub?"}
        description={
          <div className="space-y-2">
            <p>Questi utenti entrano solo con GitHub e non hanno una password: resterebbero fuori.</p>
            <ul className="list-disc pl-5">
              {(stranded?.users ?? []).map((user) => (
                <li key={user.id}>
                  {user.email ?? "senza email"} <span className="font-mono text-xs">(@{user.githubLogin})</span>
                </li>
              ))}
            </ul>
            <p>
              Meglio prima mandare a ognuno un link per scegliere una password, da Team › Utenti. Riaccendendo
              l&apos;accesso con GitHub potranno rientrare.
            </p>
          </div>
        }
        confirmLabel={stranded?.action === "clear" ? "Rimuovi comunque" : "Spegni comunque"}
        destructive
        onConfirm={() => (stranded?.action === "clear" ? clear(true) : setEnabled(false, true))}
      />
    </div>
  );
}

/** "a@x.it (@a), b@x.it (@b)": up to three, then how many more. */
function strandedNames(users: readonly Stranded[]): string {
  const named = users.slice(0, 3).map((user) => `${user.email ?? "senza email"} (@${user.githubLogin})`);
  const more = users.length - named.length;
  return `${named.join(", ")}${more > 0 ? ` e altri ${more}` : ""}.`;
}
