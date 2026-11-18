import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { isInstantHostname } from "@/lib/proxy-names";
import type { HostView } from "@/services/proxy";

/**
 * How an address reads, next to its name: whether it is served at all, and
 * where its certificate stands — in the words of someone who wants the
 * padlock, not of certbot. The same on the Domains page, in a project and for
 * the panel's own name.
 */

interface AddressStatus {
  label: string;
  tone: BadgeTone;
  icon: string;
}

/** What these read of a name: a project's, or the panel's own, which carries the same fields. */
export type AddressLike = Pick<
  HostView,
  "hostname" | "status" | "certificate" | "certificateDaysLeft" | "applyError" | "explanation" | "lastError" | "dns"
>;

type Certificate = HostView["certificate"];

/** A server running an older panel answers without `certificate`: read it from `status`. */
function certificateOf(host: AddressLike): Certificate {
  if (host.certificate) return host.certificate;
  if (host.status === "active") return "active";
  if (host.status === "issuing" || host.status === "error") return host.status;
  return "missing";
}

/** An instant address (`app.203-0-113-7.sslip.io`): served over HTTP only, by design. */
function isInstant(host: AddressLike): boolean {
  return isInstantHostname(host.hostname) && certificateOf(host) !== "active";
}

export function addressStatus(host: AddressLike): AddressStatus {
  if (host.applyError) return { label: "Non servito", tone: "danger", icon: "solar:danger-triangle-linear" };
  if (isInstant(host)) return { label: "Solo HTTP", tone: "neutral", icon: "solar:lock-unlocked-linear" };
  switch (certificateOf(host)) {
    case "active":
      return { label: "HTTPS attivo", tone: "success", icon: "solar:shield-check-linear" };
    case "expiring": {
      const days = host.certificateDaysLeft ?? 0;
      return {
        label: days <= 1 ? "Il certificato scade a breve" : `Il certificato scade tra ${days} giorni`,
        tone: "warning",
        icon: "solar:shield-warning-linear",
      };
    }
    case "expired":
      return { label: "Certificato scaduto", tone: "danger", icon: "solar:shield-cross-linear" };
    case "issuing":
      return { label: "Certificato in arrivo", tone: "warning", icon: "solar:hourglass-linear" };
    case "error":
      return { label: "Certificato non ottenuto", tone: "danger", icon: "solar:shield-cross-linear" };
    default:
      return host.dns && !host.dns.ready
        ? { label: "In attesa del DNS", tone: "neutral", icon: "solar:clock-circle-linear" }
        : { label: "Senza HTTPS, per ora", tone: "neutral", icon: "solar:clock-circle-linear" };
  }
}

/** The one plain sentence under the name: what is going on, and what — if anything — to do. */
export function addressDetail(host: AddressLike, proxyServes: boolean): string {
  if (host.applyError) return host.applyError;
  if (isInstant(host)) {
    return "Indirizzo di prova: niente lucchetto, e il nome mostra l'IP del server. Per l'HTTPS usa un tuo dominio.";
  }
  switch (certificateOf(host)) {
    case "active":
      return "Il certificato si rinnova da solo.";
    case "expiring":
      return "Il rinnovo automatico non è ancora riuscito: controlla il record DNS e richiedi il certificato.";
    case "expired":
      return "Il rinnovo non è riuscito, e chi apre l'indirizzo vede un avviso del browser.";
    case "issuing":
      return "Let's Encrypt sta verificando l'indirizzo: di solito bastano pochi secondi.";
    case "error":
      return host.explanation ?? host.lastError ?? "La richiesta del certificato non è riuscita.";
    default:
      if (!proxyServes) return "Arriva quando nginx è pronto su questo server.";
      return host.dns && !host.dns.ready
        ? "Crea il record DNS: il certificato arriva da solo appena punta a questo server."
        : "Il certificato arriva da solo appena il record DNS punta a questo server.";
  }
}

/** Whether there is something to look at: anything short of a certificate that is working — or, for a test address, of being served. */
export function needsAttention(host: AddressLike): boolean {
  if (isInstant(host)) return host.applyError !== null;
  return host.applyError !== null || certificateOf(host) !== "active";
}

export function AddressBadge({ host }: { host: AddressLike }) {
  const status = addressStatus(host);
  return (
    <Badge tone={status.tone} icon={status.icon}>
      {status.label}
    </Badge>
  );
}
