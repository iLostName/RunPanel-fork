"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { KeyValue } from "@/components/ui/KeyValue";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { GithubMark } from "@/components/github/GithubMark";
import { startGithubFlow } from "@/components/github/GithubSignIn";
import { LinkButton } from "@/components/ui/LinkButton";
import { useMe } from "@/lib/hooks/useMe";
import { useNode } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";
import { githubResultMessage } from "@/lib/github-login-messages";
import { formatRelative, formatWhen } from "@/lib/format";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";

/**
 * "Accesso con GitHub" on the account page: the GitHub account this user may
 * sign in with, linking one, unlinking it.
 *
 * Linking asks for the password first, then goes to GitHub and comes back here
 * (`?github=linked`, or the code of what went wrong). An account that signs in
 * only with GitHub cannot unlink: it would have no way back in. Shown where
 * sign-in with GitHub is set up, or where a link exists, so it can be seen and
 * removed after the owner turned GitHub off; to the owner otherwise, as the
 * way to the settings that set it up.
 */

interface Status {
  available: boolean;
  linked: { login: string; linkedAt: string; lastUsedAt: string | null } | null;
  hasPassword: boolean;
}

const API = "/api/auth/github";

/** `?github=` of the address the page was opened at; read once, in the browser. */
function readResult(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("github");
}

export function GithubLoginPanel({ onChanged }: { onChanged?: () => void }) {
  const status = useResource<Status>(API);
  const me = useMe();
  const { isSolo } = useNode();
  const [arrival] = useState(readResult);
  // What went wrong on the way back from GitHub. Drawn only once the status
  // has loaded, which is after hydration.
  const [notice, setNotice] = useState<string | null>(() => (arrival === "linked" ? null : githubResultMessage(arrival)));
  const [linking, setLinking] = useState<number | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (!arrival || handled.current) return;
    handled.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("github");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (arrival === "linked") toast.success("Account GitHub collegato: d'ora in poi puoi entrare anche con GitHub");
  }, [arrival]);

  const s = status.data;
  if (s && !s.available && !s.linked) {
    // Nothing to link to. The owner is the one who could change that, and is told where.
    if (!me.isOwner) return null;
    return (
      <Panel className="space-y-3">
        <PanelHeader title="Accesso con GitHub" description="Non è attivo su questo pannello" actions={<Badge>Spento</Badge>} />
        <p className="text-muted text-sm">
          Gli utenti possono entrare con il loro account GitHub, oltre che con la password. Si configura una volta, per
          tutto il pannello.
        </p>
        <div>
          <LinkButton href="/settings?open=github-login" variant="secondary">
            <GithubMark size={15} />
            Configura l&apos;accesso con GitHub
          </LinkButton>
        </div>
      </Panel>
    );
  }

  async function unlink(): Promise<boolean> {
    try {
      const res = await fetch(API, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Scollegamento non riuscito");
        return false;
      }
      toast.success("Account GitHub scollegato: entri con email e password");
      await status.refresh();
      onChanged?.();
      return true;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  return (
    <Panel className="space-y-4">
      <PanelHeader
        title="Accesso con GitHub"
        description="Entrare con il tuo account GitHub invece che con la password"
        actions={
          s ? (
            s.linked ? (
              <Badge tone="success" icon="solar:link-linear">
                Collegato
              </Badge>
            ) : (
              <Badge>Non collegato</Badge>
            )
          ) : undefined
        }
      />

      {status.error && !s ? (
        <LoadError what="l'accesso con GitHub" error={status.error} onRetry={() => void status.refresh()} />
      ) : !s ? (
        <SkeletonBlock className="h-16" />
      ) : (
        <>
          {notice && (
            <Hint tone="warn" title="Collegamento non riuscito">
              {notice}
            </Hint>
          )}

          {s.linked ? (
            <>
              <KeyValue
                items={[
                  {
                    label: "Account",
                    value: (
                      <span className="inline-flex items-center gap-1.5">
                        <GithubMark size={14} />@{s.linked.login}
                      </span>
                    ),
                  },
                  { label: "Collegato", value: <span title={formatWhen(s.linked.linkedAt)}>{formatRelative(s.linked.linkedAt)}</span> },
                  {
                    label: "Ultimo accesso con GitHub",
                    value: s.linked.lastUsedAt ? <span title={formatWhen(s.linked.lastUsedAt)}>{formatRelative(s.linked.lastUsedAt)}</span> : "mai",
                  },
                ]}
              />
              {!s.available && (
                <Hint>
                  Il proprietario ha spento l&apos;accesso con GitHub: per ora entri con email e password.
                </Hint>
              )}
              {s.hasPassword ? (
                <div>
                  <Button variant="ghost" size="sm" className="text-danger" onPress={() => setConfirmUnlink(true)}>
                    Scollega GitHub
                  </Button>
                </div>
              ) : (
                <FieldHint>
                  Entri solo con GitHub: per scollegarlo imposta prima una password, qui sopra.
                </FieldHint>
              )}
            </>
          ) : (
            <>
              <p className="text-muted text-sm">
                Collega il tuo account GitHub e potrai entrare con «Accedi con GitHub». La password resta valida, e la
                verifica in due passaggi, se è attiva, viene chiesta lo stesso.
              </p>
              <div>
                <Button variant="secondary" size="sm" onPress={() => setLinking(Date.now())}>
                  <GithubMark size={15} />
                  Collega GitHub
                </Button>
              </div>
            </>
          )}
          {!isSolo && <FieldHint>Vale solo per questo server: sugli altri pannelli del cluster si collega a parte.</FieldHint>}
        </>
      )}

      {linking !== null && <LinkDialog key={linking} onClose={() => setLinking(null)} onFailed={() => setNotice(null)} />}

      <ConfirmDialog
        isOpen={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Scollegare l'account GitHub?"
        description={`Non potrai più entrare con @${s?.linked?.login ?? "GitHub"}: entrerai con email e password. Puoi ricollegarlo quando vuoi.`}
        confirmLabel="Scollega"
        destructive
        onConfirm={unlink}
      />
    </Panel>
  );
}

/** The password again, then off to GitHub. */
function LinkDialog({ onClose, onFailed }: { onClose: () => void; onFailed: () => void }) {
  const [password, setPassword] = useState("");

  return (
    <FormDialog
      isOpen
      onOpenChange={(isOpen) => !isOpen && onClose()}
      title="Collega il tuo account GitHub"
      description="Prima conferma che sei tu, con la password di questo account. Poi GitHub ti chiederà di autorizzare RunPanel e tornerai qui."
      submitLabel="Continua su GitHub"
      isSubmitDisabled={!password}
      onSubmit={async () => {
        const result = await startGithubFlow({ intent: "link", password });
        if (!result.ok) {
          onFailed();
          toast.error(result.url ? `${result.error} (${result.url})` : result.error);
          return false;
        }
        // The browser is on its way to GitHub: stay pending until it has left.
        await new Promise(() => undefined);
      }}
    >
      <TextField type="password" value={password} onChange={setPassword} autoFocus>
        <Label>Password</Label>
        <Input autoComplete="current-password" />
      </TextField>
    </FormDialog>
  );
}
