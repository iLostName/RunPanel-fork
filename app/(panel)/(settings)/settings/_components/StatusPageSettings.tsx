"use client";

import { useMemo, useState } from "react";
import { Button, Input, TextArea, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { FormError } from "@/components/ui/FormError";
import { Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { RowMenu } from "@/components/ui/ListRow";
import { Section } from "@/components/ui/Section";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { StickySaveBar } from "@/components/ui/StickySaveBar";
import { StatusPageLink } from "@/components/uptime/StatusPageLink";
import { useClusterList } from "@/lib/hooks/useClusterList";
import { useNode } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";
import {
  MAX_PAGE_PROJECTS,
  MESSAGE_MAX,
  PUBLIC_NAME_MAX,
  SLUG_RULE,
  STATUS_PAGE_BASE,
  TITLE_MAX,
  cleanLine,
  entryKey,
  isValidSlug,
  randomSlug,
  type StatusPageConfig,
  type StatusPageEntry,
} from "@/lib/status-page";

/**
 * Impostazioni › Generale › Pagina di stato pubblica: the owner's.
 *
 * One form, saved with the bar like the mail server above it, because every
 * field changes the same public thing and a half-saved page is the one state
 * worth never showing. The toggle too waits for the bar: switching a public
 * page on is the decision the bar's "Salva" makes explicit.
 *
 * Talks to this panel (`/api/status-page`, not the forwarded form): the page
 * is served by the panel the owner has open, and lists projects of every
 * server, each kept under the name typed here.
 */

type Skip = "disabled" | "no-port" | "not-running";

interface StatusPageData extends StatusPageConfig {
  saved: boolean;
  path: string;
  url: string | null;
  checks: Record<string, { active: boolean; skip: Skip | null }>;
  missing: string[];
}

interface ProjectRow {
  id: string;
  name: string;
}

interface Candidate {
  server: string | null;
  projectId: string;
  name: string;
  serverName: string;
}

/** What the page will say about a project whose check is not running, so the choice is made knowing it. */
const SKIP_TEXT: Record<Skip, string> = {
  disabled: "Il controllo di salute è spento: sulla pagina comparirà «Nessun dato».",
  "no-port": "Non ha una porta da controllare: sulla pagina comparirà «Nessun dato».",
  "not-running": "Non è in esecuzione: sulla pagina comparirà «Non risponde» finché non riparte.",
};

function sameEntries(a: readonly StatusPageEntry[], b: readonly StatusPageEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entryKey(entry) === entryKey(b[i]) && entry.name === b[i].name);
}

export function StatusPageSection({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const { data, error, loading, refresh } = useResource<StatusPageData>("/api/status-page");
  const count = data?.projects.length ?? 0;
  const summary = !data
    ? "Una pagina pubblica che dice se le app rispondono"
    : data.enabled
      ? `Pubblica · ${count === 1 ? "1 progetto" : `${count} progetti`}`
      : "Spenta: nessuno la vede";

  return (
    <Section title="Pagina di stato pubblica" summary={summary} defaultExpanded={defaultExpanded}>
      {!data && error ? (
        <LoadError what="la pagina di stato" error={error} onRetry={() => void refresh()} />
      ) : loading || !data ? (
        <SkeletonBlock className="h-48" />
      ) : (
        // Keyed by what was loaded, so a save starts the form again from what the server kept.
        <StatusPageForm key={JSON.stringify(data)} data={data} onSaved={refresh} />
      )}
    </Section>
  );
}

function StatusPageForm({ data, onSaved }: { data: StatusPageData; onSaved: () => Promise<void> }) {
  const { selfId, isSolo } = useNode();
  const list = useClusterList<ProjectRow>("/api/cluster/projects", "/api/projects", { everyServer: true });

  // A project deleted since it was chosen is off the page already; the form
  // drops it too, and says so. Not a change of its own — nothing public moves
  // — so it leaves with the next save instead of holding the page hostage.
  const missing = useMemo(() => new Set(data.missing), [data.missing]);
  const initialProjects = useMemo(
    () => data.projects.filter((entry) => !(entry.server === null && missing.has(entry.projectId))),
    [data.projects, missing]
  );
  const dropped = data.projects.filter((entry) => entry.server === null && missing.has(entry.projectId));

  const [enabled, setEnabled] = useState(data.enabled);
  const [slug, setSlug] = useState(data.slug);
  const [title, setTitle] = useState(data.title);
  const [message, setMessage] = useState(data.message);
  const [allowIndexing, setAllowIndexing] = useState(data.allowIndexing);
  const [projects, setProjects] = useState<StatusPageEntry[]>(initialProjects);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const candidates = useMemo<Candidate[]>(
    () =>
      (list.items ?? []).map((row) => ({
        server: !row.memberId || row.memberId === selfId ? null : row.memberId,
        projectId: row.id,
        name: row.name,
        serverName: row.memberName,
      })),
    [list.items, selfId]
  );
  const byKey = useMemo(() => new Map(candidates.map((c) => [entryKey(c), c])), [candidates]);
  const chosen = new Set(projects.map(entryKey));
  const available = candidates.filter((c) => !chosen.has(entryKey(c)));

  // Nothing saved yet is a proposal, not a change: the bar waits for the
  // owner to touch something, or every visit to Impostazioni would ask
  // "uscire senza salvare?" about a page nobody started.
  const dirty =
    enabled !== data.enabled ||
    slug !== data.slug ||
    title !== data.title ||
    message !== data.message ||
    allowIndexing !== data.allowIndexing ||
    !sameEntries(projects, initialProjects);

  const problems = {
    slug: isValidSlug(slug) ? null : SLUG_RULE,
    title: !cleanLine(title, TITLE_MAX + 1)
      ? "Dai un titolo alla pagina"
      : cleanLine(title, TITLE_MAX + 1).length > TITLE_MAX
        ? `Al massimo ${TITLE_MAX} caratteri`
        : null,
    message: message.trim().length > MESSAGE_MAX ? `Al massimo ${MESSAGE_MAX} caratteri` : null,
  };
  const nameProblem = (name: string) =>
    !cleanLine(name, PUBLIC_NAME_MAX + 1)
      ? "Scrivi il nome da mostrare"
      : cleanLine(name, PUBLIC_NAME_MAX + 1).length > PUBLIC_NAME_MAX
        ? `Al massimo ${PUBLIC_NAME_MAX} caratteri`
        : null;
  const invalid = Boolean(problems.slug || problems.title || problems.message) || projects.some((p) => nameProblem(p.name));

  // The address only once it is the stored one: a link to a path not saved
  // yet would open "Pagina non trovata".
  const link = data.saved && slug === data.slug && data.url ? data.url : null;

  function update(index: number, name: string) {
    setProjects((current) => current.map((entry, i) => (i === index ? { ...entry, name } : entry)));
  }

  function move(index: number, by: -1 | 1) {
    setProjects((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function add(key: string) {
    const candidate = byKey.get(key);
    if (!candidate) return;
    // Prefilled with the name the panel uses, which the owner is looking at
    // and can change: what gets stored is always a name somebody saw here.
    setProjects((current) => [...current, { server: candidate.server, projectId: candidate.projectId, name: cleanLine(candidate.name, PUBLIC_NAME_MAX) }]);
  }

  function reset() {
    setEnabled(data.enabled);
    setSlug(data.slug);
    setTitle(data.title);
    setMessage(data.message);
    setAllowIndexing(data.allowIndexing);
    setProjects(initialProjects);
    setSaveError(null);
  }

  async function save() {
    if (invalid) {
      setSaveError("Correggi i campi segnati");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/status-page", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, slug, title, message, allowIndexing, projects }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSaveError(body.error ?? MSG.saveFailed);
        return;
      }
      toast.success(enabled && !data.enabled ? "Pagina di stato pubblicata" : !enabled && data.enabled ? "Pagina di stato spenta" : "Pagina di stato salvata");
      await onSaved();
    } catch {
      setSaveError(MSG.unreachable);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-muted text-sm leading-relaxed">
        Una pagina che chiunque abbia il link apre senza accedere al pannello: dice se le app che scegli rispondono, con
        l&apos;uptime delle ultime 24 ore e degli ultimi 30 giorni e le interruzioni recenti. Mostra solo il titolo, il
        messaggio e i nomi che scrivi qui: niente indirizzi, porte, server o nomi interni.
      </p>

      <SettingToggle
        label="Pubblica la pagina"
        description={
          enabled
            ? "Chi ha il link la vede. Si applica quando salvi."
            : "Spenta, l'indirizzo risponde «Pagina non trovata», come un indirizzo sbagliato: nessuno scopre che la pagina esiste."
        }
        isSelected={enabled}
        onChange={setEnabled}
      />

      <Field
        label="Indirizzo"
        explain={
          <>
            Le lettere dopo <code className="font-mono">{STATUS_PAGE_BASE}/</code> sono la chiave della pagina: chi le
            sbaglia trova «Pagina non trovata». Quelle proposte sono casuali, così la pagina la trova solo chi riceve il
            link. Un nome facile da ricordare, come «stato», è comodo da dettare, ma chiunque può provarlo. Se il link
            gira dove non deve, generane uno nuovo: quello vecchio smette di funzionare quando salvi.
          </>
        }
        hint="Casuale, così la trova solo chi ha il link. Puoi scriverne uno tuo."
        error={problems.slug}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 basis-56 items-center gap-1.5">
            <span className="text-muted shrink-0 font-mono text-sm">{STATUS_PAGE_BASE}/</span>
            <TextField
              value={slug}
              onChange={(next) => setSlug(next.trim().toLowerCase())}
              aria-label="Percorso della pagina di stato"
              isInvalid={Boolean(problems.slug)}
              className="min-w-0 flex-1"
            >
              <Input className="font-mono text-sm" autoComplete="off" spellCheck={false} autoCapitalize="off" />
            </TextField>
          </div>
          <Button variant="secondary" onPress={() => setSlug(randomSlug())}>
            <Icon icon="solar:restart-linear" width={15} aria-hidden />
            Nuovo indirizzo
          </Button>
        </div>
      </Field>

      {link ? (
        <div className="space-y-1.5">
          <StatusPageLink url={link} />
          {!data.enabled && (
            <p className="text-muted text-meta leading-relaxed">
              La pagina è spenta: aprendo il link la vedi tu, come anteprima, perché sei il proprietario. Gli altri
              trovano «Pagina non trovata».
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted text-meta">Il link compare qui dopo il salvataggio.</p>
      )}

      <Field label="Titolo" error={problems.title}>
        <TextField value={title} onChange={setTitle} aria-label="Titolo della pagina" isInvalid={Boolean(problems.title)}>
          <Input placeholder="Stato dei servizi" />
        </TextField>
      </Field>

      <Field
        label="Messaggio"
        hint="Facoltativo, per esempio una manutenzione programmata. Compare in cima alla pagina così com'è."
        error={problems.message}
      >
        <TextField value={message} onChange={setMessage} aria-label="Messaggio della pagina" isInvalid={Boolean(problems.message)}>
          <TextArea rows={3} placeholder="Sabato dalle 22 alle 23 il sito sarà in manutenzione." />
        </TextField>
      </Field>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-foreground text-sm">Progetti sulla pagina</span>
          <span className="text-muted text-meta">
            {projects.length} di {MAX_PAGE_PROJECTS}
          </span>
        </div>

        {dropped.length > 0 && (
          <Hint tone="warn" title={dropped.length === 1 ? "Un progetto non esiste più" : "Alcuni progetti non esistono più"}>
            {dropped.map((entry) => `«${entry.name}»`).join(", ")}{" "}
            {dropped.length === 1 ? "è stato eliminato e non compare più" : "sono stati eliminati e non compaiono più"} sulla pagina;
            dall&apos;elenco salvato {dropped.length === 1 ? "esce" : "escono"} al prossimo salvataggio.
          </Hint>
        )}

        {projects.length === 0 ? (
          <p className="text-muted border-border rounded-[var(--radius)] border border-dashed px-3 py-3 text-xs leading-relaxed">
            Nessun progetto: la pagina dice «Nessun servizio da mostrare». Aggiungine uno qui sotto.
          </p>
        ) : (
          <ul className="border-border divide-separator divide-y rounded-[var(--radius)] border">
            {projects.map((entry, index) => {
              const candidate = byKey.get(entryKey(entry));
              const check = entry.server === null ? data.checks[entry.projectId] : undefined;
              const problem = nameProblem(entry.name);
              return (
                <li key={entryKey(entry)} className="flex items-start gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1 space-y-1">
                    <TextField
                      value={entry.name}
                      onChange={(next) => update(index, next)}
                      aria-label={`Nome pubblico di ${candidate?.name ?? entry.name}`}
                      isInvalid={Boolean(problem)}
                    >
                      <Input placeholder="Il nome da mostrare" />
                    </TextField>
                    <div className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
                      <span>
                        Nel pannello: {candidate ? <span className="text-foreground">{candidate.name}</span> : "non trovato"}
                      </span>
                      {!isSolo && (
                        <Badge>{entry.server === null ? "questo server" : candidate?.serverName || "server collegato"}</Badge>
                      )}
                    </div>
                    {problem ? (
                      <p role="alert" className="text-danger text-meta">
                        {problem}
                      </p>
                    ) : check && !check.active && check.skip ? (
                      <p className="text-warning text-meta leading-relaxed">{SKIP_TEXT[check.skip]}</p>
                    ) : !candidate && entry.server !== null && list.items ? (
                      <p className="text-warning text-meta leading-relaxed">
                        Il suo server non risponde o non lo elenca: finché è così, sulla pagina comparirà «Nessun dato».
                      </p>
                    ) : null}
                  </div>
                  <RowMenu
                    label={`Azioni per ${entry.name || "questo progetto"}`}
                    actions={[
                      { id: "up", label: "Sposta su", icon: "solar:arrow-up-linear", disabled: index === 0, onAction: () => move(index, -1) },
                      {
                        id: "down",
                        label: "Sposta giù",
                        icon: "solar:arrow-down-linear",
                        disabled: index === projects.length - 1,
                        onAction: () => move(index, 1),
                      },
                      {
                        id: "remove",
                        label: "Togli dalla pagina",
                        icon: "solar:trash-bin-minimalistic-linear",
                        danger: true,
                        onAction: () => setProjects((current) => current.filter((_, i) => i !== index)),
                      },
                    ]}
                    className="mt-1"
                  />
                </li>
              );
            })}
          </ul>
        )}

        {list.error && !list.items ? (
          <LoadError what="l'elenco dei progetti" error={list.error} onRetry={() => void list.refresh()} />
        ) : (
          <SelectField
            ariaLabel="Aggiungi un progetto alla pagina"
            placeholder={
              !list.items
                ? "Caricamento dei progetti…"
                : available.length === 0
                  ? "Tutti i progetti sono già sulla pagina"
                  : "Aggiungi un progetto…"
            }
            value={null}
            onChange={add}
            isDisabled={!list.items || available.length === 0 || projects.length >= MAX_PAGE_PROJECTS}
            options={available.map((c) => ({
              value: entryKey(c),
              label: c.name,
              description: !isSolo ? (c.server === null ? "questo server" : c.serverName) : undefined,
            }))}
          />
        )}
        {list.failed.length > 0 && (
          <p className="text-muted text-meta leading-relaxed">
            {list.failed.map((m) => m.name).join(", ")} non {list.failed.length === 1 ? "risponde" : "rispondono"}: i suoi
            progetti non sono nell&apos;elenco.
          </p>
        )}
        <p className="text-muted text-meta leading-relaxed">
          Il nome pubblico è quello che scrivi: se rinomini il progetto nel pannello, la pagina non cambia. Un progetto
          compare con il suo stato, l&apos;uptime e i giorni degli ultimi 30, misurati dal controllo che l&apos;app
          risponda.
        </p>
      </div>

      <SettingToggle
        label="Lascia che i motori di ricerca la trovino"
        description={
          allowIndexing
            ? "Google e gli altri motori possono metterla nei risultati, con il titolo che hai scelto."
            : "Spento, la pagina chiede ai motori di ricerca di non metterla nei risultati: la vede solo chi ha il link."
        }
        isSelected={allowIndexing}
        onChange={setAllowIndexing}
      />

      <FormError>{saveError}</FormError>

      <StickySaveBar
        isDirty={dirty}
        isPending={saving}
        onSave={() => void save()}
        onReset={reset}
        message="Pagina di stato: modifiche non salvate"
      />
    </div>
  );
}
