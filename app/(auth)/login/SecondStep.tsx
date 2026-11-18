"use client";

import { useState } from "react";
import Image from "next/image";
import { Button, Input, Label, TextField } from "@heroui/react";
import logo from "@/components/logo.svg";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { FieldHint } from "@/components/ui/Hint";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";

/**
 * The sign-in's second step: the password was right, now the code.
 *
 * A code from the authenticator app by default, a recovery code for the day
 * the phone is not there. Either way the input is free text and the server
 * decides what it is: someone pasting a recovery code into the first field is
 * not turned away.
 */
export function SecondStep({
  challenge,
  onSignedIn,
  onExpired,
  onBack,
}: {
  challenge: string;
  onSignedIn: (emailRequired: boolean) => void;
  onExpired: (message: string) => void;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<"app" | "recovery">("app");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!code.trim()) {
      setError(mode === "app" ? "Scrivi il codice che mostra l'app" : "Scrivi uno dei codici di recupero");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login/two-factor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge, code: code.trim(), remember }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (typeof data.recoveryCodesLeft === "number") {
          toast.warning(
            data.recoveryCodesLeft === 0
              ? "Hai usato l'ultimo codice di recupero: generane di nuovi da Account › Verifica in due passaggi."
              : `Hai usato un codice di recupero: ne restano ${data.recoveryCodesLeft}. Ognuno vale una volta sola.`
          );
        }
        onSignedIn(Boolean(data.emailRequired));
        return;
      }
      if (data.code === "challenge_expired") {
        onExpired(data.error || "L'accesso è scaduto: inserisci di nuovo email e password.");
        return;
      }
      setError(data.error || "Codice non valido");
      setCode("");
    } catch {
      setError(MSG.unreachable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Image src={logo} alt="" aria-hidden width={44} height={44} className="size-11" priority />
        <h1 className="text-foreground text-xl font-semibold tracking-tight">Verifica in due passaggi</h1>
        <p className="text-muted text-sm">
          {mode === "app"
            ? "Apri l'app di autenticazione sul telefono e scrivi il codice di RunPanel."
            : "Scrivi uno dei codici di recupero che hai salvato."}
        </p>
      </div>

      <div className="space-y-4">
        {/* Keyed by mode: the field is a different one, with its own keyboard and autofill. */}
        <div key={mode}>
          <TextField value={code} onChange={setCode} autoFocus>
            <Label>{mode === "app" ? "Codice dell'app" : "Codice di recupero"}</Label>
            {mode === "app" ? (
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                maxLength={7}
                className="font-mono text-base tracking-widest"
              />
            ) : (
              <Input autoComplete="off" placeholder="xxxx-xxxx-xxxx" maxLength={20} className="font-mono" />
            )}
          </TextField>
          <FieldHint>
            {mode === "app"
              ? "Sei cifre, cambiano ogni 30 secondi. Se viene rifiutato, controlla che l'ora del telefono sia giusta."
              : "Ogni codice vale una volta sola. Dopo, generane di nuovi dalla pagina Account."}
          </FieldHint>
        </div>

        <button
          type="button"
          className="text-accent text-sm hover:underline"
          onClick={() => {
            setMode(mode === "app" ? "recovery" : "app");
            setCode("");
            setError(null);
          }}
        >
          {mode === "app" ? "Non hai il telefono? Usa un codice di recupero" : "Usa il codice dell'app"}
        </button>

        <CheckboxField
          label="Ricorda questo dispositivo per 30 giorni"
          description="Solo su un computer tuo: da questo browser non ti chiederà il codice per 30 giorni."
          isSelected={remember}
          onChange={setRemember}
        />
      </div>

      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <Button type="submit" variant="primary" className="w-full" isPending={pending}>
          Verifica
        </Button>
        <Button variant="ghost" className="w-full" isDisabled={pending} onPress={onBack}>
          Torna indietro
        </Button>
      </div>
    </form>
  );
}
