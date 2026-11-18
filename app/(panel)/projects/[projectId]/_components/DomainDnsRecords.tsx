"use client";

import { Icon } from "@iconify/react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { CopyField } from "@/components/ui/CopyField";
import { Code, FieldHint } from "@/components/ui/Hint";
import { KeyValue } from "@/components/ui/KeyValue";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DnsState, FamilyCheck } from "@/lib/dns-check";
import type { HostDnsReport } from "@/services/proxy";

/** One name as the DNS endpoint answers it. */
export type DnsName = HostDnsReport & { subdomain: string; domain: string; cloudflare: boolean; redirectTo: string | null };

const VERDICT: Record<DnsState, { label: string; tone: BadgeTone; icon: string }> = {
  ok: { label: "Punta a questo server", tone: "success", icon: "solar:check-circle-linear" },
  missing: { label: "Non ancora trovato", tone: "neutral", icon: "solar:clock-circle-linear" },
  elsewhere: { label: "Punta altrove", tone: "danger", icon: "solar:close-circle-linear" },
  cloudflare: { label: "Dietro Cloudflare", tone: "warning", icon: "solar:cloud-linear" },
  unknown: { label: "Da confermare", tone: "warning", icon: "solar:question-circle-linear" },
  error: { label: "DNS non raggiungibile", tone: "warning", icon: "solar:danger-triangle-linear" },
};

export function DnsVerdictBadge({ name }: { name: DnsName }) {
  const verdict = VERDICT[name.check.state] ?? VERDICT.error;
  // Behind a linked Cloudflare domain, or reaching this nginx through it, nothing is wrong.
  const tone = name.check.state === "cloudflare" && name.check.ready ? "success" : verdict.tone;
  return (
    <Badge tone={tone} icon={verdict.icon}>
      {verdict.label}
    </Badge>
  );
}

/** What one record type holds now, in a few words, with a mark that reads at a glance. */
function familyLine(family: FamilyCheck, optional: boolean): { icon: string; className: string; text: string } {
  switch (family.status) {
    case "ok":
      return { icon: "solar:check-circle-linear", className: "text-success", text: "c'è e punta qui" };
    case "missing":
      return optional
        ? { icon: "solar:info-circle-linear", className: "text-muted", text: "non c'è" }
        : { icon: "solar:clock-circle-linear", className: "text-muted", text: "non trovato, per ora" };
    case "wrong":
      return {
        icon: "solar:close-circle-linear",
        className: "text-danger",
        text: family.expected.length === 0 ? `da cancellare: punta a ${family.foreign.join(", ")}` : `punta a ${family.foreign.join(", ")}`,
      };
    case "proxied":
      return { icon: "solar:cloud-linear", className: "text-warning", text: "nascosto dal proxy di Cloudflare" };
    case "unverified":
      return { icon: "solar:question-circle-linear", className: "text-warning", text: `punta a ${family.found.join(", ")}` };
    case "error":
      return { icon: "solar:danger-triangle-linear", className: "text-warning", text: "nessuna risposta dal DNS" };
    default:
      return { icon: "solar:info-circle-linear", className: "text-muted", text: "" };
  }
}

function RecordRow({ type, name, family }: { type: "A" | "AAAA"; name: DnsName; family: FamilyCheck }) {
  const optional = type === "AAAA" && family.expected.length > 0;
  const line = familyLine(family, optional);
  const relative = name.subdomain === "" ? "@" : name.subdomain;
  const value = family.expected[0];

  return (
    <div className="border-border space-y-2 rounded-[var(--radius)] border p-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-foreground font-medium">
          Record <span className="font-mono">{type}</span>
        </span>
        {type === "AAAA" && <span className="text-muted text-xs">{optional ? "per IPv6, facoltativo" : "per IPv6"}</span>}
        <span className={cn("inline-flex items-center gap-1 text-xs", line.className)}>
          <Icon icon={line.icon} width={14} aria-hidden />
          {line.text}
        </span>
      </p>
      {family.expected.length === 0 && type === "AAAA" ? (
        <p className="text-muted text-xs">
          Questo server non ha un indirizzo IPv6 pubblico: cancella il record <Code>AAAA</Code> di{" "}
          <Code>{name.hostname}</Code> dal pannello del tuo provider DNS.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <CopyField label="Nome" value={relative} />
          {value ? (
            <CopyField label={family.expected.length > 1 ? "Valore (uno dei due)" : "Valore"} value={value} />
          ) : (
            <div className="space-y-1.5">
              <span className="text-muted text-xs font-medium">Valore</span>
              <p className="text-muted text-xs">
                L&apos;IP pubblico del server: da qui non riesco a scoprirlo. Lo trovi nel pannello del provider del
                server, o del router se il server è dietro NAT.
              </p>
            </div>
          )}
        </div>
      )}
      {family.expected.length > 1 && (
        <p className="text-muted text-xs">
          Il server ha più indirizzi: vanno bene tutti, <Code>{family.expected.join(", ")}</Code>.
        </p>
      )}
    </div>
  );
}

/**
 * The records one name needs, each with what the resolvers hold for it now,
 * and the verdict in one sentence. The record a person has to create comes
 * first and is copyable; what the resolvers said exactly is for experts.
 */
export function DomainDnsRecords({ name }: { name: DnsName }) {
  const { A, AAAA } = name.check.families;
  const showAaaa = AAAA.expected.length > 0 || AAAA.status === "wrong" || AAAA.status === "proxied";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground font-mono text-sm">{name.hostname}</span>
        <DnsVerdictBadge name={name} />
      </div>
      <p className="text-foreground text-sm">{name.check.summary}</p>

      <div className="space-y-2">
        <RecordRow type="A" name={name} family={A} />
        {showAaaa && <RecordRow type="AAAA" name={name} family={AAAA} />}
      </div>

      {name.check.notes.map((note) => (
        <FieldHint key={note}>{note}</FieldHint>
      ))}
      <FieldHint>
        {name.subdomain === "" ? (
          <>
            Il nome <Code>@</Code> è il dominio stesso, <Code>{name.domain}</Code>: alcuni provider lo vogliono vuoto.
          </>
        ) : (
          <>
            Il nome è relativo al dominio: per esteso è <Code>{name.hostname}</Code>. Un solo record{" "}
            <Code>*</Code> copre in una volta tutti i sottodomini di <Code>{name.domain}</Code>.
          </>
        )}
      </FieldHint>

      <KeyValue
        className="text-xs"
        items={[
          { label: "A trovati", value: A.found.join(", ") || "nessuno", technical: true, mono: true },
          { label: "AAAA trovati", value: AAAA.found.join(", ") || "nessuno", technical: true, mono: true },
          {
            label: "Chiesto a",
            value: `${name.resolvers.join(", ")}${name.via === "system" ? " (i DNS del server: quelli pubblici non rispondono)" : ""}`,
            technical: true,
            mono: true,
          },
          {
            label: "IP del server",
            value: [...name.server.v4, ...name.server.v6].join(", ") || "sconosciuto",
            technical: true,
            mono: true,
          },
          ...(name.server.detected
            ? [{ label: "IPv4 da fuori", value: "visto da myip.opendns.com: il server è dietro NAT", technical: true }]
            : []),
          ...(name.reaches !== null
            ? [{ label: "Verifica HTTP", value: name.reaches ? "risponde questo nginx" : "non risponde questo nginx", technical: true }]
            : []),
          { label: "Controllato", value: formatWhen(name.checkedAt), technical: true },
        ]}
      />
    </div>
  );
}
