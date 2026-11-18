"use client";

import { useState } from "react";
import { Button, ProgressBar } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { Technical } from "@/components/ui/Technical";
import { Code } from "@/components/ui/Hint";
import { useResource } from "@/lib/hooks/useResource";
import { useNodeApi } from "@/lib/hooks/useNode";
import { formatBytes, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";

/** What `GET /api/backups/runs/:id/verify` answers. */
export interface VerificationView {
  status: "running" | "ok" | "failed";
  message: string;
  startedAt: string | null;
  checkedAt: string | null;
  depth: "full" | "archive" | null;
  progress: { done: number; total: number | null } | null;
  failures: { entryPath: string; reason: string }[];
}

/**
 * "Is this backup still good?", answered by reading it back.
 *
 * The plain answer is a sentence and a colour. Which member failed, and the
 * archive's sha256, are for expert mode: they change nothing a person does
 * next, which is take another backup.
 */
export function IntegrityCheck({ runId, checksum, className }: { runId: string; checksum: string | null; className?: string }) {
  const api = useNodeApi();
  const [polling, setPolling] = useState(false);
  const [starting, setStarting] = useState(false);
  const { data, refresh } = useResource<{ verification: VerificationView | null }>(api(`/api/backups/runs/${runId}/verify`), {
    intervalMs: polling ? 1500 : 0,
  });
  const verification = data?.verification ?? null;
  const running = verification?.status === "running";

  // Ask often while a check runs — started here or in another tab — and stop
  // once it has an answer. Adjusted during render, not in an effect.
  if (polling !== running && !(polling && !verification)) setPolling(running);

  async function start() {
    setStarting(true);
    try {
      const res = await fetch(api(`/api/backups/runs/${runId}/verify`), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Verifica non avviata");
        return;
      }
      setPolling(true);
      await refresh();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setStarting(false);
    }
  }

  const progress = verification?.progress;
  const percent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className={cn("flex flex-wrap items-start gap-3", className)}>
      <Icon
        icon={
          running
            ? "solar:refresh-linear"
            : verification?.status === "ok"
              ? "solar:shield-check-linear"
              : verification?.status === "failed"
                ? "solar:danger-circle-linear"
                : "solar:shield-check-linear"
        }
        width={18}
        aria-hidden
        className={cn(
          "mt-0.5 shrink-0",
          running && "animate-spin",
          verification?.status === "ok" ? "text-success" : verification?.status === "failed" ? "text-danger" : "text-muted"
        )}
      />
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-foreground font-medium">
          {running
            ? "Verifica dell'integrità in corso…"
            : verification?.status === "ok"
              ? "Archivio integro"
              : verification?.status === "failed"
                ? "Archivio danneggiato o non leggibile"
                : "Integrità mai verificata"}
        </p>
        <p className="text-muted mt-0.5 text-xs">
          {running
            ? progress
              ? `${formatBytes(progress.done)}${progress.total ? ` di ${formatBytes(progress.total)}` : ""} letti`
              : "Inizio a leggere l'archivio…"
            : verification
              ? `${verification.message}${verification.checkedAt ? ` · ${formatWhen(verification.checkedAt)}` : ""}`
              : "Rilegge l'archivio e lo confronta con quello che è stato registrato quando è stato creato. Ogni ripristino lo fa comunque, prima di toccare qualsiasi cosa."}
        </p>
        {running && percent !== null && (
          <ProgressBar aria-label="Avanzamento della verifica" value={percent} size="sm" className="mt-2 max-w-sm">
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}
        {verification?.status === "failed" && (
          <p className="text-muted mt-1 text-xs">
            Fai un nuovo backup appena puoi: questo non è affidabile per un ripristino.
          </p>
        )}
        <Technical>
          {verification?.failures && verification.failures.length > 0 && (
            <ul className="text-muted mt-2 space-y-0.5 font-mono text-meta">
              {verification.failures.map((failure) => (
                <li key={failure.entryPath}>
                  {failure.entryPath}: {failure.reason}
                </li>
              ))}
            </ul>
          )}
          {checksum && (
            <p className="text-muted mt-2 text-meta">
              sha256 registrato: <Code className="break-all">{checksum}</Code>
              {verification?.depth === "archive" && " · per un archivio fuori da questo server si confronta il solo sha256"}
            </p>
          )}
        </Technical>
      </div>
      <Button size="sm" variant="secondary" onPress={start} isPending={starting} isDisabled={running}>
        <Icon icon="solar:shield-check-linear" width={15} aria-hidden />
        Verifica integrità
      </Button>
    </div>
  );
}
