"use client";

import { useRouter } from "next/navigation";
import { Button, Modal } from "@heroui/react";
import { Icon } from "@iconify/react";
import { SheetGrip } from "@/components/ui/SheetGrip";
import { Code } from "@/components/ui/Hint";
import { useMe } from "@/lib/hooks/useMe";
import { closeInstallHelp, useInstall } from "@/lib/pwa/install";
import { outsideToasts } from "@/lib/toast";

/** Safari's own share glyph, drawn as it looks there: the steps name a button the reader has to find. */
function ShareGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
      <path d="M12 3.5v11" />
      <path d="M8.5 7 12 3.5 15.5 7" />
      <path d="M8 10H6.5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12a2 2 0 0 0-2-2H16" />
    </svg>
  );
}

/** Safari's bottom bar, with the share button ringed: where step one is. */
function SafariBar() {
  return (
    <div
      aria-hidden
      className="border-border bg-surface-secondary text-muted mx-auto flex w-full max-w-72 items-center justify-around rounded-2xl border px-3 py-2.5"
    >
      <Icon icon="solar:alt-arrow-left-linear" width={20} className="opacity-50" />
      <Icon icon="solar:alt-arrow-right-linear" width={20} className="opacity-50" />
      <span className="relative grid size-9 place-items-center">
        <span className="ring-accent absolute inset-0 animate-pulse rounded-full ring-2" />
        <ShareGlyph className="text-accent" />
      </span>
      <Icon icon="solar:book-linear" width={20} className="opacity-50" />
      <Icon icon="solar:copy-linear" width={20} className="opacity-50" />
    </div>
  );
}

function Step({ n, icon, children }: { n: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="bg-surface-secondary text-foreground grid size-8 shrink-0 place-items-center rounded-lg">{icon}</span>
      <p className="text-foreground min-w-0 flex-1 pt-1.5 text-sm">
        <span className="sr-only">{n}. </span>
        {children}
      </p>
    </li>
  );
}

/**
 * How to install the panel where the browser offers no button for it.
 *
 * Opened by "Installa l'app" (`startInstall` in lib/pwa/install.ts) when the
 * browser kept its install dialog to itself, which means one of three things:
 * iOS, where it is three steps from the share sheet; plain HTTP, where no
 * browser installs anything and the fix is in the panel's own settings; or a
 * browser that has not offered it (yet), where the menu is the way.
 *
 * Mounted once in the panel layout, where the account is known: only the owner
 * can put the panel on HTTPS, so only the owner gets the link there.
 */
export function InstallDialog() {
  const install = useInstall();
  const me = useMe();
  const router = useRouter();

  const kind = !install.secure ? "http" : install.ios ? "ios" : "browser";
  const title =
    kind === "http" ? "Per installare l'app serve HTTPS" : kind === "ios" ? "Aggiungi RunPanel alla schermata Home" : "Installa RunPanel";

  return (
    <Modal.Backdrop
      isOpen={install.helpOpen}
      onOpenChange={(open) => {
        if (!open) closeInstallHelp();
      }}
      shouldCloseOnInteractOutside={outsideToasts}
    >
      <Modal.Container>
        <Modal.Dialog className="max-w-md">
          <SheetGrip />
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            {kind === "http" && (
              <>
                <p className="text-muted text-sm">
                  Il browser installa un&apos;app solo da un indirizzo con il lucchetto, e ora il pannello è aperto su{" "}
                  <Code>{typeof window === "undefined" ? "" : window.location.host}</Code>, senza HTTPS.
                </p>
                <p className="text-muted text-sm">
                  {me.isOwner ? (
                    <>
                      Dagli un nome sul tuo dominio con{" "}
                      <strong className="text-foreground">Metti il pannello su HTTPS</strong>, in Impostazioni › Generale: DNS
                      e certificato li prepara il pannello, e l&apos;indirizzo di adesso continua a funzionare.
                    </>
                  ) : (
                    <>Chiedi a chi gestisce il pannello di metterlo su HTTPS, da Impostazioni › Generale.</>
                  )}
                </p>
              </>
            )}

            {kind === "ios" && (
              <>
                <SafariBar />
                <ol className="space-y-3">
                  <Step n={1} icon={<ShareGlyph />}>
                    Tocca <strong>Condividi</strong> nella barra del browser.
                  </Step>
                  <Step n={2} icon={<Icon icon="solar:add-square-linear" width={20} aria-hidden />}>
                    Scegli <strong>Aggiungi alla schermata Home</strong>; se non lo vedi, scorri l&apos;elenco.
                  </Step>
                  <Step n={3} icon={<Icon icon="solar:check-read-linear" width={20} aria-hidden />}>
                    Tocca <strong>Aggiungi</strong>: RunPanel si apre dalla sua icona, a tutto schermo.
                  </Step>
                </ol>
              </>
            )}

            {kind === "browser" && (
              <>
                <p className="text-muted text-sm">
                  Il browser non ha ancora proposto l&apos;installazione. Dal suo menu scegli{" "}
                  <strong className="text-foreground">Installa app</strong> o{" "}
                  <strong className="text-foreground">Aggiungi a schermata Home</strong>; in Chrome ed Edge per computer
                  c&apos;è anche l&apos;icona di installazione a destra nella barra degli indirizzi.
                </p>
                <p className="text-muted text-xs">
                  Se l&apos;hai già installata, aprila dalla sua icona: il browser non la propone una seconda volta. Firefox per
                  computer non installa le app web: apri il pannello con Chrome, Edge o Safari.
                </p>
              </>
            )}
          </Modal.Body>
          <Modal.Footer className="justify-end gap-2">
            {kind === "http" && me.isOwner ? (
              <>
                <Button variant="ghost" onPress={closeInstallHelp}>
                  Chiudi
                </Button>
                <Button
                  variant="primary"
                  onPress={() => {
                    closeInstallHelp();
                    // This server's settings, without `?server=`: the address
                    // to secure is the one in this browser's bar.
                    router.push("/settings?open=https");
                  }}
                >
                  Apri le impostazioni
                </Button>
              </>
            ) : (
              <Button variant="primary" onPress={closeInstallHelp}>
                Ho capito
              </Button>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
