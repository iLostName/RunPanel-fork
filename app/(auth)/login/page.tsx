"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { TextField, Label, Input, Button, Spinner } from "@heroui/react";
import Image from "next/image";
import logo from "@/components/logo.svg";
import { Panel } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { GithubButton, OrDivider, startGithubFlow } from "@/components/github/GithubSignIn";
import { isLoopbackHost } from "@/lib/cookie-security";
import { githubResultMessage } from "@/lib/github-login-messages";
import { safeNextPath } from "@/lib/safe-path";
import { MSG } from "@/lib/copy";

const noSubscription = () => () => {};

/**
 * Plain http on an address other than this machine's own: the password and the
 * session travel unencrypted. Read from `location`, which the server cannot
 * see; false on the server so the first render matches.
 */
function useInsecureConnection(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.protocol === "http:" && !isLoopbackHost(window.location.hostname),
    () => false
  );
}
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SecondStep } from "./SecondStep";

/**
 * The first screen the operator ever sees, and the one that was entirely in
 * English in an otherwise Italian panel.
 *
 * It also carried the only `shadow-2xl` in the app, against a token layer whose
 * own comment says depth comes from the surface steps and the border — "flat by
 * default" being most of the difference between minimal and dated. A login card
 * is exactly where that temptation shows up, and exactly where it looks least
 * like the rest of the product.
 *
 * On a first run there are two ways to set the panel up: create the owner, or
 * link this install to a RunPanel that already exists and inherit its
 * accounts. A managed node of a cluster shows neither: it has no sign-in of
 * its own and points at the panels that have.
 *
 * "Accedi con GitHub" appears once the owner has set it up (Impostazioni ›
 * Generale). The return from GitHub lands back here as `?github=continue`,
 * and this page finishes the sign-in — asking for the code, as after a
 * password, when the account has two-step sign-in — or as `?github=<error>`,
 * which reads as one of a fixed set of sentences (lib/github-login-messages.ts).
 */

type SetupMode = "owner" | "link";
type LinkRole = "panel" | "node";

interface Check {
  authenticated: boolean;
  firstRun: boolean;
  emailRequired: boolean;
  role: "panel" | "node" | null;
  /** Sign-in with GitHub is set up and on. */
  github?: boolean;
  managedBy?: { name: string; url: string }[];
  /** Only on a first run: where the token is (lib/setup-hint.ts). */
  setupHint?: { runner: "pinned" | "systemd" | "docker" | "pm2" | "console"; command: string | null };
}

/** Where the setup token is, said for how this panel was started. */
function SetupTokenHelp({ hint }: { hint?: Check["setupHint"] }) {
  if (hint?.runner === "pinned") {
    return <>È il valore di <Code>RUNPANEL_SETUP_TOKEN</Code>, impostato da chi ha installato il pannello.</>;
  }
  if (hint?.command) {
    return (
      <>
        Lo trovi nel log del pannello, dopo <Code>Not set up yet</Code>. Sul server esegui{" "}
        <Code>{hint.command}</Code>. Ne viene generato uno nuovo a ogni riavvio.
      </>
    );
  }
  return (
    <>
      È scritto nel terminale dove hai avviato il pannello, dopo <Code>Not set up yet</Code>. Ne viene generato
      uno nuovo a ogni riavvio, a meno di fissarlo con <Code>RUNPANEL_SETUP_TOKEN</Code>.
    </>
  );
}

/**
 * `?github=` and `?next=` of the address this page was opened at. `next` only
 * when it is a page of the panel (lib/safe-path.ts): it is followed after the
 * sign-in, and anyone can write a link to this page.
 */
function readArrival(): { github: string | null; next: string | null } {
  if (typeof window === "undefined") return { github: null, next: null };
  const params = new URLSearchParams(window.location.search);
  return { github: params.get("github"), next: safeNextPath(params.get("next")) };
}

const ROLE_OPTIONS = [
  { value: "panel" as const, label: "Pannello", description: "Anche questo server mostra l'interfaccia e gestisce gli altri" },
  { value: "node" as const, label: "Solo nodo", description: "Nessun accesso qui: si gestisce dai pannelli del cluster" },
];

