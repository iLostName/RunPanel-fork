"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { MSG } from "@/lib/copy";
import { formatBytes } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { QrCode } from "@/components/ui/QrCode";
import { Segmented } from "@/components/ui/Segmented";
import { Technical } from "@/components/ui/Technical";

/** What `…/telegram/login` answers: the step, and never the session. */
interface LoginView {
  id: string;
  step: "qr" | "code" | "password" | "done" | "failed";
  method: "qr" | "phone";
  qr?: { url: string; expiresAt: string };
  codeVia?: "app" | "sms" | "email" | "other";
  passwordHint?: string | null;
  error?: string | null;
  account?: { name: string; username: string | null; premium: boolean; maxPartBytes: number };
  suggestedChannelTitle?: string;
}

/** A finished login, as the form saves it: the server holds the session, the form only its id. */
export interface LinkedTelegram {
  loginId: string;
  account: { name: string; username: string | null; premium: boolean; maxPartBytes: number };
  suggestedChannelTitle: string;
}

const CODE_VIA: Record<NonNullable<LoginView["codeVia"]>, string> = {
  app: "Telegram l'ha mandato nell'app, nella chat «Telegram» di un altro dispositivo dove sei collegato.",
  sms: "Telegram l'ha mandato per SMS.",
  email: "Telegram l'ha mandato alla tua email di accesso.",
  other: "Telegram l'ha mandato a uno dei tuoi dispositivi o per SMS.",
};

export function accountName(account: { name: string; username: string | null }): string {
  if (account.username) return account.name ? `${account.name} (@${account.username})` : `@${account.username}`;
  return account.name || "account senza nome";
}

/**
 * Linking a Telegram account, inside the destination form: the account's own
 * api_id and api_hash, then a QR code to scan from the app — or the phone
 * number, the code and the two-step password — and finally who got linked.
 *
 * The conversation with Telegram happens on the server; this only shows its
 * steps and polls while the QR code is up (it renews every 30 seconds). A
 * login left behind when the form closes is cancelled, and one that had
 * worked is logged out at Telegram, so no session is left among the account's
 * devices without a destination to use it.
 */
