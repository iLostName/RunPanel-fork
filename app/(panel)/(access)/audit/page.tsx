"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { Section } from "@/components/ui/Section";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { FieldHint } from "@/components/ui/Hint";
import { SelectField } from "@/components/ui/SelectField";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import { formatWhen } from "@/lib/format";
import { AUDIT_CATEGORIES, type AuditCategory } from "@/lib/audit-filter";
import { useNode, useNodeApi } from "@/lib/hooks/useNode";
import { ServerSelector } from "@/components/ServerSelector";

interface Entry {
  id: string;
  at: string;
  userId: string | null;
  email: string | null;
  category: string;
  action: string;
  scope: string | null;
  scopeId: string | null;
  scopeName: string | null;
  detail: string | null;
  ip: string | null;
}

const CATEGORY_LABEL: Record<AuditCategory, { label: string; description: string }> = {
  security: { label: "Sicurezza", description: "Accessi, inviti, utenti, permessi e sessioni. Sempre registrata." },
  deploy: { label: "Deploy", description: "Deploy, avvio, stop e riavvio di progetti e servizi." },
  config: { label: "Configurazione", description: "Variabili, impostazioni, mount, file, nuovi progetti." },
  terminal: { label: "Terminale", description: "Apertura di terminali e console." },
  backup: { label: "Backup", description: "Pianificazioni, esecuzioni e ripristini." },
  system: { label: "Sistema", description: "Aggiornamenti, avvio automatico, storage, impostazioni globali." },
  delete: { label: "Eliminazioni", description: "Progetti, servizi, cartelle e database eliminati." },
};

const SCOPE_LABEL: Record<string, string> = { project: "progetto", service: "servizio", folder: "cartella", user: "utente" };

/** Readable names for the actions the routes record. */
const ACTION_LABEL: Record<string, string> = {
  "auth.login": "Accesso",
  "auth.login.failed": "Accesso fallito",
  "auth.setup": "Configurazione iniziale",
  "auth.invite.redeemed": "Invito accettato",
  "user.invite": "Invito creato",
  "user.reset": "Link per nuova password",
  "user.access": "Accessi modificati",
  "user.disable": "Account disattivato",
  "user.enable": "Account riattivato",
  "user.delete": "Account eliminato",
  "session.revoke": "Sessione chiusa",
  "account.email": "Email cambiata",
  "account.password": "Password cambiata",
  "account.password.failed": "Password attuale errata",
  "audit.settings": "Registro configurato",
  "project.deploy": "Deploy",
  "project.control": "Avvio / stop / riavvio",
  "project.terminal": "Terminale aperto",
  "project.update": "Impostazioni progetto",
  "project.env": "Variabili d'ambiente",
  "project.delete": "Progetto eliminato",
  "project.create": "Progetto creato",
  "project.app.delete": "App rimossa dal progetto",
  "project.backup": "Backup del progetto modificato",
  "project.files": "File modificato",
  "project.host.add": "Dominio aggiunto al progetto",
  "project.host.update": "Dominio del progetto modificato",
  "project.host.remove": "Dominio rimosso dal progetto",
  "project.host.retry": "Certificato richiesto di nuovo",
  "project.mounts": "Mount del progetto",
  "project.one-time": "Comandi una tantum modificati",
  "project.one-time.delete": "Comando una tantum eliminato",
  "project.pin": "Versione sbloccata",
  "project.repo-path": "Cartella del repository spostata",
  "project.repo-path.reset": "Cartella del repository ripristinata",
  "project.upload": "Archivio caricato",
  "project.webhook": "Webhook GitHub",
  "service.control": "Avvio / stop / riavvio servizio",
  "service.update": "Impostazioni servizio",
  "service.delete": "Servizio eliminato",
  "service.create": "Servizio creato",
  "service.console.engine": "Console del database aperta",
  "service.console.shell": "Shell del servizio aperta",
  "service.database.create": "Database creato",
  "service.database.delete": "Database eliminato",
  "service.mounts": "Mount del servizio",
  "folder.create": "Cartella creata",
  "folder.update": "Cartella modificata",
  "folder.delete": "Cartella eliminata",
  "backup.run": "Backup eseguito",
  "backup.run.delete": "Backup eliminato",
  "backup.restore": "Ripristino avviato",
  "backup.policy.create": "Pianificazione creata",
  "backup.policy.update": "Pianificazione modificata",
  "backup.policy.delete": "Pianificazione eliminata",
  "backup.destination.create": "Destinazione creata",
  "backup.destination.update": "Destinazione modificata",
  "backup.destination.delete": "Destinazione eliminata",
  "cluster.token.issue": "Token di collegamento creato",
  "cluster.member.join": "Server collegato",
  "cluster.member.update": "Server modificato",
  "cluster.member.revoke": "Server revocato",
  "cluster.linked": "Collegato a un pannello",
  "cluster.left": "Uscito dal cluster",
  "cluster.secret.rotate": "Segreto del cluster rigenerato",
  "cluster.secret.resend": "Segreto reinviato a un server",
  "domain.create": "Dominio aggiunto",
  "domain.delete": "Dominio eliminato",
  "domain.settings": "Impostazioni dei domini",
  "domain.proxy": "Proxy nginx configurato",
  "domain.cloudflare.connect": "Cloudflare collegato",
  "domain.cloudflare.disconnect": "Cloudflare scollegato",
  "autostart.update": "Avvio automatico modificato",
  "autostart.host": "Avvio automatico dell'host",
  "autostart.fix": "Avvio automatico riparato",
  "autostart.reconcile": "Avvio automatico riallineato",
  "notifications.update": "Notifiche modificate",
  "registries.update": "Registry salvato",
  "registries.delete": "Registry eliminato",
  "settings.update": "Impostazioni del pannello",
  "storage.clean": "Pulizia Docker",
  "updates.apply": "Aggiornamento del pannello",
};

