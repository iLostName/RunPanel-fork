"use client";

import { useState } from "react";
import { Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { FormDialog } from "@/components/ui/FormDialog";
import { FieldHint } from "@/components/ui/Hint";
import { Technical } from "@/components/ui/Technical";
import { useNodeApi } from "@/lib/hooks/useNode";

/**
 * GitHub's "new token" page with the one scope the panel needs already ticked.
 *
 * `repo` covers reading private repositories and managing their webhooks,
 * which is what auto-deploy registers. The description names the token so it
 * can be found and revoked later.
 */
const NEW_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo&description=RunPanel";

/**
 * Connect GitHub without leaving the page that needed it.
 *
 * The wizard used to send people to the GitHub page and back, losing what they
 * had chosen. The token is stored exactly as the GitHub page stores it
 * (`PUT /api/settings`, encrypted at rest).
 */
export function GithubConnectDialog({
  isOpen,
  onOpenChange,
  onConnected,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}) {
  const api = useNodeApi();
  const [token, setToken] = useState("");

  async function save() {
    const res = await fetch(api("/api/settings"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ github_token: token.trim() }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Collegamento non riuscito");
      return false;
    }
    toast.success("GitHub collegato");
    setToken("");
    onConnected();
  }

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Collega GitHub"
      description="Serve per scegliere i repository da un elenco, usare quelli privati e aggiornare l'app a ogni push."
      submitLabel="Collega"
      isSubmitDisabled={!token.trim()}
      onSubmit={save}
    >
      <ol className="text-foreground space-y-2 text-sm">
        <li className="flex gap-2">
          <span className="text-muted font-mono">1.</span>
          <span>
            Apri la{" "}
            <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-1 hover:underline">
              pagina dei token di GitHub
              <Icon icon="solar:arrow-right-up-linear" width={14} aria-hidden />
            </a>
            : il permesso giusto è già selezionato.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="text-muted font-mono">2.</span>
          <span>Scegli una scadenza, premi «Generate token» e copia il codice che inizia con ghp_.</span>
        </li>
        <li className="flex gap-2">
          <span className="text-muted font-mono">3.</span>
          <span>Incollalo qui sotto.</span>
        </li>
      </ol>

      <div>
        <TextField type="password" value={token} onChange={setToken} autoFocus>
          <Label>Token</Label>
          <Input placeholder="ghp_…" className="font-mono text-sm" autoComplete="off" />
        </TextField>
        <FieldHint>
          Viene salvato cifrato e usato solo per parlare con GitHub.
          <Technical> Token classico con lo scope repo; vale anche un fine-grained token con accesso in lettura ai contenuti e in scrittura ai webhook.</Technical>
        </FieldHint>
      </div>
    </FormDialog>
  );
}