export function TelegramLink({
  api,
  relink,
  onLinked,
}: {
  api: (path: string) => string;
  /** Re-linking a destination: its api_id is shown, and an empty api_hash keeps the stored one. */
  relink?: { destinationId: string; apiId: number | null };
  onLinked: (linked: LinkedTelegram | null) => void;
}) {
  const [apiId, setApiId] = useState(relink?.apiId ? String(relink.apiId) : "");
  const [apiHash, setApiHash] = useState("");
  const [method, setMethod] = useState<"qr" | "phone">("qr");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [login, setLogin] = useState<LoginView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The latest login, for the cleanup on close: an effect's own copy would be stale.
  const current = useRef<LoginView | null>(null);
  const apiRef = useRef(api);
  const linkedRef = useRef(onLinked);
  useEffect(() => {
    current.current = login;
    apiRef.current = api;
    linkedRef.current = onLinked;
  });

  // Closed with a login still pending or linked but unsaved: cancel it. After a
  // save the server has already let go of it, and this answers "nothing to cancel".
  useEffect(
    () => () => {
      const pending = current.current;
      if (pending && pending.step !== "failed") {
        void fetch(apiRef.current(`/api/backups/destinations/telegram/login/${pending.id}`), {
          method: "DELETE",
          keepalive: true,
        }).catch(() => {});
      }
    },
    []
  );

  const show = useCallback((next: LoginView | null) => {
    setLogin(next);
    if (next?.step === "done" && next.account) {
      linkedRef.current({
        loginId: next.id,
        account: next.account,
        suggestedChannelTitle: next.suggestedChannelTitle ?? "RunPanel · backup",
      });
    }
  }, []);

  // While the QR code is up: Telegram says when the phone scanned it, and the
  // code expires every 30 seconds — the server renews it on these polls.
  const step = login?.step;
  const loginId = login?.id;
  useEffect(() => {
    if (step !== "qr" || !loginId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(apiRef.current(`/api/backups/destinations/telegram/login/${loginId}`));
        const body = await res.json().catch(() => ({}));
        if (stopped) return;
        if (res.status === 404) {
          setLogin(null);
          setProblem(body.error ?? "Il codice QR è scaduto: ricomincia.");
          return;
        }
        if (res.ok) show(body as LoginView);
      } catch {
        /* the next tick tries again */
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [step, loginId, show]);

  const hashOk = /^[0-9a-fA-F]{32}$/.test(apiHash.trim());
  const keepHash = Boolean(relink) && apiHash.trim() === "";
  const idOk = /^\d{1,10}$/.test(apiId.trim());
  const canStart = idOk && (hashOk || keepHash) && (method === "qr" || phone.trim().length >= 6);

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(api("/api/backups/destinations/telegram/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiId: Number(apiId.trim()),
          ...(keepHash ? {} : { apiHash: apiHash.trim() }),
          method,
          ...(method === "phone" ? { phone: phone.trim() } : {}),
          ...(relink ? { destinationId: relink.destinationId } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProblem(body.error ?? "Collegamento non riuscito");
        return;
      }
      setCode("");
      setPassword("");
      show(body as LoginView);
    } catch {
      setProblem(MSG.unreachable);
    } finally {
      setBusy(false);
    }
  }

  async function submit(payload: { code: string } | { password: string }) {
    if (!login) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/backups/destinations/telegram/login/${login.id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setLogin(null);
        setProblem(body.error ?? "Collegamento scaduto: ricomincia.");
        return;
      }
      if (!res.ok) {
        setLogin({ ...login, error: body.error ?? "Verifica non riuscita" });
        return;
      }
      setPassword("");
      show(body as LoginView);
    } catch {
      setLogin({ ...login, error: MSG.unreachable });
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    const previous = login;
    setLogin(null);
    setProblem(null);
    onLinked(null);
    if (previous) {
      await fetch(api(`/api/backups/destinations/telegram/login/${previous.id}`), { method: "DELETE" }).catch(() => {});
    }
  }

  if (login?.step === "done" && login.account) {
    const account = login.account;
    return (
      <div className="border-border flex flex-wrap items-center gap-3 rounded-[var(--radius)] border px-3 py-2.5">
        <Icon icon="solar:user-check-rounded-linear" width={20} className="text-success shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-medium">Collegato come {accountName(account)}</p>
          <p className="text-muted text-xs">
            {account.premium ? "Con Telegram Premium" : "Senza Premium"}: file fino a {formatBytes(account.maxPartBytes)}; gli archivi
            più grandi vengono divisi in parti e ricomposti da soli al ripristino.
          </p>
        </div>
        {account.premium && <Badge tone="accent">Premium</Badge>}
        <Button size="sm" variant="ghost" onPress={() => void restart()} isDisabled={busy}>
          Collega un altro account
        </Button>
      </div>
    );
  }

  if (login?.step === "qr" && login.qr) {
    return (
      <div className="space-y-3">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="border-border shrink-0 rounded-[var(--radius)] border bg-white p-1">
            <QrCode value={login.qr.url} size={192} label="Codice QR da inquadrare con l'app di Telegram" />
          </div>
          <div className="space-y-2">
            <ol className="text-muted list-decimal space-y-1.5 pl-5 text-sm">
              <li>Apri Telegram sul telefono.</li>
              <li>
                Vai in <strong className="text-foreground">Impostazioni › Dispositivi › Collega dispositivo</strong>.
              </li>
              <li>Inquadra il codice: si rinnova da solo ogni 30 secondi.</li>
            </ol>
            {login.error && <p className="text-warning text-xs">{login.error}</p>}
            <Button size="sm" variant="ghost" onPress={() => void restart()}>
              Annulla
            </Button>
          </div>
        </div>
        <Technical>
          <FieldHint>Il codice contiene un permesso di accesso valido 30 secondi, legato a questa richiesta.</FieldHint>
        </Technical>
      </div>
    );
  }

  if (login?.step === "code") {
    return (
      <div className="space-y-2">
        <TextField value={code} onChange={setCode} autoFocus>
          <Label>Codice di accesso</Label>
          <Input inputMode="numeric" autoComplete="one-time-code" placeholder="12345" className="font-mono tracking-widest" />
        </TextField>
        <FieldHint>{login.error ?? CODE_VIA[login.codeVia ?? "other"]}</FieldHint>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" isPending={busy} isDisabled={!/^\d{4,10}$/.test(code.trim())} onPress={() => void submit({ code: code.trim() })}>
            Conferma il codice
          </Button>
          <Button size="sm" variant="ghost" onPress={() => void restart()}>
            Annulla
          </Button>
        </div>
      </div>
    );
  }

  if (login?.step === "password") {
    return (
      <div className="space-y-2">
        <TextField type="password" value={password} onChange={setPassword} autoFocus>
          <Label>Password della verifica in due passaggi</Label>
          <Input autoComplete="off" spellCheck={false} />
        </TextField>
        <FieldHint>
          {login.error ??
            `L'account la chiede dopo il codice: è quella di Telegram › Impostazioni › Privacy e sicurezza › Verifica in due passaggi.${login.passwordHint ? ` Suggerimento: «${login.passwordHint}».` : ""}`}
        </FieldHint>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" isPending={busy} isDisabled={!password} onPress={() => void submit({ password })}>
            Conferma la password
          </Button>
          <Button size="sm" variant="ghost" onPress={() => void restart()}>
            Annulla
          </Button>
        </div>
      </div>
    );
  }

  // Nothing started yet, or the last try failed: the keys and how to log in.
  const failed = login?.step === "failed" ? login.error : null;
  return (
    <div className="space-y-4">
      {!relink && (
        <Hint tone="tip" title="Prima, le chiavi della tua app Telegram">
          <ol className="list-decimal space-y-1 pl-4">
            <li>
              Apri{" "}
              <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                my.telegram.org
              </a>{" "}
              e accedi con il numero dell&apos;account che terrà i backup.
            </li>
            <li>
              Scegli <strong className="text-foreground">API development tools</strong> e crea un&apos;app: nome e titolo a piacere (per
              esempio RunPanel), piattaforma «Other».
            </li>
            <li>Copia qui api_id e api_hash.</li>
          </ol>
          <p className="mt-1">Servono le tue: Telegram chiede che ogni programma usi le proprie, e il pannello non ne ha di sue.</p>
        </Hint>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField value={apiId} onChange={setApiId}>
          <Label>api_id</Label>
          <Input inputMode="numeric" className="font-mono text-sm" autoComplete="off" placeholder="1234567" />
        </TextField>
        <div>
          <TextField type="password" value={apiHash} onChange={setApiHash} isInvalid={apiHash.trim() !== "" && !hashOk}>
            <Label>api_hash</Label>
            <Input className="font-mono text-sm" autoComplete="new-password" spellCheck={false} placeholder={relink ? "invariato" : undefined} />
          </TextField>
          <FieldHint>
            {apiHash.trim() !== "" && !hashOk
              ? "Sono 32 caratteri, cifre e lettere da a a f."
              : relink
                ? "Lascialo vuoto per tenere quello salvato."
                : "Viene salvato cifrato, come la sessione."}
          </FieldHint>
        </div>
      </div>

      <div className="space-y-2">
        <Segmented
          label="Come collegare l'account"
          value={method}
          onChange={setMethod}
          options={[
            { value: "qr", label: "Con il codice QR" },
            { value: "phone", label: "Con il numero di telefono" },
          ]}
        />
        {method === "phone" && (
          <div>
            <TextField value={phone} onChange={setPhone}>
              <Label>Numero di telefono</Label>
              <Input inputMode="tel" autoComplete="tel" placeholder="+39 333 123 4567" />
            </TextField>
            <FieldHint>Con il prefisso internazionale. Poi Telegram manda un codice, e se l&apos;account ha la verifica in due passaggi chiede anche la password.</FieldHint>
          </div>
        )}
      </div>

      {(problem || failed) && (
        <Hint tone="warn" title="Il collegamento non è riuscito">
          {problem ?? failed}
        </Hint>
      )}

      <Button size="sm" variant="secondary" isPending={busy} isDisabled={!canStart} onPress={() => void start()}>
        <Icon icon={method === "qr" ? "solar:qr-code-linear" : "solar:smartphone-linear"} width={16} aria-hidden />
        {method === "qr" ? "Mostra il codice QR" : "Manda il codice"}
      </Button>
    </div>
  );
}
