"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { CopyField } from "@/components/ui/CopyField";
import { Advanced } from "@/components/ui/Technical";
import { LinkButton } from "@/components/ui/LinkButton";
import { LiveDeploy } from "@/components/deploy/LiveDeploy";
import { MSG } from "@/lib/copy";
import { toast } from "@/lib/toast";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { deploymentSucceeded, type DeployFix } from "@/lib/deploy-explain";
import type { CatalogInstallResponse, CatalogTemplate } from "@/lib/app-catalog";

/**
 * After the install: what exists now, the passwords once, the first deploy
 * live, and what to do when it is online.
 *
 * The passwords are in this component's props and nowhere else on the page:
 * leaving it is the end of them on screen, and from then on they are the
 * project's variables, revealed only to whoever manages it.
 */
export function InstallResult({ template, result }: { template: CatalogTemplate; result: CatalogInstallResponse }) {
  const api = useNodeApi();
  const href = useServerHref();
  const projectHref = href(`/projects/${result.project.id}`);
  const [deploymentId, setDeploymentId] = useState<string | null>(
    result.deployment.status === "started" ? result.deployment.deploymentId : null
  );
  const [waiting, setWaiting] = useState<string | null>(result.deployment.status === "started" ? null : result.deployment.message);
  const [settled, setSettled] = useState<{ id: string; ok: boolean } | null>(null);
  const [redeploying, setRedeploying] = useState(false);
  const outcome = settled && settled.id === deploymentId ? settled : null;

  const important = result.secrets.filter((secret) => secret.important);
  const others = result.secrets.filter((secret) => !secret.important);
  const variableCount = result.secrets.length + Object.keys(result.values).length;

  async function deploy() {
    setRedeploying(true);
    try {
      const res = await fetch(api(`/api/projects/${result.project.id}/deploy`), { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { deploymentId?: string; message?: string; error?: string };
      if (res.ok && data.deploymentId) {
        setDeploymentId(data.deploymentId);
        setWaiting(null);
      } else if (res.ok) {
        setWaiting(data.message ?? "Deploy in coda");
      } else {
        toast.error(data.error ?? "Deploy non avviato");
      }
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setRedeploying(false);
    }
  }

  function fixButton(fix: DeployFix) {
    switch (fix) {
      case "env":
        return (
          <LinkButton key={fix} href={href(`/projects/${result.project.id}?tab=env`)} variant="secondary">
            Apri le variabili
          </LinkButton>
        );
      case "port":
      case "healthcheck":
      case "runtime":
      case "memory":
        return (
          <LinkButton key={fix} href={href(`/projects/${result.project.id}?tab=settings`)} variant="secondary">
            Apri le impostazioni
          </LinkButton>
        );
      default:
        return null;
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      {/* --- what exists now ---------------------------------------------------------- */}
      <Panel className="space-y-3">
        <ol className="space-y-2" aria-label="Fatto">
          <Done>Progetto «{result.project.name}» creato, con il suo file Compose</Done>
          {variableCount > 0 && (
            <Done>
              {variableCount} {variableCount === 1 ? "variabile salvata" : "variabili salvate"}, cifrate come tutte le altre
            </Done>
          )}
          {result.hostname && <Done>Indirizzo {result.hostname} assegnato</Done>}
        </ol>
        {result.hostname && result.proxy && result.proxy.state !== "ready" && (
          <Hint tone="warn" title="Il proxy non è ancora pronto">
            {result.proxy.detail} L&apos;indirizzo è salvato e funzionerà appena il proxy è configurato in Domini.
          </Hint>
        )}
      </Panel>

      {/* --- the passwords, once -------------------------------------------------------- */}
      {result.secrets.length > 0 && (
        <Panel className="space-y-4">
          <PanelHeader
            title="Password e chiavi generate"
            description="Copiale adesso: dopo le ritrovi solo nelle variabili del progetto."
          />
          {important.map((secret) => (
            <SecretRow key={secret.key} secret={secret} />
          ))}
          {others.length > 0 &&
            (important.length > 0 ? (
              <Advanced title="Le altre" summary="database e chiavi interne: all'app servono, a te di solito no">
                {others.map((secret) => (
                  <SecretRow key={secret.key} secret={secret} />
                ))}
              </Advanced>
            ) : (
              others.map((secret) => <SecretRow key={secret.key} secret={secret} />)
            ))}
        </Panel>
      )}

      {/* --- the first deploy ----------------------------------------------------------- */}
      <Panel className="space-y-4">
        <PanelHeader
          title="Primo deploy"
          description="Scarico le immagini e avvio i container: la prima volta può volerci qualche minuto. Puoi chiudere la pagina, continua lo stesso."
        />
        {deploymentId ? (
          <LiveDeploy
            key={deploymentId}
            deploymentId={deploymentId}
            onSettled={(deployment) => setSettled({ id: deployment.id, ok: deploymentSucceeded(deployment.status) })}
            renderFixes={(explanation) => (
              <>
                {explanation.fixes.map(fixButton)}
                <Button variant="secondary" size="sm" isPending={redeploying} onPress={deploy}>
                  Riprova il deploy
                </Button>
              </>
            )}
          />
        ) : (
          <Hint tone="warn" title="Il progetto è pronto, il deploy no">
            <p>{waiting}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" isPending={redeploying} onPress={deploy}>
                Avvia il deploy
              </Button>
              <LinkButton href={projectHref} variant="secondary">
                Apri il progetto
              </LinkButton>
            </div>
          </Hint>
        )}
      </Panel>

      {outcome?.ok && (
        <Panel className="border-success/30 space-y-3">
          <div className="flex items-center gap-3">
            <Icon icon="solar:check-circle-bold" width={28} className="text-success shrink-0" aria-hidden />
            <div className="min-w-0">
              <p className="text-foreground text-lg font-medium">«{result.project.name}» è online</p>
              <p className="text-muted text-sm">
                Risponde su <Code>{result.url}</Code>
                {result.hostname ? ". Il certificato HTTPS può richiedere qualche minuto, e arriva solo quando il DNS punta qui." : "."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="bg-accent text-accent-foreground inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-transparent px-4 py-2 text-sm"
            >
              Apri {template.name}
              <Icon icon="solar:arrow-right-up-linear" width={16} aria-hidden />
            </a>
            <LinkButton href={projectHref} variant="secondary" size="md">
              Vai al progetto
            </LinkButton>
          </div>
        </Panel>
      )}

      {outcome && !outcome.ok && (
        <div className="flex justify-end">
          <LinkButton href={projectHref} variant="secondary">
            Vai al progetto
          </LinkButton>
        </div>
      )}

      {/* --- what to do next ----------------------------------------------------------- */}
      <Panel className="space-y-3">
        <PanelHeader title="Prossimi passi" description={outcome?.ok ? undefined : "Appena è online"} />
        <ol className="list-decimal space-y-2 pl-5">
          {result.notes.map((note) => (
            <li key={note} className="text-foreground text-sm">
              {note}
            </li>
          ))}
        </ol>
        <FieldHint className="mt-0">
          D&apos;ora in poi è un progetto Compose come gli altri: file, variabili e deploy li trovi nella sua pagina.
        </FieldHint>
      </Panel>
    </div>
  );
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <li className="text-foreground flex items-center gap-2 text-sm">
      <Icon icon="solar:check-circle-bold" width={16} className="text-success shrink-0" aria-label="fatto" />
      <span>{children}</span>
    </li>
  );
}

function SecretRow({ secret }: { secret: CatalogInstallResponse["secrets"][number] }) {
  return (
    <div>
      <CopyField label={`${secret.label} · ${secret.key}`} value={secret.value} secret />
      {secret.help && <FieldHint>{secret.help}</FieldHint>}
    </div>
  );
}
