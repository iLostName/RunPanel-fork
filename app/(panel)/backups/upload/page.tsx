"use client";

import { useRef, useState } from "react";
import { Button, Input, Label, ProgressBar, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Hint } from "@/components/ui/Hint";
import { KeyValue } from "@/components/ui/KeyValue";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow, RowMenu } from "@/components/ui/ListRow";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useMe } from "@/lib/hooks/useMe";
import { useResource } from "@/lib/hooks/useResource";
import { useCrumbLabel } from "@/lib/hooks/useCrumbLabel";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { formatBytes, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { RestoreDialog } from "@/components/backups/RestoreDialog";
import { triggerLabel } from "../_components/format";
import type { ArtifactView } from "@/components/backups/types";

/**
 * Restoring from an archive that is not in the catalogue: a download kept
 * elsewhere, or the backups of a server that is gone.
 *
 * Three steps on one page — upload, check, restore — because each one can take
 * minutes and the person needs to see which one they are waiting for. The
 * archive goes up in pieces (see services/backup/uploads.ts), is checked whole
 * once it is in, and only an archive that passes offers "Ripristina". The
 * restore itself is the same dialog, and the same safety copy, as for a backup
 * in the catalogue.
 *
 * An archive encrypted on another server stops between the two: the check
 * cannot read it without its password, so the page asks for it there, and
 * the check starts once the panel has tried it against the archive.
 */

interface UploadArtifact {
  id: string;
  kind: string;
  refId: string | null;
  refName: string;
  entryPath: string;
  bytes: number;
  checksum: string | null;
  meta: Record<string, unknown>;
}

interface UploadRecord {
  id: string;
  fileName: string;
  bytes: number;
  received: number;
  status: "uploading" | "checking" | "locked" | "ready" | "invalid";
  message: string | null;
  createdAt: string;
  updatedAt: string;
  progress: { done: number; total: number | null } | null;
  manifest: {
    runId: string;
    policyName: string | null;
    trigger: string;
    createdAt: string;
    panelVersion: string | null;
    storeDriver: string | null;
  } | null;
  artifacts: UploadArtifact[];
  failures: { entryPath: string; reason: string }[];
  /** Null for a plain zip; absent from a server on an older version. */
  encryption?: { keyCreatedAt: string | null; unlocked: boolean } | null;
}

const STATUS: Record<UploadRecord["status"], { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  uploading: { label: "incompleto", tone: "neutral" },
  checking: { label: "in controllo", tone: "accent" },
  locked: { label: "serve la password", tone: "warning" },
  ready: { label: "integro", tone: "success" },
  invalid: { label: "non utilizzabile", tone: "danger" },
};

function asArtifacts(upload: UploadRecord): ArtifactView[] {
  return upload.artifacts.map((artifact) => ({
    ...artifact,
    status: "ok",
    errorMessage: null,
  }));
}

class Refused extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function UploadRestorePage() {
  const api = useNodeApi();
  const href = useServerHref();
  const me = useMe();
  // The trail would otherwise say "upload".
  useCrumbLabel("upload", "Da un archivio");

  const list = useResource<{ uploads: UploadRecord[] }>(me.isOwner ? api("/api/backups/uploads") : null, {
    intervalMs: 0,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const selected = useResource<{ upload: UploadRecord }>(selectedId ? api(`/api/backups/uploads/${selectedId}`) : null, {
    intervalMs: polling ? 1500 : 0,
  });
  // Asked often only while the check runs, or until the first answer arrives.
  // Adjusted during render, not in an effect.
  const watching = selectedId !== null && (!selected.data || selected.data.upload.status === "checking");
  if (polling !== watching) setPolling(watching);

  const [sending, setSending] = useState<{ name: string; done: number; total: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [dragging, setDragging] = useState(false);
  const [restoring, setRestoring] = useState<UploadRecord | null>(null);
  const [deleting, setDeleting] = useState<UploadRecord | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const current = selected.data?.upload ?? null;

  async function json(res: Response) {
    return (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  }

  /** Send the pieces in order, retrying a lost one and resuming where the panel says it got to. */
  async function send(file: File) {
    // The name is only a first filter: the panel reads the format from the bytes.
    if (!/\.zip(\.enc)?$/i.test(file.name)) {
      toast.error("Serve il file di un backup di RunPanel: .zip, oppure .zip.enc se è cifrato");
      return;
    }

    const controller = new AbortController();
    abort.current = controller;
    setSending({ name: file.name, done: 0, total: file.size });
    let id: string | null = null;

    try {
      const created = await fetch(api("/api/backups/uploads"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, bytes: file.size }),
        signal: controller.signal,
      });
      const body = await json(created);
      if (!created.ok) throw new Refused(body.error ?? "Caricamento non avviato");
      const upload = body.upload as UploadRecord;
      const chunkBytes = Number(body.chunkBytes) || 8 * 1024 * 1024;
      id = upload.id;

      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + chunkBytes, file.size);
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await fetch(api(`/api/backups/uploads/${id}/chunk?offset=${offset}&length=${end - offset}`), {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream" },
              body: file.slice(offset, end),
              signal: controller.signal,
            });
            const answer = await json(res);
            if (res.ok) {
              offset = Number(answer.received);
              break;
            }
            if (res.status === 409) {
              // Out of step — a retry the panel had already taken: ask where it is.
              const state = await fetch(api(`/api/backups/uploads/${id}`), { signal: controller.signal });
              const record = (await json(state)).upload as UploadRecord | undefined;
              if (!record || record.status !== "uploading") throw new Refused(answer.error ?? "Caricamento interrotto");
              offset = record.received;
              break;
            }
            if (res.status < 500) throw new Refused(answer.error ?? "Pezzo rifiutato");
            throw new Error(answer.error ?? `HTTP ${res.status}`);
          } catch (err) {
            if (err instanceof Refused || controller.signal.aborted || attempt >= 4) throw err;
            await sleep(1000 * 2 ** attempt);
          }
        }
        setSending({ name: file.name, done: offset, total: file.size });
      }

      const finished = await fetch(api(`/api/backups/uploads/${id}`), { method: "POST", signal: controller.signal });
      const done = await json(finished);
      if (!finished.ok) throw new Refused(done.error ?? "Caricamento non completato");
      toast.success("Archivio caricato: ora lo controllo");
      setSelectedId(id);
      void list.refresh();
    } catch (err) {
      if (controller.signal.aborted) {
        toast.message("Caricamento annullato");
      } else {
        toast.error(err instanceof TypeError ? MSG.unreachable : err instanceof Error ? err.message : "Caricamento non riuscito");
      }
      // A half-sent archive is of no use to anyone and takes the space of a whole one.
      if (id) await fetch(api(`/api/backups/uploads/${id}`), { method: "DELETE" }).catch(() => {});
    } finally {
      abort.current = null;
      setSending(null);
    }
  }

  async function remove(upload: UploadRecord) {
    const res = await fetch(api(`/api/backups/uploads/${upload.id}`), { method: "DELETE" });
    if (!res.ok) {
      toast.error((await json(res)).error ?? MSG.deleteFailed);
      return false;
    }
    toast.success("Archivio caricato eliminato");
    if (selectedId === upload.id) setSelectedId(null);
    void list.refresh();
  }

  if (!me.isOwner) {
    return (
      <>
        <PageHeader title="Ripristina da un archivio" back={{ href: href("/backups"), label: "Torna ai backup" }} />
        <Panel>
          <EmptyState
            icon="solar:lock-keyhole-linear"
            title="Solo il proprietario"
            description="Un archivio caricato può contenere qualsiasi cosa, compreso lo store del pannello: ripristinarlo è riservato al proprietario."
          />
        </Panel>
      </>
    );
  }

  const percent = sending ? Math.round((sending.done / Math.max(1, sending.total)) * 100) : 0;
  // The one open below is the freshest copy of its row.
  const uploads = (list.data?.uploads ?? [])
    .map((upload) => (upload.id === current?.id ? current : upload))
    .filter((upload) => upload.status !== "uploading");

  return (
    <>
      <PageHeader
        title="Ripristina da un archivio"
        description="Un backup scaricato da questo pannello o da un altro server: lo carichi, il pannello lo controlla, e scegli cosa rimettere."
        back={{ href: href("/backups"), label: "Torna ai backup" }}
      />

      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title="1. Carica l'archivio"
            description="Il file di un backup di RunPanel come lo scarichi dalla sua pagina: .zip, oppure .zip.enc se è cifrato con la password dei backup."
          />

          {sending ? (
            <div className="mt-4 space-y-2">
              <p className="text-foreground truncate text-sm">{sending.name}</p>
              <ProgressBar aria-label="Avanzamento del caricamento" value={percent} size="sm">
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted text-xs tabular-nums">
                  {formatBytes(sending.done)} di {formatBytes(sending.total)} · {percent}%
                </p>
                <Button size="sm" variant="ghost" onPress={() => abort.current?.abort()}>
                  Annulla
                </Button>
              </div>
              <p className="text-muted text-meta">Tieni aperta questa pagina finché il caricamento non finisce.</p>
            </div>
          ) : (
            <div
              role="group"
              aria-label="Trascina qui l'archivio"
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files?.[0];
                if (file) void send(file);
              }}
              className={cn(
                "border-border mt-4 flex flex-col items-center gap-3 rounded-[var(--radius)] border border-dashed px-4 py-8 text-center transition-colors",
                dragging && "border-accent bg-accent/5"
              )}
            >
              <Icon icon="solar:upload-minimalistic-linear" width={28} className="text-muted" aria-hidden />
              {/* Nothing is dragged on a touch screen: there the button alone. */}
              <p className="text-muted text-sm pointer-coarse:hidden">Trascina qui il file, oppure</p>
              <Button size="sm" variant="secondary" onPress={() => input.current?.click()}>
                Scegli il file
              </Button>
              <input
                ref={input}
                type="file"
                accept=".zip,.enc,application/zip,application/octet-stream"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void send(file);
                }}
              />
            </div>
          )}

          <Hint tone="info" className="mt-4">
            Serve spazio libero per l&apos;intero archivio più 2 GB di margine. L&apos;archivio resta su questo
            server per 24 ore dall&apos;ultimo uso, poi viene eliminato; puoi eliminarlo prima tu.
          </Hint>
        </Panel>

        {current && (
          // Keyed: a password typed for one archive is not offered to the next.
          <UploadDetail
            key={current.id}
            upload={current}
            onRestore={() => setRestoring(current)}
            onDelete={() => setDeleting(current)}
            onUnlocked={() => {
              void selected.refresh();
              void list.refresh();
            }}
          />
        )}

        {uploads.length > 0 && (
          <Panel padding="flush">
            <div className="p-4 sm:p-5">
              <PanelHeader title="Archivi caricati" description="Quelli ancora su questo server: puoi ripristinarli di nuovo senza ricaricarli." />
            </div>
            <ul className="divide-border divide-y">
              {uploads.map((upload) => (
                <li key={upload.id}>
                  <ListRow
                    icon="solar:archive-linear"
                    title={upload.fileName}
                    badges={<Badge tone={STATUS[upload.status].tone}>{STATUS[upload.status].label}</Badge>}
                    description={`${formatBytes(upload.bytes)} · caricato ${formatWhen(upload.createdAt)}${
                      upload.manifest?.createdAt ? ` · backup del ${formatWhen(upload.manifest.createdAt)}` : ""
                    }`}
                    action={
                      <Button size="sm" variant="secondary" onPress={() => setSelectedId(upload.id)} isDisabled={selectedId === upload.id}>
                        {selectedId === upload.id ? "Aperto" : "Apri"}
                      </Button>
                    }
                    menu={
                      <RowMenu
                        label={`Altre azioni per ${upload.fileName}`}
                        actions={[
                          ...(upload.status === "ready"
                            ? [{ id: "restore", label: "Ripristina…", icon: "solar:restart-linear", onAction: () => setRestoring(upload) }]
                            : []),
                          { id: "delete", label: "Elimina", icon: "solar:trash-bin-trash-linear", danger: true, onAction: () => setDeleting(upload) },
                        ]}
                      />
                    }
                  />
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      {restoring && (
        <RestoreDialog
          source={{ uploadId: restoring.id }}
          artifacts={asArtifacts(restoring)}
          isOpen
          onOpenChange={(open) => !open && setRestoring(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => !open && setDeleting(null)}
          destructive
          title={`Eliminare «${deleting.fileName}»?`}
          description="Viene tolto da questo server. Il file originale, sul tuo computer o dove l'hai preso, non cambia."
          confirmLabel="Elimina"
          onConfirm={() => remove(deleting)}
        />
      )}
    </>
  );
}

function UploadDetail({
  upload,
  onRestore,
  onDelete,
  onUnlocked,
}: {
  upload: UploadRecord;
  onRestore: () => void;
  onDelete: () => void;
  onUnlocked: () => void;
}) {
  const api = useNodeApi();
  const manifest = upload.manifest;
  const checked = upload.progress?.done ?? 0;
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  async function unlock() {
    setUnlocking(true);
    try {
      const res = await fetch(api(`/api/backups/uploads/${upload.id}/unlock`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? "Sblocco non riuscito");
        return;
      }
      setPassword("");
      toast.success("Password giusta: ora controllo l'archivio");
      onUnlocked();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setUnlocking(false);
    }
  }

  return (
    <Panel>
      <PanelHeader
        title={
          upload.status === "ready"
            ? "3. Scegli cosa ripristinare"
            : upload.status === "locked"
              ? "2. Sblocca l'archivio"
              : "2. Controllo dell'archivio"
        }
        description={upload.fileName}
        actions={
          <Button size="sm" variant="ghost" onPress={onDelete} className="text-danger">
            Elimina
          </Button>
        }
      />

      {upload.status === "checking" && (
        <div className="mt-4 flex items-start gap-3">
          <Icon icon="solar:refresh-linear" width={18} className="text-muted mt-0.5 shrink-0 animate-spin" aria-hidden />
          <p className="text-muted text-sm">
            Leggo ogni file dell&apos;archivio e lo confronto con il suo checksum
            {checked > 0 ? ` (${formatBytes(checked)} letti)` : ""}. Per un archivio grande ci vuole qualche minuto.
          </p>
        </div>
      )}

      {upload.status === "locked" && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (password && !unlocking) void unlock();
          }}
        >
          <div className="flex items-start gap-3">
            <Icon icon="solar:lock-password-linear" width={18} className="text-warning mt-0.5 shrink-0" aria-hidden />
            <p className="text-muted text-sm">{upload.message}</p>
          </div>
          <TextField type="password" value={password} onChange={setPassword} className="max-w-md">
            <Label>Password dei backup</Label>
            <Input autoComplete="off" spellCheck={false} />
          </TextField>
          <p className="text-muted text-xs">
            Quella in uso sul server di origine il giorno del backup: se nel frattempo è stata cambiata, serve quella di
            prima. Il pannello la tiene con l&apos;archivio caricato e la cancella insieme a lui.
          </p>
          <Button type="submit" isPending={unlocking} isDisabled={!password}>
            <Icon icon="solar:lock-unlocked-linear" width={16} aria-hidden />
            Sblocca e controlla
          </Button>
        </form>
      )}

      {upload.status === "invalid" && (
        <Hint tone="warn" className="mt-4" title="Da questo archivio non si può ripristinare">
          {upload.message}
        </Hint>
      )}

      {upload.status === "uploading" && (
        <p className="text-muted mt-4 text-sm">
          Caricamento incompleto: {formatBytes(upload.received)} di {formatBytes(upload.bytes)}. Caricalo di nuovo.
        </p>
      )}

      {upload.status === "ready" && manifest && (
        <>
          <div className="mt-4 flex items-start gap-3">
            <Icon icon="solar:shield-check-linear" width={18} className="text-success mt-0.5 shrink-0" aria-hidden />
            <p className="text-muted text-sm">{upload.message}</p>
          </div>

          <KeyValue
            className="mt-4"
            items={[
              { label: "Backup del", value: manifest.createdAt ? formatWhen(manifest.createdAt) : "—" },
              { label: "Pianificazione", value: manifest.policyName ?? triggerLabel(manifest.trigger) },
              { label: "Elementi", value: `${upload.artifacts.length}` },
              { label: "Dimensione", value: formatBytes(upload.bytes) },
              {
                label: "Cifratura",
                value: upload.encryption
                  ? `password dei backup${upload.encryption.keyCreatedAt ? ` del ${formatWhen(upload.encryption.keyCreatedAt)}` : ""}`
                  : "nessuna",
              },
              { label: "Pannello", value: manifest.panelVersion ?? "—", technical: true, mono: true },
              { label: "Run", value: manifest.runId, technical: true, mono: true },
            ]}
          />

          <ul className="text-muted mt-4 space-y-1 text-xs">
            {upload.artifacts.map((artifact) => (
              <li key={artifact.id} className="flex items-center justify-between gap-3">
                <span className="text-foreground truncate">{artifact.refName}</span>
                <span className="shrink-0 tabular-nums">{formatBytes(artifact.bytes)}</span>
              </li>
            ))}
          </ul>

          <Hint tone="warn" className="mt-4" title="Ripristinare sostituisce quello che c'è adesso">
            Nel passo successivo scegli dove va ogni elemento: se l&apos;archivio viene da un altro server, i progetti e
            i database con quei nomi devono esistere già qui. Prima di toccare qualsiasi cosa il pannello fa una copia di
            sicurezza di quello che sta per sostituire. Le configurazioni dei progetti sono cifrate con la chiave del
            pannello che le ha salvate: da un altro pannello si possono ripristinare i dati, non le configurazioni.
          </Hint>

          <div className="mt-4">
            <Button onPress={onRestore} isDisabled={upload.artifacts.length === 0}>
              <Icon icon="solar:restart-linear" width={16} aria-hidden />
              Ripristina…
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
