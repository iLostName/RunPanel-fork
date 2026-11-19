"use client";

import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { formatRelative, formatWhen } from "@/lib/format";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { FormDialog } from "@/components/ui/FormDialog";
import { KeyValue } from "@/components/ui/KeyValue";
import { Code, Hint } from "@/components/ui/Hint";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonText } from "@/components/ui/Skeletons";
import type { PromotionPreview } from "./types";

const CHANGE_TEXT = {
  added: { title: "Mancano in produzione", tone: "text-warning" },
  changed: { title: "Con un valore diverso", tone: "text-foreground" },
  removed: { title: "Solo in produzione", tone: "text-muted" },
} as const;

/**
 * The confirmation of "Promuovi in produzione": what goes where, written out
 * before anything moves.
 *
 * The commit staging runs, who wrote it and when; the variables the two do
 * not share, by name — the values are secrets, and the question is whether
 * production has what this code expects; and how production will take it,
 * with its own settings. The commit shown is the commit sent: if staging moved
 * in between, the server refuses and the dialog reads it again.
 */
export function PromoteDialog({
  stagingId,
  isOpen,
  onOpenChange,
}: {
  stagingId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const { data, error, refresh } = useResource<PromotionPreview>(api(`/api/projects/${stagingId}/promote`));

  async function submit() {
    if (!data?.commit || !data.production) return false;
    const res = await fetch(api(`/api/projects/${stagingId}/promote`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commitSha: data.commit.sha }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? MSG.updateFailed);
      if (body.code === "staging_moved") void refresh();
      return false;
    }
    toast.success(
      body.status === "queued"
        ? `In coda dopo il deploy in corso di ${data.production.name}`
        : `Produzione distribuisce ${data.commit.sha.slice(0, 7)}`
    );
    router.push(href(`/projects/${data.production.id}`));
  }

  const production = data?.production ?? null;
  const commit = data?.commit ?? null;
  const groups = (["added", "changed", "removed"] as const)
    .map((change) => ({ change, keys: (data?.variables ?? []).filter((v) => v.change === change).map((v) => v.key) }))
    .filter((group) => group.keys.length > 0);

  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title="Promuovere in produzione?"
      submitLabel="Promuovi in produzione"
      isSubmitDisabled={!data || Boolean(data.blocker) || !commit || !production}
      wide
      onSubmit={submit}
    >
      {error && !data && <LoadError what="la promozione" error={error} onRetry={() => void refresh()} />}
      {!data && !error && <SkeletonText className="w-full" />}

      {data?.blocker && <Hint tone="warn">{data.blocker}</Hint>}

      {data && commit && production && !data.blocker && (
        <div className="space-y-4">
          <p className="text-muted text-sm leading-relaxed">
            <strong className="text-foreground">{production.name}</strong> distribuisce il commit che lo staging esegue ora,
            con le sue impostazioni e le sue variabili. Dello staging non arriva nient&apos;altro.
          </p>

          <KeyValue
            items={[
              { label: "Commit", value: <Code>{commit.sha.slice(0, 7)}</Code> },
              ...(commit.message ? [{ label: "Messaggio", value: commit.message }] : []),
              ...(commit.author ? [{ label: "Autore", value: commit.author }] : []),
              ...(commit.date ? [{ label: "Data", value: <span title={formatWhen(commit.date)}>{formatRelative(commit.date)}</span> }] : []),
              { label: "Da", value: `${data.staging.name} · ${data.staging.branch}` },
              { label: "A", value: `${production.name} · ${production.branch}` },
            ]}
          />

          <div className="space-y-2">
            <p className="text-foreground text-sm font-medium">Variabili</p>
            {groups.length === 0 ? (
              <p className="text-muted text-sm">Staging e produzione ricevono gli stessi nomi con gli stessi valori.</p>
            ) : (
              <ul className="space-y-2">
                {groups.map((group) => (
                  <li key={group.change} className="text-sm">
                    <span className={CHANGE_TEXT[group.change].tone}>{CHANGE_TEXT[group.change].title}:</span>{" "}
                    <span className="inline-flex flex-wrap gap-1 align-middle">
                      {group.keys.map((key) => (
                        <Code key={key}>{key}</Code>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {groups.some((group) => group.change === "added") && (
              <Hint tone="warn">
                Lo staging ha variabili che produzione non ha: se il codice le legge, aggiungile a produzione prima di promuovere.
              </Hint>
            )}
          </div>

          <ul className="text-muted list-disc space-y-1 pl-5 text-sm leading-relaxed">
            <li>
              {production.zeroDowntime
                ? "Deploy senza interruzioni: la versione online resta accesa finché la nuova non risponde."
                : production.rollback
                  ? "Se la nuova versione non risponde, torna online quella precedente."
                  : "Un deploy come gli altri di produzione."}
            </li>
            <li>
              Produzione resta su questo commit
              {production.autoDeploy ? `: i push su ${production.branch} non la aggiornano` : ""} finché non scegli «Torna
              all&apos;ultimo commit».
            </li>
          </ul>
        </div>
      )}
    </FormDialog>
  );
}