/** Who did what, filtered to what the reader may see. */
export default function AuditPage() {
  const me = useMe();
  // Each server keeps its own log: say whose this is, and let it be switched here.
  const { isSolo, current } = useNode();
  const [category, setCategory] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  return (
    <>
      <PageHeader
        title="Registro attività"
        description={isSolo ? "Chi ha fatto cosa, e quando" : `Chi ha fatto cosa, e quando, su ${current?.name ?? "questo server"}`}
        actions={<ServerSelector className="sm:hidden" />}
      />

      <div className="space-y-4">
        <Panel className="grid gap-3 sm:grid-cols-3">
          <SelectField
            label="Categoria"
            value={category}
            onChange={setCategory}
            options={[
              { value: "", label: "Tutte" },
              ...AUDIT_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c].label })),
            ]}
          />
          <TextField type="date" value={from} onChange={setFrom}>
            <Label>Dal</Label>
            <Input />
          </TextField>
          <TextField type="date" value={to} onChange={setTo}>
            <Label>Al</Label>
            <Input />
          </TextField>
        </Panel>

        {/* Remounted per filter, so a new search starts from a clean list. */}
        <AuditList key={`${category}|${from}|${to}`} category={category} from={from} to={to} />

        {me.isOwner && <AuditSettings />}
      </div>
    </>
  );
}

