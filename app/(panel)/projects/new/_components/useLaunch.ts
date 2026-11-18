"use client";

import { useCallback, useRef, useState } from "react";
import { useNodeApi } from "@/lib/hooks/useNode";
import { uploadProjectZip } from "@/lib/upload";
import { firstFreePort } from "@/lib/ports";
import { configureBody, launchSteps, type LaunchStep } from "@/lib/new-project-plan";
import { databaseOption } from "@/app/(panel)/services/new/_data/catalog";
import type { LaunchRequest } from "./ReviewStep";
import type { PickedSource } from "./types";

export type StepState = "todo" | "running" | "done" | "failed" | "undone";

export interface LaunchProgress {
  steps: { id: LaunchStep; state: StepState; detail?: string }[];
  /** 0–1 while the ZIP is being sent. */
  uploadFraction: number | null;
  project: { id: string; slug: string } | null;
  deploymentId: string | null;
  /** Things worth saying that are not failures ("aggiornamenti con il controllo periodico"). */
  notes: string[];
  outcome:
    | null
    /** Something failed before the deploy and everything created was removed again. */
    | { kind: "undone"; step: LaunchStep; message: string }
    /** Something failed and the clean-up failed too: a project exists, half configured. */
    | { kind: "half-done"; step: LaunchStep; message: string }
    /** The project is complete but its first deploy was not queued. */
    | { kind: "deploy-not-started"; message: string }
    /** Queued behind another deploy: no id to follow yet. */
    | { kind: "queued"; message: string };
}

