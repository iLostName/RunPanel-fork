"use client";

import { useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { CopyField } from "@/components/ui/CopyField";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Hint, FieldHint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";

/**
 * Tokens for an AI assistant (MCP, `/api/mcp`) or a script (the REST API).
 *
 * Each token is yours and acts as you: it can never do more than you can from
 * here, and `Sola lettura` makes it do less. The switch at the top is the
 * owner's and covers every token of every user — off, none of them works.
 */

type Access = "read" | "full";
type Expiry = "30" | "90" | "365" | "never";

interface Token {
  id: string;
  name: string;
  hint: string;
  access: Access;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

interface Listing {
  enabled: boolean;
  tokens: Token[];
}

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 giorni" },
  { value: "90", label: "90 giorni" },
  { value: "365", label: "1 anno" },
  { value: "never", label: "Mai" },
] as const;

const ACCESS_LABEL: Record<Access, string> = { read: "Sola lettura", full: "Controllo completo" };

export default function McpPage() {
  const me = useMe();
  const { data, loading, error, refresh } = useResource<Listing>("/api/api-tokens");
  const [switching, setSwitching] = useState(false);
  const [name, setName] = useState("Claude");
  const [access, setAccess] = useState<Access>("full");
  const [expiry, setExpiry] = useState<Expiry>("90");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);

  const enabled = data?.enabled ?? false;
  const endpoint = typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`;

  async function send(url: string, init: RequestInit, failure: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || failure);
        return null;
      }
      return body;
    } catch {
      toast.error(failure);
      return null;
    }
  }

  async function toggle(next: boolean) {
    setSwitching(true);
    const ok = await send("/api/api-tokens", { method: "PATCH", body: JSON.stringify({ enabled: next }) }, "Modifica non riuscita");
    setSwitching(false);
    if (!ok) return;
    toast.success(next ? "Accesso via token attivato" : "Accesso via token spento: nessun token funziona più");
    await refresh();
  }

  async function create() {
    setCreating(true);
    const body = await send(
      "/api/api-tokens",
      {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), access, expiresInDays: expiry === "never" ? null : Number(expiry) }),
      },
      "Creazione non riuscita"
    );
    setCreating(false);
    if (!body) return;
    setCreated({ name: name.trim(), token: String(body.token) });
    await refresh();
  }

  async function revoke(token: Token): Promise<boolean> {
    const ok = await send(`/api/api-tokens?id=${encodeURIComponent(token.id)}`, { method: "DELETE" }, "Revoca non riuscita");
    if (!ok) return false;
    toast.success(`Token "${token.name}" revocato`);
    await refresh();
    return true;
  }

  const claudeCommand = created
    ? `claude mcp add --transport http runpanel ${endpoint} --header "Authorization: Bearer ${created.token}"`
    : "";
  const mcpJson = created
    ? JSON.stringify(
        { mcpServers: { runpanel: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${created.token}` } } } },
        null,
        2
      )
    : "";

  return (
    <>
      <PageHeader title="AI e API" description="Controlla il pannello da Claude (MCP) o da uno script" />

      <div className="max-w-3xl space-y-4">
        {loading && !data ? (
          <SkeletonBlock className="h-24" />
        ) : !data && error ? (
          <LoadError what="i token" error={error} onRetry={() => void refresh()} />
        ) : (
          <>
            <Panel className="space-y-3">
              <PanelHeader
                title="Accesso via token"
                description="Un assistente AI o uno script entra con un token al posto della password"
              />
              {me.isOwner ? (
                <SettingToggle
                  label="Permetti l'accesso via token"
                  description="Vale per i token di tutti gli utenti. Spento, nessuno funziona: né MCP né API."
                  isSelected={enabled}
                  isDisabled={switching}
                  onChange={(next) => void toggle(next)}
                />
              ) : (
                !enabled && <Hint tone="warn">L&apos;accesso via token è spento: solo il proprietario può attivarlo.</Hint>
              )}
              <FieldHint>
                Endpoint MCP: <span className="font-mono">{endpoint}</span>. Ogni token agisce come te, con i tuoi
                stessi permessi su progetti, servizi e server del cluster.
              </FieldHint>
            </Panel>

            {created && (
              <Panel className="space-y-4">
                <PanelHeader
                  title={`Token "${created.name}" creato`}
                  description="Copialo ora: non verrà più mostrato"
                  actions={
                    <Button variant="secondary" size="sm" onPress={() => setCreated(null)}>
                      Fatto
                    </Button>
                  }
                />
                <CopyField label="Token" value={created.token} secret />
                <div className="space-y-1.5">
                  <span className="text-muted text-xs font-medium">Claude Code</span>
                  <CommandBlock commands={[claudeCommand]} label="Comando copiato" />
                </div>
                <div className="space-y-1.5">
                  <span className="text-muted text-xs font-medium">Altri client MCP (.mcp.json)</span>
                  <CommandBlock commands={[mcpJson]} label="Configurazione copiata" />
                </div>
              </Panel>
            )}

            <Panel className="space-y-4">
              <PanelHeader title="Nuovo token" description="Uno per ogni client: si revocano uno alla volta" />
              <TextField value={name} onChange={setName} isDisabled={!enabled}>
                <Label>Nome</Label>
                <Input placeholder="Claude sul portatile" />
              </TextField>
              <Segmented
                label="Permessi"
                value={access}
                onChange={setAccess}
                options={[
                  { value: "full", label: ACCESS_LABEL.full, isDisabled: !enabled },
                  { value: "read", label: ACCESS_LABEL.read, isDisabled: !enabled },
                ]}
              />
              <FieldHint>
                {access === "full"
                  ? "Può fare tutto ciò che puoi fare tu: deploy, riavvii, variabili, eliminazioni."
                  : "Può solo leggere: stato, log, impostazioni. Ogni modifica viene rifiutata."}
              </FieldHint>
              <SelectField label="Scadenza" value={expiry} onChange={setExpiry} options={EXPIRY_OPTIONS} isDisabled={!enabled} />
              <div>
                <Button variant="primary" isPending={creating} isDisabled={!enabled || !name.trim()} onPress={create}>
                  Crea token
                </Button>
              </div>
            </Panel>

            <Panel className="space-y-3">
              <PanelHeader title="I tuoi token" />
              {data && data.tokens.length === 0 ? (
                <p className="text-muted text-sm">Nessun token.</p>
              ) : (
                <ul className="divide-border divide-y">
                  {data?.tokens.map((token) => (
                    <li key={token.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                      <Icon icon="solar:key-minimalistic-linear" width={18} className="text-muted shrink-0" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground truncate text-sm">
                          {token.name} <span className="text-muted font-mono text-xs">…{token.hint}</span>
                        </p>
                        <p className="text-muted mt-0.5 truncate text-xs">
                          {ACCESS_LABEL[token.access]}
                          {" · "}
                          {token.last_used_at ? `usato ${formatRelative(token.last_used_at)}` : "mai usato"}
                          {" · "}
                          {token.expires_at
                            ? new Date(token.expires_at) < new Date()
                              ? "scaduto"
                              : `scade ${formatRelative(token.expires_at)}`
                            : "non scade"}
                        </p>
                      </div>
                      <Button variant="ghost" size="sm" aria-label={`Revoca il token ${token.name}`} onPress={() => setRevoking(token)}>
                        Revoca
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </>
        )}
      </div>

      <ConfirmDialog
        isOpen={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revocare "${revoking?.name ?? ""}"?`}
        description="Chi lo usa perde l'accesso subito. Non si può annullare."
        confirmLabel="Revoca"
        destructive
        onConfirm={() => (revoking ? revoke(revoking) : false)}
      />
    </>
  );
}
