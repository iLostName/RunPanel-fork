"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { CommandBlock } from "@/components/ui/CommandBlock";
import { Code, Hint } from "@/components/ui/Hint";
import { Technical } from "@/components/ui/Technical";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useNodeApi } from "@/lib/hooks/useNode";

/** What the setup needs to know of the probe; the commands only reach who may run the setup. */
export interface ProxyInfo {
  state: string;
  detail: string;
  root?: boolean;
  reload?: "direct" | "systemd" | "sudo";
  commands?: string[] | null;
}

/** nginx takes the blocks: without certbot the addresses are served, over HTTP only. */
export const PROXY_SERVES = new Set(["ready", "no-certbot"]);

/**
 * The one step this server's nginx needs next, with the button or the
 * commands that take it.
 *
 * The same on the Domains page and inside a project's address dialog, so
 * whoever is adding an address finishes the setup where they are instead of
 * being sent to another page and back. Commands to paste appear only for the
 * step that needs them, and only when the panel cannot take it itself.
 * Renders nothing once nginx and certbot are ready.
 */
export function ProxySetup({
  proxy,
  onChanged,
  className,
}: {
  proxy: ProxyInfo;
  onChanged: () => void | Promise<void>;
  className?: string;
}) {
  const api = useNodeApi();
  const [busy, setBusy] = useState<"setup" | "apply" | null>(null);
  // A root panel under a unit that keeps /etc read-only gets the commands back from the setup.
  const [handed, setHanded] = useState<string[] | null>(null);

  async function run(action: "setup" | "apply") {
    setBusy(action);
    try {
      const res = await fetch(api("/api/domains/proxy"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => ({}));
      if (Array.isArray(body.commands) && body.commands.length > 0) {
        setHanded(body.commands as string[]);
        toast.error(String(body.message ?? "Mancano ancora i comandi qui sotto"));
      } else if (body.ok) {
        setHanded(null);
        toast.success(
          Number(body.requested ?? 0) > 0
            ? `${body.message} I certificati in attesa arrivano appena il loro record DNS è pronto.`
            : String(body.message ?? "Fatto")
        );
      } else {
        toast.error(String(body.message ?? body.error ?? "Operazione non riuscita"));
      }
      await onChanged();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
  }

  const recheck = (label: string) => (
    <Button size="sm" variant="secondary" onPress={() => run("apply")} isPending={busy === "apply"}>
      <Icon icon="solar:refresh-linear" width={16} aria-hidden />
      {label}
    </Button>
  );

  switch (proxy.state) {
    case "ready":
      return null;

    case "disabled":
    case "unsupported":
      return (
        <Hint className={className} title="Da qui il pannello non può preparare nginx">
          {proxy.detail}
        </Hint>
      );

    case "no-nginx":
      return (
        <div className={className}>
          <Hint title="Installa nginx sul server">
            nginx è il programma che riceve le visite e le passa ai progetti; certbot chiede i certificati HTTPS.
            Installali una volta, da un terminale sul server. Su Debian o Ubuntu:
          </Hint>
          <CommandBlock className="mt-2" commands={["sudo apt install nginx certbot"]} />
          <Technical>
            <p className="text-muted mt-2 text-xs">
              Su RHEL, Fedora o Rocky: <Code>sudo dnf install nginx certbot</Code>.
            </p>
          </Technical>
          <div className="mt-3">{recheck("Li ho installati")}</div>
        </div>
      );

    case "not-configured":
    case "no-reload": {
      const commands = handed ?? (proxy.root ? null : (proxy.commands ?? null));
      if (!commands) {
        return (
          <div className={className}>
            <Hint title="Manca un passaggio, una volta sola">
              Il pannello aggiunge a nginx un file suo per gli indirizzi dei progetti: i siti che hai già configurato
              non vengono toccati.
            </Hint>
            <Button size="sm" className="mt-3" onPress={() => run("setup")} isPending={busy === "setup"}>
              <Icon icon="solar:shield-check-linear" width={16} aria-hidden />
              Prepara nginx
            </Button>
          </div>
        );
      }
      return (
        <div className={className}>
          <Hint title="Manca un passaggio, una volta sola">
            Il pannello non gira come root, quindi questo lo fai tu: copia i comandi in un terminale sul server, con un
            utente che può usare sudo. Aggiungono a nginx un file del pannello e non toccano i tuoi siti.
          </Hint>
          <CommandBlock className="mt-2" commands={commands} />
          <Technical>
            <p className="text-muted mt-2 text-xs">
              Il pannello potrà scrivere solo in <Code>/var/lib/runpanel-proxy</Code>
              {proxy.reload === "systemd" ? (
                <>
                  {" "}e chiedere a systemd, con due path unit, di eseguire <Code>nginx -t</Code> e{" "}
                  <Code>nginx -s reload</Code>
                </>
              ) : proxy.reload === "sudo" ? (
                <>
                  {" "}e lanciare con sudo solo <Code>nginx -t</Code> e <Code>nginx -s reload</Code>
                </>
              ) : null}
              .
            </p>
          </Technical>
          <div className="mt-3">{recheck("Ho eseguito i comandi")}</div>
        </div>
      );
    }

    case "no-certbot":
      return (
        <div className={className}>
          <Hint tone="warn" title="Manca certbot">
            Senza certbot gli indirizzi funzionano solo in HTTP, senza lucchetto. Installalo da un terminale sul server;
            su Debian o Ubuntu:
          </Hint>
          <CommandBlock className="mt-2" commands={["sudo apt install certbot"]} />
          <div className="mt-3">{recheck("L'ho installato")}</div>
        </div>
      );

    default:
      return (
        <Hint className={className} tone="warn" title="nginx non è pronto">
          {proxy.detail}
        </Hint>
      );
  }
}