class StepFailure extends Error {
  constructor(readonly step: LaunchStep, message: string) {
    super(message);
  }
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

/** A service name from the project's slug: `mio-sito-db`, within the 38 characters names may have. */
function databaseName(slug: string, type: string): string {
  const suffix = type === "redis" ? "cache" : "db";
  const stem = slug.slice(0, 37 - suffix.length).replace(/[^a-z0-9_-]/g, "-").replace(/-+$/, "");
  return `${/^[a-z0-9]/.test(stem) ? stem : `p${stem}`}-${suffix}`;
}

/**
 * "Crea e metti online", as a sequence of calls to the routes that already exist.
 *
 * Run from the button's handler rather than an effect, so a re-render (or
 * React's double-invoked effects in development) can never create the project
 * twice.
 *
 * Until the deploy is queued the sequence is all or nothing: if a step fails,
 * the project and whatever was created with it (its database included) are
 * deleted again, so there is no half-made project left in the list. From the
 * deploy on, the project is complete and stays: a failed build is something to
 * fix, not a reason to throw the configuration away.
 */
export function useLaunch() {
  const api = useNodeApi();
  const [progress, setProgress] = useState<LaunchProgress | null>(null);
  const running = useRef(false);

  const launch = useCallback(
    async (request: LaunchRequest, source: PickedSource) => {
      if (running.current) return;
      running.current = true;

      const { choices, name } = request;
      const order = launchSteps(choices);
      setProgress({
        steps: order.map((id) => ({ id, state: "todo" })),
        uploadFraction: null,
        project: null,
        deploymentId: null,
        notes: [],
        outcome: null,
      });

      const mark = (id: LaunchStep, state: StepState, detail?: string) =>
        setProgress((p) => p && { ...p, steps: p.steps.map((s) => (s.id === id ? { ...s, state, detail } : s)) });
      const note = (text: string) => setProgress((p) => p && { ...p, notes: [...p.notes, text] });

      async function step<T>(id: LaunchStep, work: () => Promise<T>): Promise<T> {
        mark(id, "running");
        try {
          const out = await work();
          mark(id, "done");
          return out;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Errore imprevisto";
          mark(id, "failed", message);
          throw new StepFailure(id, message);
        }
      }

      let project: { id: string; slug: string } | null = null;
      try {
        project = await step("create", async () => {
          const res = await fetch(api("/api/projects"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) throw new Error(await errorOf(res, "Creazione non riuscita"));
          const data = (await res.json()) as { id: string; slug: string };
          return { id: data.id, slug: data.slug };
        });
        const created = project;
        setProgress((p) => p && { ...p, project: created });

        await step("configure", async () => {
          const res = await fetch(api(`/api/projects/${created.id}`), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(configureBody(choices)),
          });
          if (!res.ok) throw new Error(await errorOf(res, "Configurazione non riuscita"));
          const data = (await res.json().catch(() => ({}))) as { webhookWarning?: string | null };
          if (choices.autoDeploy && data.webhookWarning) {
            // GitHub cannot deliver to this panel (private address, no public
            // URL, a token without hook rights): the panel asks GitHub instead.
            const poll = await fetch(api(`/api/projects/${created.id}`), {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deployTrigger: "poll" }),
            });
            note(
              poll.ok
                ? "Gli aggiornamenti automatici funzionano con un controllo periodico: GitHub non può raggiungere questo pannello per avvisarlo dei push."
                : `Aggiornamenti automatici da sistemare nelle impostazioni: ${data.webhookWarning}`
            );
          }
        });

        if (order.includes("upload") && source.kind === "zip") {
          await step("upload", () =>
            uploadProjectZip(api("/api/upload"), source.file, created.slug, (fraction) =>
              setProgress((p) => p && { ...p, uploadFraction: fraction })
            )
          );
        }

        if (order.includes("env")) {
          await step("env", async () => {
            const res = await fetch(api(`/api/projects/${created.id}/env`), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ vars: choices.env }),
            });
            if (!res.ok) throw new Error(await errorOf(res, "Variabili non salvate"));
          });
        }

        if (order.includes("database") && choices.database) {
          const type = choices.database;
          await step("database", async () => {
            const option = databaseOption(type);
            // The app's own port too: it is not on the server's list yet.
            const used = new Set(request.usedPorts);
            if (choices.port !== null) used.add(choices.port);
            const send = (port: number) =>
              fetch(api("/api/services"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  name: databaseName(created.slug, type),
                  type,
                  version: option.versions[0],
                  port,
                  projectId: created.id,
                }),
              });
            let res = await send(firstFreePort(option.defaultPort, used));
            if (res.status === 409) {
              // Taken since the page loaded: the server says which one is free now.
              const body = (await res.clone().json().catch(() => ({}))) as { code?: string; suggestedPort?: number };
              if (body.code === "port_taken" && body.suggestedPort) res = await send(body.suggestedPort);
            }
            if (!res.ok) throw new Error(await errorOf(res, "Database non creato"));
          });
        }

        if (order.includes("address") && choices.address) {
          const address = choices.address;
          await step("address", async () => {
            const res = await fetch(api(`/api/projects/${created.id}/hosts`), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ domainId: address.domainId, subdomain: address.subdomain }),
            });
            if (!res.ok) throw new Error(await errorOf(res, "Indirizzo non assegnato"));
          });
        }
      } catch (err) {
        const failure = err instanceof StepFailure ? err : new StepFailure("create", "Errore imprevisto");
        if (!project) {
          setProgress((p) => p && { ...p, outcome: { kind: "undone", step: failure.step, message: failure.message } });
          running.current = false;
          return;
        }
        // Undo: the project and what was made with it, database included.
        const undone = await fetch(api(`/api/projects/${project.id}?services=delete`), { method: "DELETE" })
          .then((res) => res.ok)
          .catch(() => false);
        setProgress((p) => {
          if (!p) return p;
          const steps = undone
            ? p.steps.map((s) => (s.state === "done" ? { ...s, state: "undone" as const } : s))
            : p.steps;
          return {
            ...p,
            steps,
            project: undone ? null : p.project,
            outcome: { kind: undone ? "undone" : "half-done", step: failure.step, message: failure.message },
          };
        });
        running.current = false;
        return;
      }

      // From here on the project is complete and is kept whatever happens.
      const created = project;
      try {
        await step("deploy", async () => {
          const res = await fetch(api(`/api/projects/${created.id}/deploy`), { method: "POST" });
          if (!res.ok) throw new Error(await errorOf(res, "Deploy non avviato"));
          const data = (await res.json()) as { deploymentId?: string; status?: string; message?: string };
          if (data.deploymentId) {
            const id = data.deploymentId;
            setProgress((p) => p && { ...p, deploymentId: id });
          } else {
            setProgress((p) => p && { ...p, outcome: { kind: "queued", message: data.message ?? "Deploy in coda" } });
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Deploy non avviato";
        setProgress((p) => p && { ...p, outcome: { kind: "deploy-not-started", message } });
      }
      running.current = false;
    },
    [api]
  );

  /** Back to the form after an undone launch; nothing exists on the server. */
  const reset = useCallback(() => {
    if (running.current) return;
    setProgress(null);
  }, []);

  /** A new deploy of the project the wizard made, after fixing something. */
  const redeploy = useCallback(async () => {
    const id = progress?.project?.id;
    if (!id) return;
    const res = await fetch(api(`/api/projects/${id}/deploy`), { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { deploymentId?: string; error?: string };
    if (res.ok && data.deploymentId) {
      const deploymentId = data.deploymentId;
      setProgress((p) => p && { ...p, deploymentId, outcome: null });
    }
    return res.ok ? null : (data.error ?? "Deploy non avviato");
  }, [api, progress?.project?.id]);

  return { progress, launch, reset, redeploy };
}