export default function LoginPage() {
  const router = useRouter();
  const insecure = useInsecureConnection();
  const [check, setCheck] = useState<Check | null>(null);
  const [mode, setMode] = useState<SetupMode>("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [panelUrl, setPanelUrl] = useState("");
  const [linkToken, setLinkToken] = useState("");
  const [serverName, setServerName] = useState("");
  // Prefilled with the address this page was opened at: the form is only
  // rendered after the first-run check, so there is nothing to hydrate against.
  const [serverUrl, setServerUrl] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));
  const [role, setRole] = useState<LinkRole>("panel");
  const [loading, setLoading] = useState(false);
  // How this page was reached, read once before the first render in the
  // browser. Like the address above, nothing is hydrated against it: only the
  // spinner is drawn until the check is back.
  const [arrival] = useState(readArrival);
  // Shown under the fields rather than only as a toast: a toast is gone before
  // you have looked back at what you typed. A return from GitHub that went
  // wrong starts with its sentence here.
  const [error, setError] = useState<string | null>(() => githubResultMessage(arrival.github));
  const [linkedAs, setLinkedAs] = useState<LinkRole | null>(null);
  // Set once the password was right and the account asks for a code.
  const [challenge, setChallenge] = useState<string | null>(null);
  // Where to go once in: a page of the panel the link asked for, or the overview.
  const nextPath = arrival.next;
  // The code step began with GitHub rather than the password: when it expires,
  // starting again means GitHub, not email and password.
  const [viaGithub, setViaGithub] = useState(false);
  const [githubPending, setGithubPending] = useState(false);
  const [githubFinishing, setGithubFinishing] = useState(arrival.github === "continue");
  // The panel's own address, when GitHub only knows that one and the browser is on another.
  const [githubElsewhere, setGithubElsewhere] = useState<string | null>(null);
  const githubHandled = useRef(false);

  const isFirstRun = check?.firstRun ?? null;

  useEffect(() => {
    fetch("/api/auth/check")
      .then((r) => r.json())
      .then((data: Check) => {
        if (data.authenticated) {
          router.push(data.emailRequired ? "/setup-email" : "/home");
        }
        setCheck(data);
      })
      .catch(() => setCheck({ authenticated: false, firstRun: false, emailRequired: false, role: null }));
  }, [router]);

  // Back from GitHub. Taken off the address bar at once: a reload must neither
  // finish the same sign-in twice nor show an old error again. The ref keeps a
  // second run of the effect (development's double mount) from spending the
  // sign-in a second time.
  useEffect(() => {
    if (!arrival.github || githubHandled.current) return;
    githubHandled.current = true;
    const clean = new URL(window.location.href);
    clean.searchParams.delete("github");
    window.history.replaceState(null, "", `${clean.pathname}${clean.search}${clean.hash}`);
    if (arrival.github !== "continue") return;

    fetch("/api/auth/github/continue", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.twoFactorRequired) {
          setViaGithub(true);
          setChallenge(String(data.challenge));
        } else if (res.ok) {
          // Leaving: the spinner stays until the next page is drawn.
          router.replace(data.emailRequired ? "/setup-email" : (arrival.next ?? "/home"));
          return;
        } else {
          setError(data.error || githubResultMessage("expired"));
        }
        setGithubFinishing(false);
      })
      .catch(() => {
        setError(MSG.unreachable);
        setGithubFinishing(false);
      });
  }, [arrival, router]);

  async function handleGithub() {
    setError(null);
    setGithubElsewhere(null);
    setGithubPending(true);
    const result = await startGithubFlow(nextPath ? { intent: "login", next: nextPath } : { intent: "login" });
    // On success the browser is already on its way to GitHub: the button stays busy.
    if (!result.ok) {
      setGithubPending(false);
      setError(result.error);
      setGithubElsewhere(result.url ?? null);
    }
  }

  async function handleLogin() {
    if (!password) {
      setError("Inserisci la password");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.twoFactorRequired) {
        // The password was right: it is not needed again, so it does not stay in memory.
        setPassword("");
        setViaGithub(false);
        setChallenge(String(data.challenge));
      } else if (res.ok) {
        router.push(data.emailRequired ? "/setup-email" : (nextPath ?? "/home"));
      } else {
        setError(data.error || "Credenziali non valide");
      }
    } catch {
      setError("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetup() {
    if (!setupToken.trim()) {
      setError("Serve il token che il pannello ha stampato nel suo log di avvio");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Serve un'email valida: sarà il tuo nome di accesso");
      return;
    }
    if (password.length < 8) {
      setError("La password deve avere almeno 8 caratteri");
      return;
    }
    if (password !== confirmPassword) {
      setError("Le due password non coincidono");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, setup: true, setupToken: setupToken.trim() }),
      });
      if (res.ok) {
        router.push("/home");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Configurazione non riuscita");
      }
    } catch {
      setError("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  async function handleLink() {
    if (!setupToken.trim()) {
      setError("Serve il token che il pannello ha stampato nel suo log di avvio");
      return;
    }
    if (!panelUrl.trim() || !linkToken.trim()) {
      setError("Servono l'indirizzo del pannello e il token di collegamento che ha generato");
      return;
    }
    if (!serverName.trim()) {
      setError("Dai un nome a questo server: è come comparirà nel pannello");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setup: true,
          setupToken: setupToken.trim(),
          link: { panelUrl: panelUrl.trim(), token: linkToken.trim(), name: serverName.trim(), url: serverUrl.trim(), role },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setLinkedAs(role);
        if (role === "node") {
          const next = await fetch("/api/auth/check").then((r) => r.json() as Promise<Check>).catch(() => null);
          if (next) setCheck(next);
        } else {
          setCheck((prev) => (prev ? { ...prev, firstRun: false, role: "panel" } : prev));
        }
      } else {
        setError(data.details?.[0]?.message || data.error || "Collegamento non riuscito");
      }
    } catch {
      setError("Impossibile raggiungere il pannello");
    } finally {
      setLoading(false);
    }
  }

  if (check === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // Back from GitHub, while the panel finishes the sign-in.
  if (githubFinishing) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-4" role="status">
        <Spinner />
        <p className="text-muted text-sm">Accesso con GitHub in corso…</p>
      </div>
    );
  }

  // A managed node: nothing to sign into here.
  if (check.role === "node") {
    const panels = check.managedBy ?? [];
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Panel className="w-full max-w-md space-y-5 p-6 sm:p-8">
          <div className="flex flex-col items-center gap-2 text-center">
            <Image src={logo} alt="" aria-hidden width={44} height={44} className="size-11" priority />
            <h1 className="text-foreground text-xl font-semibold tracking-tight">RunPanel</h1>
            <p className="text-muted text-sm">Questo server è gestito da un altro RunPanel.</p>
          </div>
          {panels.length > 0 ? (
            <ul className="space-y-2">
              {panels.map((p) => (
                <li key={p.url}>
                  <a
                    href={`${p.url}/login`}
                    className="border-border bg-surface-secondary hover:bg-surface-hover flex items-center justify-between rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="text-foreground font-medium">{p.name}</span>
                    <span className="text-muted font-mono text-xs">{p.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-center text-sm">Accedi da uno dei pannelli del cluster.</p>
          )}
        </Panel>
      </div>
    );
  }

  if (challenge) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Panel className="w-full max-w-md p-6 sm:p-8">
          <SecondStep
            challenge={challenge}
            onExpired={(message) => {
              setChallenge(null);
              setError(viaGithub ? "L'accesso è scaduto: entra di nuovo con GitHub." : message);
            }}
            onSignedIn={(emailRequired) => router.push(emailRequired ? "/setup-email" : (nextPath ?? "/home"))}
            onBack={() => {
              setChallenge(null);
              setError(null);
            }}
          />
        </Panel>
      </div>
    );
  }

  const title = !isFirstRun
    ? "Accedi per continuare"
    : mode === "owner"
      ? "Crea l'account proprietario del pannello"
      : "Collega questo server a un RunPanel esistente";

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Panel className="w-full max-w-md p-6 sm:p-8">
        {/* A real form: Enter submits from any field, and password managers
            recognise it as a sign-in. */}
        <form
          className="space-y-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void (isFirstRun ? (mode === "owner" ? handleSetup() : handleLink()) : handleLogin());
          }}
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <Image src={logo} alt="" aria-hidden width={44} height={44} className="size-11" priority />
            <h1 className="text-foreground text-xl font-semibold tracking-tight">RunPanel</h1>
            <p className="text-muted text-sm">{title}</p>
          </div>

          {linkedAs === "panel" && (
            <p role="status" className="text-success text-center text-sm">
              Collegato. Accedi con un account del cluster.
            </p>
          )}

          {insecure && (
            <Hint tone="warn" title="Connessione non cifrata">
              Sei su http: password e sessione viaggiano in chiaro. Va bene su una rete privata
              (Tailscale, una VPN); su internet metti prima il pannello dietro HTTPS.
            </Hint>
          )}

          {isFirstRun && (
            <Segmented
              label="Come configurare questo server"
              value={mode}
              onChange={setMode}
              className="justify-center"
              options={[
                { value: "owner", label: "Crea il proprietario" },
                { value: "link", label: "Collega a un RunPanel" },
              ]}
            />
          )}

          <div className="space-y-4">
            {/*
              Proves the person claiming this panel is the one who can read its
              log, rather than whoever reached the port first.
            */}
            {isFirstRun && (
              <div>
                <TextField value={setupToken} onChange={setSetupToken} autoFocus>
                  <Label>Token di setup</Label>
                  <Input placeholder="3f9c1a…" className="font-mono text-sm" />
                </TextField>
                <FieldHint>
                  <SetupTokenHelp hint={check.setupHint} />
                </FieldHint>
              </div>
            )}

            {isFirstRun && mode === "link" ? (
              <>
                <TextField value={panelUrl} onChange={setPanelUrl}>
                  <Label>Indirizzo del pannello</Label>
                  <Input placeholder="http://100.64.0.5:3000" className="font-mono text-sm" autoComplete="off" />
                </TextField>
                <div>
                  <TextField value={linkToken} onChange={setLinkToken}>
                    <Label>Token di collegamento</Label>
                    <Input className="font-mono text-sm" autoComplete="off" />
                  </TextField>
                  <FieldHint>Lo genera il pannello in Impostazioni › Server collegati › Collega un server. Vale un&apos;ora.</FieldHint>
                </div>
                <TextField value={serverName} onChange={setServerName}>
                  <Label>Nome di questo server</Label>
                  <Input placeholder="hetzner-2" autoComplete="off" />
                </TextField>
                <div>
                  <TextField value={serverUrl} onChange={setServerUrl}>
                    <Label>Indirizzo di questo server</Label>
                    <Input className="font-mono text-sm" autoComplete="off" />
                  </TextField>
                  <FieldHint>
                    Quello con cui il pannello lo raggiunge: l&apos;IP Tailscale e la porta.
                    {/^https?:\/\/(localhost|127\.|\[::1\])/i.test(serverUrl) && (
                      <>
                        {" "}
                        <span className="text-warning">Un indirizzo locale vale solo da questa macchina: il pannello non lo raggiungerebbe.</span>
                      </>
                    )}
                  </FieldHint>
                </div>
                <SelectField label="Ruolo" value={role} onChange={setRole} options={ROLE_OPTIONS} />
              </>
            ) : (
              <>
                <TextField type="email" value={email} onChange={setEmail} autoFocus={!isFirstRun}>
                  <Label>Email</Label>
                  <Input placeholder="nome@esempio.it" autoComplete="username" />
                </TextField>
                {!isFirstRun && (
                  // One line rather than a paragraph: it concerns an upgrade that
                  // happens once, and was the longest text on the screen every day.
                  <FieldHint>Account senza email, da una versione vecchia? Lascia vuoto.</FieldHint>
                )}

                <TextField type="password" value={password} onChange={setPassword}>
                  <Label>Password</Label>
                  <Input autoComplete={isFirstRun ? "new-password" : "current-password"} />
                </TextField>

                {isFirstRun && (
                  <TextField type="password" value={confirmPassword} onChange={setConfirmPassword}>
                    <Label>Conferma password</Label>
                    <Input autoComplete="new-password" />
                  </TextField>
                )}
              </>
            )}
          </div>

          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
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

          <Button type="submit" variant="primary" className="w-full" isPending={loading}>
            {!isFirstRun ? "Accedi" : mode === "owner" ? "Configura il pannello" : "Collega il server"}
          </Button>

          {/* Only once the owner has set it up; a GitHub account still has to be linked to a user. */}
          {!isFirstRun && check.github && (
            <>
              <OrDivider />
              <GithubButton isPending={githubPending} isDisabled={loading} onPress={() => void handleGithub()}>
                Accedi con GitHub
              </GithubButton>
            </>
          )}
        </form>
      </Panel>
    </div>
  );
}