function AuditList({ category, from, to }: { category: string; from: string; to: string }) {
  const api = useNodeApi();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const query = useCallback(
    (before?: string) => {
      const sp = new URLSearchParams({ limit: "50" });
      if (category) sp.set("category", category);
      if (from) sp.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) sp.set("to", new Date(`${to}T23:59:59`).toISOString());
      if (before) sp.set("before", before);
      return fetch(api(`/api/audit?${sp}`)).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Il server ha risposto ${res.status}`);
        return data as { entries: Entry[]; nextBefore: string | null };
      });
    },
    [category, from, to, api]
  );

  useEffect(() => {
    let cancelled = false;
    query()
      .then((data) => {
        if (cancelled) return;
        setError(null);
        setEntries(data.entries);
        setNext(data.nextBefore);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [query, attempt]);

  async function more() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const data = await query(next);
      setEntries((prev) => [...(prev ?? []), ...data.entries]);
      setNext(data.nextBefore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Caricamento non riuscito");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      {error ? (
        <LoadError what="il registro" error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : entries === null ? (
        <SkeletonBlock className="h-64" />
      ) : entries.length === 0 ? (
        <EmptyState icon="solar:history-linear" title="Nessuna attività" description="Niente da mostrare con questi filtri." />
      ) : (
        <Panel padding="flush" className="overflow-hidden">
          <ul className="divide-border divide-y">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
                <span className="text-meta shrink-0 text-xs tabular-nums sm:w-40">{formatWhen(e.at)}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-foreground text-sm">
                    <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                    {e.detail && <span className="text-muted"> · {e.detail}</span>}
                  </p>
                  <p className="text-meta truncate text-xs">
                    {e.email ?? (e.userId ? "account eliminato" : "il pannello")}
                    {e.scope && e.scope !== "permission" && ` · ${SCOPE_LABEL[e.scope] ?? e.scope} ${e.scopeName ?? e.scopeId ?? ""}`}
                    {e.ip && ` · ${e.ip}`}
                  </p>
                </div>
                <span className="text-meta shrink-0 text-xs">
                  {CATEGORY_LABEL[e.category as AuditCategory]?.label ?? e.category}
                </span>
              </li>
            ))}
          </ul>
          {next && (
            <div className="border-border border-t p-3 text-center">
              <Button variant="ghost" size="sm" isPending={loadingMore} onPress={more}>
                Carica altre
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

/** The owner's choice of what is recorded and for how long. */
function AuditSettings() {
  const api = useNodeApi();
  const settings = useResource<{ categories: AuditCategory[]; retentionDays: number }>(api("/api/audit/settings"));
  return (
    <Section title="Cosa registrare" summary="Categorie e conservazione — solo il proprietario">
      {settings.error && !settings.data ? (
        <LoadError what="le impostazioni del registro" error={settings.error} onRetry={settings.refresh} />
      ) : !settings.data ? (
        <SkeletonBlock className="h-40" />
      ) : (
        <AuditSettingsForm key={JSON.stringify(settings.data)} initial={settings.data} onSaved={settings.refresh} />
      )}
    </Section>
  );
}

function AuditSettingsForm({
  initial,
  onSaved,
}: {
  initial: { categories: AuditCategory[]; retentionDays: number };
  onSaved: () => Promise<void>;
}) {
  const api = useNodeApi();
  const [categories, setCategories] = useState<AuditCategory[]>(initial.categories);
  const [days, setDays] = useState(String(initial.retentionDays));
  const [saving, setSaving] = useState(false);

  async function save() {
    const retentionDays = Number.parseInt(days, 10);
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      toast.error("La conservazione va da 1 a 3650 giorni");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(api("/api/audit/settings"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories, retentionDays }),
      });
      if (!res.ok) throw new Error();
      toast.success("Impostazioni del registro salvate");
      await onSaved();
    } catch {
      toast.error("Salvataggio non riuscito");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      {AUDIT_CATEGORIES.map((c) => (
        <SettingToggle
          key={c}
          label={CATEGORY_LABEL[c].label}
          description={CATEGORY_LABEL[c].description}
          isSelected={c === "security" || categories.includes(c)}
          isDisabled={c === "security"}
          onChange={(on) => setCategories(on ? [...categories, c] : categories.filter((x) => x !== c))}
        />
      ))}
      <div>
        <TextField value={days} onChange={setDays} className="max-w-40">
          <Label>Conservazione (giorni)</Label>
          <Input inputMode="numeric" />
        </TextField>
        <FieldHint>Le voci più vecchie vengono cancellate dalla pulizia periodica, ogni 6 ore.</FieldHint>
      </div>
      <Button variant="primary" isPending={saving} onPress={save}>
        Salva
      </Button>
    </div>
  );
}
