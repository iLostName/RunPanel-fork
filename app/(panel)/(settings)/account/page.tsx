"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { Hint } from "@/components/ui/Hint";
import { ThemeModePicker } from "@/components/ui/ThemeModePicker";
import { ExpertModeToggle } from "@/components/ui/ExpertModeToggle";
import { SessionList } from "@/components/ui/SessionList";
import { PushSection } from "@/components/notifications/PushSettings";
import { GithubMark } from "@/components/github/GithubMark";
import { startGithubFlow } from "@/components/github/GithubSignIn";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import { TwoFactorPanel } from "./_components/TwoFactorPanel";
import { GithubLoginPanel } from "./_components/GithubLoginPanel";

/**
 * Yours: how you sign in (password, GitHub and the second step), where you are
 * signed in, how the panel looks in this browser. What the panel does for
 * everyone lives in the Pannello tab (`/settings`), which used to be the
 * bottom half of this page.
 *
 * An account that accepted its invitation with GitHub has no password until
 * it chooses one here. Until then the email and the second step, which both
 * ask for the password, wait for it.
 */
export default function AccountPage() {
  const me = useMe();
  // `?open=push` comes from the bell, the Notifiche page and the channels list.
  const openSection = useSearchParams()?.get("open") ?? null;
  const account = useResource<{ hasPassword: boolean }>("/api/account");
  // Unknown while loading: read as having one, which is what almost every account has.
  const hasPassword = account.data?.hasPassword ?? true;
  const [email, setEmail] = useState(me.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // A first password asked for too long after signing in: GitHub again, then back here.
  const [reauth, setReauth] = useState(false);
  const [reauthPending, setReauthPending] = useState(false);

  async function changeEmail() {
    setEmailSaving(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), currentPassword: emailPassword }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(d.error || "Cambio email non riuscito");
        return;
      }
      toast.success("Email aggiornata: usala dal prossimo accesso");
      setEmailPassword("");
    } catch {
      toast.error("Cambio email non riuscito");
    } finally {
      setEmailSaving(false);
    }
  }

  async function changePassword() {
    if (newPassword !== confirmPassword) {
      toast.error("Le due password non coincidono");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("La password deve avere almeno 8 caratteri");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hasPassword ? { currentPassword, newPassword } : { newPassword }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        if (d.code === "reauth_required") setReauth(true);
        toast.error(d.error || "Cambio password non riuscito");
        return;
      }
      toast.success(hasPassword ? "Password cambiata" : "Password impostata: ora puoi entrare anche con email e password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setReauth(false);
      await account.refresh();
    } catch {
      toast.error("Cambio password non riuscito");
    } finally {
      setLoading(false);
    }
  }

  async function signInAgain() {
    setReauthPending(true);
    const result = await startGithubFlow({ intent: "login", next: "/account" });
    if (!result.ok) {
      setReauthPending(false);
      toast.error(result.error);
    }
  }

  return (
    <>
      <PageHeader
        title="Account"
        description="Accesso, dispositivi e aspetto"
      />

      <div className="max-w-3xl space-y-4">
        <Panel className="space-y-4">
          <PanelHeader
            title="Email di accesso"
            description={me.isOwner ? "Sei il proprietario del pannello" : "Il nome con cui entri nel pannello"}
          />
          <TextField type="email" value={email} onChange={setEmail} isDisabled={!hasPassword}>
            <Label>Email</Label>
            <Input autoComplete="username" />
          </TextField>
          {hasPassword ? (
            <>
              <TextField type="password" value={emailPassword} onChange={setEmailPassword}>
                <Label>Password attuale</Label>
                <Input autoComplete="current-password" />
              </TextField>
              <div>
                <Button
                  variant="secondary"
                  isPending={emailSaving}
                  isDisabled={!email.trim() || email.trim() === me.email || !emailPassword}
                  onPress={changeEmail}
                >
                  Cambia email
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted text-sm">Per cambiare email imposta prima una password, qui sotto.</p>
          )}
        </Panel>

        {hasPassword ? (
          <Panel className="space-y-4">
            <PanelHeader
              title="Cambia password"
              description="Le altre sessioni vengono chiuse, questa resta"
            />
            <TextField type="password" value={currentPassword} onChange={setCurrentPassword}>
              <Label>Password attuale</Label>
              <Input autoComplete="current-password" />
            </TextField>
            <TextField type="password" value={newPassword} onChange={setNewPassword}>
              <Label>Nuova password</Label>
              <Input autoComplete="new-password" />
            </TextField>
            <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
              <Label>Conferma la nuova password</Label>
              <Input autoComplete="new-password" />
            </TextField>
            <div>
              <Button variant="primary" isPending={loading} onPress={changePassword}>
                Cambia password
              </Button>
            </div>
          </Panel>
        ) : (
          <Panel className="space-y-4">
            <PanelHeader title="Imposta una password" description="Oggi entri solo con GitHub" />
            <Hint tone="warn" title="Senza password dipendi da GitHub">
              Se il proprietario spegne l&apos;accesso con GitHub, o il tuo account GitHub non è disponibile, non potresti
              entrare. Con una password entri anche con email e password, e puoi attivare la verifica in due passaggi.
            </Hint>
            {reauth && (
              <Hint
                title="Prima entra di nuovo con GitHub"
                icon="solar:shield-keyhole-linear"
              >
                Per sicurezza la prima password si sceglie entro dieci minuti da un accesso: chi trovasse aperta una tua
                sessione non potrebbe sceglierla al posto tuo.
                <div className="mt-2">
                  <Button variant="secondary" size="sm" isPending={reauthPending} onPress={() => void signInAgain()}>
                    <GithubMark size={15} />
                    Entra di nuovo con GitHub
                  </Button>
                </div>
              </Hint>
            )}
            <TextField type="password" value={newPassword} onChange={setNewPassword}>
              <Label>Nuova password</Label>
              <Input autoComplete="new-password" />
            </TextField>
            <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
              <Label>Conferma la password</Label>
              <Input autoComplete="new-password" />
            </TextField>
            <div>
              <Button variant="primary" isPending={loading} onPress={changePassword}>
                Imposta la password
              </Button>
            </div>
          </Panel>
        )}

        <GithubLoginPanel onChanged={() => void account.refresh()} />

        <TwoFactorPanel hasPassword={hasPassword} />

        <Section title="Dispositivi" summary="Dove sei entrato con questo account">
          <SessionList />
        </Section>

        <PushSection defaultExpanded={openSection === "push"} />

        <Section title="Aspetto" summary="Tema, e quanti dettagli tecnici vedere" defaultExpanded>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Tema</p>
              <p className="text-muted text-xs">Vale solo per questo browser.</p>
            </div>
            <ThemeModePicker />
          </div>
          <ExpertModeToggle />
        </Section>
      </div>
    </>
  );
}
