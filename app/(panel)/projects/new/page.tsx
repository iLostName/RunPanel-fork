"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormDialog } from "@/components/ui/FormDialog";
import { FieldHint } from "@/components/ui/Hint";
import { Technical } from "@/components/ui/Technical";
import { useCan } from "@/lib/hooks/useMe";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { DETECT_FILES } from "@/lib/app-detect";
import { listZipRoot } from "@/lib/zip-listing";
import { SourceStep } from "./_components/SourceStep";
import { ReviewStep, type LaunchRequest } from "./_components/ReviewStep";
import { LaunchView } from "./_components/LaunchView";
import { useLaunch } from "./_components/useLaunch";
import type { DetectState, PickedSource } from "./_components/types";

type Step = "source" | "review" | "launch";

const STEPS: { id: Step; label: string }[] = [
  { id: "source", label: "Sorgente" },
  { id: "review", label: "Rivedi" },
  { id: "launch", label: "Online" },
];

/**
 * New project: source, review, online.
 *
 * The project is created only at the last step, together with everything it
 * needs, by `useLaunch`. The first two steps only read: GitHub's API or the
 * ZIP's own directory, through `POST /api/projects/detect`.
 */
export default function NewProjectPage() {
  const api = useNodeApi();
  const canCreate = useCan("projects.create");
  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState<PickedSource | null>(null);
  const [detect, setDetect] = useState<DetectState>({ status: "loading" });
  const [githubConnected, setGithubConnected] = useState(false);
  const [request, setRequest] = useState<LaunchRequest | null>(null);
  const { progress, launch, reset, redeploy } = useLaunch();
  // Only the latest detection may write its answer: a slow GitHub reply for
  // the previous repository must not land on the next one.
  const detectRun = useRef(0);

  async function runDetection(picked: PickedSource) {
    const run = ++detectRun.current;
    const settle = (state: DetectState) => {
      if (run === detectRun.current) setDetect(state);
    };
    setDetect({ status: "loading" });
    try {
      let body: unknown;
      if (picked.kind === "github") {
        body = { source: "github", url: picked.url, branch: picked.branch || undefined };
      } else {
        const listing = await listZipRoot(await picked.file.arrayBuffer(), DETECT_FILES);
        body = { source: "files", files: listing.files.slice(0, 5000), contents: listing.contents };
      }
      const res = await fetch(api("/api/projects/detect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) settle({ status: "error", message: data.error ?? `Il server ha risposto ${res.status}` });
      else if (data.supported === false) settle({ status: "unsupported", reason: data.reason });
      else if (data.error) settle({ status: "error", message: data.error });
      else settle({ status: "ok", detection: data.detection });
    } catch (err) {
      settle({ status: "error", message: err instanceof Error ? err.message : "Lettura non riuscita" });
    }
  }

  function chooseSource(picked: PickedSource, connected: boolean) {
    setSource(picked);
    setGithubConnected(connected);
    setStep("review");
    void runDetection(picked);
  }

  function start(next: LaunchRequest) {
    if (!source) return;
    setRequest(next);
    setStep("launch");
    void launch(next, source);
  }

  if (!canCreate) {
    return (
      <>
        <PageHeader title="Nuovo progetto" />
        <EmptyState
          icon="solar:lock-linear"
          title="Non puoi creare progetti"
          description="Serve il permesso «Creare progetti»: chiedilo a chi gestisce il pannello."
        />
      </>
    );
  }

  const current = STEPS.findIndex((s) => s.id === step);

  return (
    <>
      <PageHeader
        title="Nuovo progetto"
        description={
          step === "source"
            ? "Scegli il codice: al resto pensa il pannello"
            : step === "review"
              ? "Controlla cosa abbiamo trovato e metti online"
              : "Creo il progetto e faccio il primo deploy"
        }
      />

      <ol className="mb-6 flex flex-wrap items-center gap-3" aria-label="Avanzamento">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-3">
            <span
              className={cn("flex items-center gap-2 text-sm transition-colors", i === current ? "text-foreground" : "text-muted")}
              aria-current={i === current ? "step" : undefined}
            >
              <span
                className={cn(
                  "text-meta flex size-5 items-center justify-center rounded-full border font-mono",
                  i < current ? "border-accent text-accent" : i === current ? "selected text-accent border-transparent" : "border-border text-muted"
                )}
              >
                {i < current ? <Icon icon="solar:check-read-linear" width={12} aria-hidden /> : i + 1}
              </span>
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="bg-border h-px w-8" aria-hidden />}
          </li>
        ))}
      </ol>

      {step === "source" && (
        <>
          <SourceStep initial={source} onContinue={chooseSource} />
          <Technical>
            <EmptyProjectLink />
          </Technical>
        </>
      )}

      {/* Kept mounted while launching, only hidden: after an undone launch,
          "Torna alle impostazioni" finds every answer where it was left. */}
      {(step === "review" || step === "launch") && source && (
        <div hidden={step !== "review"}>
          <ReviewStep
            source={source}
            detect={detect}
            githubConnected={githubConnected}
            onGithubConnected={() => setGithubConnected(true)}
            onRetryDetect={() => void runDetection(source)}
            onBack={() => setStep("source")}
            onLaunch={start}
          />
        </div>
      )}

      {step === "launch" && progress && request && (
        <LaunchView
          progress={progress}
          name={request.name}
          hostname={request.hostname}
          onBackToForm={() => {
            reset();
            setStep("review");
          }}
          onRedeploy={redeploy}
        />
      )}
    </>
  );
}

/**
 * For whoever wants to wire a project by hand (a folder already on the
 * server, a contract written in JSON): an empty project, configured later from
 * its settings. Expert mode only; the guided path is the default.
 */
function EmptyProjectLink() {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  async function create() {
    const res = await fetch(api("/api/projects"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(data.error ?? "Creazione non riuscita");
      return false;
    }
    router.push(href(`/projects/${data.id}?tab=settings`));
  }

  return (
    <div className="mt-6 max-w-2xl">
      <Button variant="ghost" size="sm" onPress={() => setOpen(true)}>
        <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
        Crea un progetto vuoto e configuralo a mano
      </Button>
      <FormDialog
        isOpen={open}
        onOpenChange={setOpen}
        title="Progetto vuoto"
        description="Nessuna sorgente e nessun deploy: lo configuri dalle impostazioni, per esempio collegando una cartella già sul server."
        submitLabel="Crea"
        isSubmitDisabled={!name.trim()}
        onSubmit={create}
      >
        <div>
          <TextField value={name} onChange={setName} autoFocus>
            <Label>Nome</Label>
            <Input placeholder="il-mio-progetto" />
          </TextField>
          <FieldHint>Diventa anche il nome della cartella e del container.</FieldHint>
        </div>
      </FormDialog>
    </div>
  );
}
