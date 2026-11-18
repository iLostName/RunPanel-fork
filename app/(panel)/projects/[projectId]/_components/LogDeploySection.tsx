"use client";

import { useMemo, useState } from "react";
import { Button, Input, Label, SearchField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { LogViewer, type LogLine } from "@/components/ui/LogViewer";
import { Hint } from "@/components/ui/Hint";
import { Tip } from "@/components/ui/Tooltip";
import { DEPLOY_PHASES, deployPhase, explainDeployError, type DeployPhase } from "@/lib/deploy-explain";
import { makeLogFilter } from "@/lib/log-search";
import { useNodeApi } from "@/lib/hooks/useNode";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The build output of the deploy on screen, and how it went.
 *
 * The title said "Deploy in corso" for as long as the lines stayed on screen,
 * so a deploy that had failed ten minutes earlier still read as running. The
 * pipeline ends every log with a banner (`=== Deploy successful ===`, `===
 * Deploy FAILED: … ===`), which is what is read here: it is in the lines this
 * component already has, so the title follows the deploy without asking the
 * server. `deploying`, when the page passes it, settles the case of a log that
 * stopped before its banner.
 */
export function LogDeploySection({
  lines,
  deploying,
  projectId,
  deploymentId,
}: {
  lines: LogLine[];
  deploying?: boolean;
  projectId?: string;
  deploymentId?: string;
}) {
  const api = useNodeApi();
  const [query, setQuery] = useState("");
  const [downloading, setDownloading] = useState(false);

  const state = useMemo(() => readOutcome(lines), [lines]);
  const finished = state.phase === "done" || state.phase === "failed";
  const running = !finished && deploying !== false;
  const explanation = useMemo(
    () => (state.phase === "failed" ? explainDeployError(state.message, tailText(lines)) : null),
    [state, lines]
  );

  const filter = useMemo(() => makeLogFilter({ query }), [query]);
  const shown = useMemo(() => (query.trim() ? lines.filter(filter) : lines), [lines, filter, query]);

  const title =
    state.phase === "done"
      ? "Ultimo deploy riuscito"
      : state.phase === "failed"
        ? "Ultimo deploy non riuscito"
        : running
          ? "Deploy in corso"
          : "Ultimo deploy";
  const phaseLabel = running ? (DEPLOY_PHASES.find((step) => step.id === state.phase)?.label ?? "In preparazione") : null;
  const dot =
    state.phase === "done" ? "bg-success" : state.phase === "failed" ? "bg-danger" : running ? "bg-warning animate-pulse" : "bg-muted";

  async function download() {
    setDownloading(true);
    try {
      // The whole log from the server when the deploy can be found, which is
      // more than the last two thousand lines this view keeps; the lines on
      // screen otherwise.
      const id = deploymentId ?? (projectId ? await latestDeploymentId(api, projectId) : null);
      let text = lines.map((line) => line.text).join("\n");
      if (id) {
        const res = await fetch(api(`/api/deployments/${id}`), { cache: "no-store" });
        const data = res.ok ? ((await res.json()) as { build_log?: unknown }) : null;
        if (typeof data?.build_log === "string" && data.build_log) text = data.build_log;
      }
      saveTextFile(`deploy-${id ?? "log"}.txt`, text);
    } catch {
      toast.error("Download non riuscito");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section aria-label="Log del deploy">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
          <h2 className="text-foreground text-sm font-medium">{title}</h2>
          {phaseLabel && <span className="text-muted truncate text-meta">{phaseLabel}</span>}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <SearchField value={query} onChange={setQuery} aria-label="Cerca nel log del deploy" className="w-44 sm:w-56">
            <Label className="sr-only">Cerca nel log del deploy</Label>
            <Input placeholder="Cerca nel deploy" className="text-sm" />
          </SearchField>
          <Tip content="Scarica il log completo del deploy">
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label="Scarica il log del deploy"
              isPending={downloading}
              onPress={() => void download()}
            >
              <Icon icon="solar:download-minimalistic-linear" width={16} aria-hidden />
            </Button>
          </Tip>
        </div>
      </div>

      {explanation && (
        <Hint tone="warn" title={explanation.title} className="mb-2">
          {explanation.hint}
        </Hint>
      )}

      <LogViewer
        lines={shown}
        highlight={query.trim() || undefined}
        className="h-[240px]"
        ariaLabel="Output del build"
        emptyMessage={query.trim() ? `Nessuna riga del deploy contiene «${query.trim()}».` : "Il deploy sta per cominciare…"}
      />
    </section>
  );
}

/**
 * The furthest phase the log reached, read from its end — the newest banner is
 * there — and the message of a failure banner.
 */
function readOutcome(lines: readonly LogLine[]): { phase: DeployPhase; message: string | null } {
  for (let i = lines.length - 1; i >= 0; i--) {
    const phase = deployPhase(lines[i].text);
    if (phase === "queued") continue;
    const failed = phase === "failed" ? /=== .* FAILED: (.*) ===\s*$/.exec(lines[i].text) : null;
    return { phase, message: failed?.[1] ?? null };
  }
  return { phase: "queued", message: null };
}

/** The end of the log, which is where `explainDeployError` looks for a cause. */
function tailText(lines: readonly LogLine[]): string {
  return lines
    .slice(-400)
    .map((line) => line.text)
    .join("\n");
}

/** The newest deploy that has started: a queued one has no log yet. */
async function latestDeploymentId(api: (path: string) => string, projectId: string): Promise<string | null> {
  const res = await fetch(api(`/api/projects/${projectId}/logs`), { cache: "no-store" });
  if (!res.ok) return null;
  const rows = (await res.json()) as { id?: string; status?: string }[];
  return Array.isArray(rows) ? (rows.find((row) => row.status !== "pending")?.id ?? null) : null;
}

/** A text the page already holds, handed to the browser as a file. */
export function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has been handled: revoking at once cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
