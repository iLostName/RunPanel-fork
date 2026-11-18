"use client";

import { useState } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ListRow, RowMenu } from "@/components/ui/ListRow";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormDialog } from "@/components/ui/FormDialog";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { LinkButton } from "@/components/ui/LinkButton";
import { LoadError } from "@/components/ui/LoadError";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { ServerBadge } from "@/components/cluster/ServerBits";
import { PEER_FOLDER } from "@/lib/backup-peer";
import { formatBytes, formatRelative, formatWhen } from "@/lib/format";
import { useMe } from "@/lib/hooks/useMe";
import { useMemberApi } from "@/lib/hooks/useNode";
import { useResource } from "@/lib/hooks/useResource";
import type { Located } from "@/lib/cluster-merge";
import type { HostedArchiveView, HostedDiskView, HostedSourceView } from "@/components/backups/types";

type Row = Located<HostedSourceView>;

const GB = 1024 ** 3;

function archivesLine(row: HostedSourceView): string {
  const held =
    row.archives > 0
      ? `${row.archives} ${row.archives === 1 ? "archivio" : "archivi"} · ${formatBytes(row.bytes)}${row.lastReceivedAt ? ` · l'ultimo ${formatRelative(row.lastReceivedAt)}` : ""}`
      : "Nessuna copia per ora";
  const arriving = row.incoming.count === 0 ? "" : row.incoming.count === 1 ? " · una copia in arrivo" : ` · ${row.incoming.count} copie in arrivo`;
  return held + arriving;
}

function limitLine(row: HostedSourceView, disk: HostedDiskView | null | undefined): string {
  if (row.quotaBytes === 0) return "Nuove copie rifiutate: quelle che ci sono restano";
  if (row.quotaBytes === null) {
    return disk ? `Nessun limite: sul disco restano sempre almeno ${formatBytes(disk.reserveBytes)} per questo server` : "Nessun limite";
  }
  const used = Math.min(100, Math.round((row.bytes * 100) / Math.max(1, row.quotaBytes)));
  return `Limite ${formatBytes(row.quotaBytes)} · ${used}% usato`;
}

/**
 * The copies this server keeps for the other servers of its cluster: one row
 * per source, how much it takes and the limit it was given — the owner sets
 * the limit, lists the archives (the way back for a server that was lost:
 * download, then "Ripristina da un archivio" on its replacement) and deletes
 * them. A server that is no longer linked keeps its row while its copies are
 * here.
 *
 * Nothing at all on a server that is alone and keeps nothing: the panel is
 * about the cluster, and a page full of empty sections helps nobody.
 */
