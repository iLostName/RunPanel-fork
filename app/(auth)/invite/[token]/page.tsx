"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { Panel } from "@/components/ui/Panel";
import { FieldHint } from "@/components/ui/Hint";
import { GithubButton, OrDivider, startGithubFlow } from "@/components/github/GithubSignIn";
import { githubResultMessage } from "@/lib/github-login-messages";

type State =
  | { phase: "loading" }
  | { phase: "invalid"; message: string }
  | { phase: "ready"; email: string; kind: "invite" | "reset"; github: boolean };

/**
 * Where an invitation or reset link lands: choose a password, then straight
 * into the panel. The link works once and expires; past that, it says so and
 * points back at whoever sent it.
 *
 * Where the owner has set up sign-in with GitHub, an invitation (never a reset
 * link) can be accepted with GitHub instead: the person's GitHub account is
 * linked to this one and becomes how they sign in. A return from GitHub that
 * went wrong lands back here (`?github=<code>`), so another way can be tried.
 */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  // A failed return from GitHub, read once from the address: only the spinner is drawn until the link is checked.
  const [githubError, setGithubError] = useState<string | null>(() =>
    typeof window === "undefined" ? null : githubResultMessage(new URLSearchParams(window.location.search).get("github"))
  );
  const [githubElsewhere, setGithubElsewhere] = useState<string | null>(null);
  const [githubPending, setGithubPending] = useState(false);
  const cleaned = useRef(false);

  useEffect(() => {
    // Off the address bar, so a reload does not show the old error again.
    if (cleaned.current) return;
    cleaned.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has("github")) {
      url.searchParams.delete("github");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/auth/invite?token=${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setState({ phase: "invalid", message: data.error || "Link non valido o scaduto." });
        else setState({ phase: "ready", email: data.email, kind: data.kind === "reset" ? "reset" : "invite", github: data.github === true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ phase: "invalid", message: "Impossibile raggiungere il pannello." });
      });
    return () => controller.abort();
  }, [token]);

  async function save() {
    if (password.length < 8) {
      toast.error("La password deve avere almeno 8 caratteri");
      return;
    }
    if (password !== confirm) {
      toast.error("Le due password non coincidono");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Non è stato possibile impostare la password");
        return;
      }
      // With two-step sign-in on, a link sets the password but does not sign
      // in: the code is still asked for, on the sign-in page.
      if (data.signedIn === false) {
        toast.success("Password impostata. Ora accedi con la nuova password e il codice dell'app.");
        router.push("/login");
        return;
      }
      router.push("/home");
    } catch {
      toast.error("Impossibile raggiungere il pannello");
    } finally {
      setSaving(false);
    }
  }

  async function acceptWithGithub() {
    setGithubError(null);
    setGithubElsewhere(null);
    setGithubPending(true);
    const result = await startGithubFlow({ intent: "invite", token });
    // On success the browser is already on its way to GitHub.
    if (!result.ok) {
      setGithubPending(false);
      setGithubError(result.error);
      // This same invitation, on the address GitHub knows.
      setGithubElsewhere(result.url ? new URL(window.location.pathname, result.url).toString() : null);
    }
  }

  if (state.phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const offerGithub = state.phase === "ready" && state.kind === "invite" && state.github;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Panel className="w-full max-w-md space-y-5 p-6 sm:p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <Icon
            icon={state.phase === "invalid" ? "solar:danger-triangle-linear" : "solar:key-linear"}
            className={state.phase === "invalid" ? "text-warning" : "text-accent"}
            width={44}
            aria-hidden
          />
          <h1 className="text-foreground text-xl font-semibold tracking-tight">
            {state.phase === "invalid"
              ? "Link non più valido"
              : state.kind === "reset"
                ? "Scegli una nuova password"
                : "Benvenuto su RunPanel"}
          </h1>
          <p className="text-muted text-sm">
            {state.phase === "invalid" ? (
              <>{state.message} Chiedi a chi ti ha invitato di generarne uno nuovo.</>
            ) : (
              <>
                Account <strong className="text-foreground">{state.email}</strong>
              </>
            )}
          </p>
        </div>

        {state.phase === "ready" && (
          <>
            <div className="space-y-4">
              <div>
                <TextField type="password" value={password} onChange={setPassword} autoFocus>
                  <Label>Password</Label>
                  <Input autoComplete="new-password" />
                </TextField>
                <FieldHint>Almeno 8 caratteri. Il link funziona una volta sola.</FieldHint>
              </div>
              <TextField type="password" value={confirm} onChange={setConfirm}>
                <Label>Conferma password</Label>
                <Input
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") save();
                  }}
                />
              </TextField>
            </div>
            <Button variant="primary" className="w-full" isPending={saving} isDisabled={githubPending} onPress={save}>
              {state.kind === "reset" ? "Salva la password" : "Crea l'account"}
            </Button>
          </>
        )}

        {(offerGithub || (githubError && state.phase === "ready")) && (
          <div className="space-y-3">
            {offerGithub && (
              <>
                <OrDivider />
                <GithubButton isPending={githubPending} isDisabled={saving} onPress={() => void acceptWithGithub()}>
                  Accedi con GitHub
                </GithubButton>
              </>
            )}
            {/* Under the button it is about: what went wrong on the way back from GitHub. */}
            {githubError && (
              <p role="alert" className="text-danger text-sm">
                {githubError}
                {githubElsewhere && (
                  <>
                    {" "}
                    <a href={githubElsewhere} className="text-accent font-medium hover:underline">
                      Apri il pannello da lì
                    </a>
                  </>
                )}
              </p>
            )}
            {offerGithub && (
              <FieldHint className="mt-0 text-center">
                Senza password: il tuo account GitHub viene collegato a questo, ed entrerai con quello. Potrai aggiungere
                una password dalla pagina Account.
              </FieldHint>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
