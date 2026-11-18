"use client";

import { useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { SelectField } from "@/components/ui/SelectField";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { ServerPicker } from "@/components/cluster/ServerBits";
import { GithubConnectDialog } from "@/components/github/GithubConnectDialog";
import type { GhRepo, PickedSource } from "./types";

/** The upload route's own limit, checked here so a 300 MB file fails in a second, not after the upload. */
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

/**
 * Step 1: where the code comes from.
 *
 * Nothing is created here. The choice is kept by the wizard and only becomes a
 * project at the very end, so leaving the page leaves nothing behind.
 */
export function SourceStep({
  initial,
  onContinue,
}: {
  initial: PickedSource | null;
  /** With whether GitHub is connected, which the next step needs for auto-deploy. */
  onContinue: (source: PickedSource, githubConnected: boolean) => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  // Both: choosing a repository needs GitHub, and the server guards what code a
  // project runs behind the host permission (lib/host-guard.ts).
  const hasGithub = useCan("github");
  const hasHost = useCan("host");
  const canGithub = hasGithub && hasHost;
  const [kind, setKind] = useState<PickedSource["kind"]>(initial?.kind ?? (canGithub ? "github" : "zip"));

  // --- GitHub ---------------------------------------------------------------
  const [url, setUrl] = useState(initial?.kind === "github" ? initial.url : "");
  const [branch, setBranch] = useState(initial?.kind === "github" ? initial.branch : "");
  const [repo, setRepo] = useState<GhRepo | null>(initial?.kind === "github" ? initial.repo : null);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(initial?.kind === "github" && !initial.repo);
  const [connectOpen, setConnectOpen] = useState(false);

  const {
    data: repoData,
    loading: reposLoading,
    error: reposError,
    refresh: refreshRepos,
  } = useResource<{ connected?: boolean; repos?: GhRepo[] }>(hasGithub ? api("/api/github/repos") : null);
  const connected = repoData?.connected ?? false;
  const repos = repoData?.repos ?? [];
  const needle = search.trim().toLowerCase();
  const filtered = needle ? repos.filter((r) => r.full_name.toLowerCase().includes(needle)) : repos;

  const { data: branchData, loading: branchesLoading } = useResource<{ branches?: { name: string }[] }>(
    repo ? api(`/api/github/branches?repo=${encodeURIComponent(repo.full_name)}`) : null
  );
  const branches = branchData?.branches ?? [];

  function pickRepo(next: GhRepo) {
    setRepo(next);
    setUrl(next.clone_url);
    setBranch(next.default_branch);
    setManual(false);
  }

  // --- ZIP ------------------------------------------------------------------
  const [file, setFile] = useState<File | null>(initial?.kind === "zip" ? initial.file : null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function takeFile(next: File | null | undefined) {
    if (!next) return;
    if (!/\.zip$/i.test(next.name)) {
      setFileError("Serve un file .zip");
      return;
    }
    if (next.size > MAX_ZIP_BYTES) {
      setFileError(`L'archivio pesa ${(next.size / 1024 / 1024).toFixed(0)} MB: il massimo è 100 MB`);
      return;
    }
    setFileError(null);
    setFile(next);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    takeFile(event.dataTransfer.files?.[0]);
  }

  const ready = kind === "github" ? url.trim().length > 0 : file !== null;

  function next() {
    if (kind === "github") onContinue({ kind: "github", url: url.trim(), branch: branch.trim(), repo }, connected);
    else if (file) onContinue({ kind: "zip", file }, connected);
  }

  return (
    <div className="max-w-2xl space-y-4">
      <ServerPicker description="Il progetto vivrà su questo server: build, file e processi stanno lì." />

      <ChoiceGroup label="Da dove arriva il codice" className="sm:grid-cols-3">
        <ChoiceCard
          selected={kind === "github"}
          onSelect={() => setKind("github")}
          isDisabled={!canGithub}
          icon="solar:code-linear"
          title="Da GitHub"
          description={
            canGithub
              ? "Il codice sta in un repository: l'app si aggiorna da sola a ogni push."
              : `Serve il permesso ${hasGithub ? "Accesso all'host" : "GitHub"}: chiedilo a chi gestisce il pannello.`
          }
        />
        <ChoiceCard
          selected={kind === "zip"}
          onSelect={() => setKind("zip")}
          icon="solar:archive-linear"
          title="Da un archivio ZIP"
          description="Carichi i file del progetto. Per aggiornarla, ricarichi lo ZIP."
        />
        {/* Not a third kind of source: the catalogue has its own page and its own install. */}
        <ChoiceCard
          selected={false}
          onSelect={() => router.push(href("/projects/new/catalog"))}
          isDisabled={!hasHost}
          icon="solar:widget-add-linear"
          title="Da un modello"
          description={
            hasHost
              ? "Un'app pronta (n8n, WordPress, Uptime Kuma…): poche domande e va online."
              : "Serve il permesso Accesso all'host: chiedilo a chi gestisce il pannello."
          }
        />
      </ChoiceGroup>

      {kind === "github" ? (
        <Panel className="space-y-4">
          <PanelHeader title="Repository" description="Scegli il codice da mettere online" />

          {repo ? (
            <div className="border-border bg-surface-secondary flex items-center gap-3 rounded-[var(--radius)] border px-3 py-2.5">
              <Icon icon="solar:folder-with-files-linear" width={18} className="text-accent shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm">{repo.full_name}</p>
                {repo.description && <p className="text-muted truncate text-xs">{repo.description}</p>}
              </div>
              {repo.private && <Icon icon="solar:lock-linear" width={14} className="text-muted shrink-0" aria-label="privato" />}
              <Button variant="ghost" size="sm" className="shrink-0" onPress={() => setRepo(null)}>
                Cambia
              </Button>
            </div>
          ) : connected ? (
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted text-sm font-medium">
                  I tuoi repository{repos.length > 0 ? ` (${filtered.length})` : ""}
                </span>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Cerca…"
                  aria-label="Cerca repository"
                  className="max-w-[200px] min-w-0"
                />
              </div>
              {reposLoading ? (
                <p className="text-muted px-3 py-6 text-center text-sm">Carico i repository…</p>
              ) : filtered.length === 0 ? (
                <p className="text-muted px-3 py-6 text-center text-sm">
                  {repos.length === 0 ? "Il token non vede nessun repository" : "Nessun repository con questo nome"}
                </p>
              ) : (
                <ul className="border-border divide-separator max-h-72 divide-y overflow-auto rounded-[var(--radius)] border">
                  {filtered.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => pickRepo(r)}
                        className="hover:bg-surface-hover flex w-full items-center gap-2 px-3 py-2 text-left transition-colors"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground block truncate text-sm">{r.full_name}</span>
                          {r.description && <span className="text-muted block truncate text-xs">{r.description}</span>}
                        </span>
                        {r.private && <Icon icon="solar:lock-linear" width={13} className="text-muted shrink-0" aria-label="privato" />}
                        {r.language && <span className="text-muted text-meta shrink-0 font-mono">{r.language}</span>}
                        <span className="text-muted text-meta shrink-0 tabular-nums">{formatRelative(r.updated_at)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="ghost" size="sm" className="mt-2" onPress={() => setManual((v) => !v)}>
                {manual ? "Nascondi" : "Oppure incolla un indirizzo"}
              </Button>
            </div>
          ) : reposError && !repoData ? (
            // A failed list (rate limit, network) is not "no account": nobody
            // should be sent to reconnect GitHub over it.
            <LoadError what="i repository" error={reposError} onRetry={() => void refreshRepos()} />
          ) : (
            <Hint tone="tip" icon="solar:code-linear" title="Collega GitHub per scegliere dall'elenco">
              <p>
                Così puoi usare anche i repository privati e l&apos;app si aggiorna da sola a ogni push. Per un repository
                pubblico basta incollare l&apos;indirizzo qui sotto.
              </p>
              <Button variant="secondary" size="sm" className="mt-3" onPress={() => setConnectOpen(true)}>
                <Icon icon="solar:link-round-linear" width={16} aria-hidden />
                Collega GitHub
              </Button>
            </Hint>
          )}

          {(manual || (!connected && !repo)) && (
            <TextField value={url} onChange={(value) => { setUrl(value); setRepo(null); }}>
              <Label>Indirizzo del repository</Label>
              <Input placeholder="https://github.com/utente/progetto" className="font-mono text-sm" />
            </TextField>
          )}

          {(repo || url.trim()) && (
            <div>
              {repo && branches.length > 0 ? (
                <SelectField
                  label="Branch"
                  value={branch}
                  onChange={setBranch}
                  options={branches.map((b) => ({
                    value: b.name,
                    label: `${b.name}${b.name === repo.default_branch ? " (principale)" : ""}`,
                  }))}
                />
              ) : (
                <TextField value={branch} onChange={setBranch}>
                  <Label>Branch</Label>
                  <Input className="font-mono text-sm" placeholder={branchesLoading ? "Carico i branch…" : "main"} />
                </TextField>
              )}
              <FieldHint>È la versione del codice che va online. Vuoto vuol dire main.</FieldHint>
            </div>
          )}
        </Panel>
      ) : (
        <Panel className="space-y-3">
          <PanelHeader title="Archivio ZIP" description="Fino a 100 MB" />
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInput.current?.click()}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), fileInput.current?.click())}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            aria-label="Scegli o trascina un archivio ZIP"
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-4 py-10 text-center transition-colors",
              "focus-visible:ring-accent focus-visible:ring-2 focus-visible:outline-none",
              dragging ? "border-accent bg-accent/5" : "border-border hover:bg-surface-hover"
            )}
          >
            <Icon icon={file ? "solar:file-check-linear" : "solar:cloud-upload-linear"} width={28} className={file ? "text-success" : "text-muted"} aria-hidden />
            {file ? (
              <>
                <p className="text-foreground text-sm font-medium">{file.name}</p>
                <p className="text-muted text-xs">{(file.size / 1024 / 1024).toFixed(1)} MB · premi per sceglierne un altro</p>
              </>
            ) : (
              <>
                <p className="text-foreground text-sm font-medium">Trascina qui lo ZIP, oppure premi per sceglierlo</p>
                <p className="text-muted text-xs">Va bene anche uno ZIP con una sola cartella dentro: viene aperta da sola.</p>
              </>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => takeFile(e.target.files?.[0])}
          />
          {fileError && <p className="text-danger text-sm" role="alert">{fileError}</p>}
        </Panel>
      )}

      <div className="flex justify-end">
        <Button variant="primary" isDisabled={!ready} onPress={next}>
          Continua
          <Icon icon="solar:arrow-right-linear" width={16} aria-hidden />
        </Button>
      </div>

      <GithubConnectDialog
        isOpen={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={() => {
          setConnectOpen(false);
          void refreshRepos();
        }}
      />
    </div>
  );
}