export function HostedCopiesPanel({
  sources,
  disks,
  loaded,
  error,
  isSolo,
  onChanged,
}: {
  sources: Row[];
  /** The disk of each server that keeps copies, by its member id. */
  disks: Record<string, HostedDiskView | null | undefined>;
  loaded: boolean;
  error: string | null;
  isSolo: boolean;
  onChanged: () => void;
}) {
  const memberApi = useMemberApi();
  const me = useMe();
  const [limiting, setLimiting] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (isSolo && sources.length === 0 && !error) return null;

  const total = sources.reduce((sum, row) => sum + row.bytes, 0);
  const keyOf = (row: Row) => `${row.memberId}:${row.sourceId}`;

  async function remove(row: Row) {
    const res = await fetch(memberApi(row.memberId, `/api/backups/hosted/${row.sourceId}?confirm=${encodeURIComponent(row.name)}`), {
      method: "DELETE",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.deleteFailed);
      return false;
    }
    toast.success(`Copie di «${row.name}» eliminate: liberati ${formatBytes(body.bytes ?? row.bytes)}.`);
    if (open === keyOf(row)) setOpen(null);
    onChanged();
  }

  return (
    <Panel padding="flush">
      <div className="p-4 sm:p-5">
        <PanelHeader
          title="Copie per altri server"
          description={
            <>
              Gli archivi che gli altri server del cluster tengono qui, in <Code>{PEER_FOLDER}</Code>: una cartella per
              server, separata dai backup di questo.{total > 0 ? ` In tutto occupano ${formatBytes(total)}.` : ""}
            </>
          }
        />
      </div>

      {error && !loaded ? (
        <LoadError what="le copie per altri server" error={error} onRetry={onChanged} className="px-4 pb-4 sm:px-5" />
      ) : !loaded ? (
        <div className="space-y-2 px-4 pb-4 sm:px-5">
          <SkeletonBlock className="h-12" />
        </div>
      ) : sources.length === 0 ? (
        <p className="text-muted px-4 pb-4 text-sm sm:px-5">
          Nessun altro server tiene copie qui. Per mandarne, sull&apos;altro server aggiungi la destinazione «Server RunPanel
          collegato» e scegli questo.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {sources.map((row) => (
            <li key={keyOf(row)}>
              <ListRow
                icon="solar:server-path-linear"
                title={row.name}
                badges={
                  <>
                    {!row.linked && <Badge tone="warning">Non più collegato</Badge>}
                    {row.quotaBytes === 0 && <Badge tone="neutral">Rifiutate</Badge>}
                    {!isSolo && <ServerBadge memberId={row.memberId} />}
                  </>
                }
                description={archivesLine(row)}
                meta={limitLine(row, disks[row.memberId])}
                action={
                  me.isOwner ? (
                    <Button size="sm" variant="secondary" onPress={() => setLimiting(row)}>
                      Imposta limite
                    </Button>
                  ) : undefined
                }
                menu={
                  me.isOwner ? (
                    <RowMenu
                      label={`Altre azioni per le copie di ${row.name}`}
                      actions={[
                        {
                          id: "archives",
                          label: open === keyOf(row) ? "Nascondi gli archivi" : "Mostra gli archivi",
                          icon: "solar:archive-linear",
                          disabled: row.archives === 0,
                          onAction: () => setOpen(open === keyOf(row) ? null : keyOf(row)),
                        },
                        {
                          id: "delete",
                          label: "Elimina le copie…",
                          icon: "solar:trash-bin-trash-linear",
                          danger: true,
                          disabled: row.archives === 0,
                          onAction: () => setDeleting(row),
                        },
                      ]}
                    />
                  ) : undefined
                }
              />
              {open === keyOf(row) && <HostedArchives row={row} />}
            </li>
          ))}
        </ul>
      )}

      {limiting && (
        <QuotaDialog
          row={limiting}
          disk={disks[limiting.memberId]}
          onClose={() => setLimiting(null)}
          onSaved={() => {
            setLimiting(null);
            onChanged();
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          isOpen
          onOpenChange={(next) => !next && setDeleting(null)}
          destructive
          title={`Eliminare le copie di «${deleting.name}»?`}
          confirmLabel="Elimina le copie"
          confirmText={deleting.name}
          description={
            <>
              <p>
                Qui ci sono {deleting.archives} archivi di «{deleting.name}» ({formatBytes(deleting.bytes)}). Vengono
                cancellati da questo server: «{deleting.name}» non potrà più ripristinarli da questa copia, ma le altre copie
                dei suoi backup, se ne ha, restano.
              </p>
              {deleting.linked && (
                <p className="mt-2">
                  «{deleting.name}» continuerà a mandare le copie nuove: per fermarle, imposta il limite su «Non accettare».
                </p>
              )}
            </>
          }
          onConfirm={() => remove(deleting)}
        />
      )}
    </Panel>
  );
}

/** The archives of one source, newest first, each with its download. Asked when the row opens, not before. */
function HostedArchives({ row }: { row: Row }) {
  const memberApi = useMemberApi();
  const list = useResource<{ archives: HostedArchiveView[] }>(memberApi(row.memberId, `/api/backups/hosted/${row.sourceId}/archives`));

  return (
    <div className="bg-surface-secondary/40 border-border space-y-2 border-t px-4 py-3 sm:px-5">
      {list.error && !list.data ? (
        <LoadError what="gli archivi" error={list.error} onRetry={() => void list.refresh()} />
      ) : !list.data ? (
        <SkeletonBlock className="h-8" />
      ) : (
        <ul className="space-y-1">
          {list.data.archives.map((archive) => (
            <li key={archive.ref} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="text-foreground min-w-0 flex-1 truncate font-mono">{archive.name}</span>
              <span className="text-muted shrink-0">{formatBytes(archive.bytes)}</span>
              <span className="text-muted hidden shrink-0 sm:inline" title={formatWhen(archive.createdAt)}>
                {formatRelative(archive.createdAt)}
              </span>
              <LinkButton
                href={memberApi(row.memberId, `/api/backups/hosted/${row.sourceId}/download?ref=${encodeURIComponent(archive.ref)}`)}
                variant="ghost"
                download
                aria-label={`Scarica ${archive.name}`}
              >
                <Icon icon="solar:download-linear" width={15} aria-hidden />
              </LinkButton>
            </li>
          ))}
        </ul>
      )}
      <FieldHint className="mt-0">
        Se «{row.name}» si perde, scarica un archivio da qui e caricalo in Backup › Ripristina da un archivio sul server che
        lo sostituisce. Se è cifrato, serve la password dei backup di «{row.name}».
      </FieldHint>
    </div>
  );
}

type QuotaMode = "none" | "limit" | "refuse";

/** How much room a source may take here: no limit of its own, a number of GB, or none at all. */
function QuotaDialog({
  row,
  disk,
  onClose,
  onSaved,
}: {
  row: Row;
  disk: HostedDiskView | null | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const memberApi = useMemberApi();
  const [mode, setMode] = useState<QuotaMode>(row.quotaBytes === null ? "none" : row.quotaBytes === 0 ? "refuse" : "limit");
  const [gb, setGb] = useState(row.quotaBytes ? String(Math.round((row.quotaBytes / GB) * 10) / 10) : String(Math.max(10, Math.ceil((row.bytes * 2) / GB))));
  const value = Number(gb.replace(",", "."));
  const gbError = mode === "limit" && (!Number.isFinite(value) || value <= 0) ? "Scrivi quanti GB, per esempio 50" : undefined;

  async function submit() {
    const quotaBytes = mode === "none" ? null : mode === "refuse" ? 0 : Math.round(value * GB);
    const res = await fetch(memberApi(row.memberId, `/api/backups/hosted/${row.sourceId}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaBytes }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.saveFailed);
      throw new Error(body.error ?? "quota failed");
    }
    toast.success(
      quotaBytes === null
        ? `«${row.name}» può usare lo spazio libero, tranne la riserva di questo server.`
        : quotaBytes === 0
          ? `Nuove copie di «${row.name}» rifiutate.`
          : `«${row.name}» può tenere qui fino a ${formatBytes(quotaBytes)}.`
    );
    onSaved();
  }

  return (
    <FormDialog
      isOpen
      onOpenChange={(next) => !next && onClose()}
      title={`Spazio per «${row.name}»`}
      submitLabel="Salva"
      isSubmitDisabled={Boolean(gbError)}
      onSubmit={submit}
    >
      <Segmented
        label="Quanto spazio"
        value={mode}
        onChange={setMode}
        options={[
          { value: "none", label: "Nessun limite" },
          { value: "limit", label: "Un limite" },
          { value: "refuse", label: "Non accettare" },
        ]}
      />
      {mode === "limit" && (
        <Field label="Limite" error={gbError} hint={`Ora ne usa ${formatBytes(row.bytes)}.`}>
          <TextField value={gb} onChange={setGb} aria-label="Limite in GB" isInvalid={Boolean(gbError)}>
            <div className="flex items-center gap-2">
              <Input inputMode="decimal" className="w-32 font-mono text-sm" />
              <span className="text-muted text-sm">GB</span>
            </div>
          </TextField>
        </Field>
      )}
      <FieldHint>
        {mode === "none"
          ? `Le copie di «${row.name}» possono usare lo spazio libero del disco, tranne la riserva che resta sempre a questo server${disk ? ` (${formatBytes(disk.reserveBytes)}; ora liberi ${formatBytes(disk.freeBytes)})` : ""}.`
          : mode === "limit"
            ? `Una copia che lo supererebbe viene rifiutata, e «${row.name}» lo dice nel suo backup. La riserva del disco vale comunque.`
            : `«${row.name}» non può mandare copie nuove: il suo backup lo dice, e le sue altre destinazioni restano valide.`}
      </FieldHint>
      <Hint tone="info">Le copie che ci sono già restano anche oltre il limite: un limite ferma solo le prossime, non ne elimina nessuna.</Hint>
    </FormDialog>
  );
}
