"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Label, TextField } from "@heroui/react";
import { toast } from "@/lib/toast";
import { useResource } from "@/lib/hooks/useResource";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { SelectField } from "@/components/ui/SelectField";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { Field } from "@/components/ui/Field";
import { Advanced } from "@/components/ui/Technical";
import { connectionEnvKey } from "@/lib/service-env";
import { serviceCredentialsSchema } from "@/lib/validation";
import { firstFreePort, portsInUse } from "@/lib/ports";
import { DATABASE_OPTIONS, databaseOption, type ServiceType } from "../_data/catalog";
import { ServerPicker } from "@/components/cluster/ServerBits";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** A name nobody has to invent: "shop-db", "shop-cache", or "postgresql-db" with no project. */
function suggestedName(type: ServiceType, projectSlug: string | undefined): string {
  const suffix = type === "redis" ? "cache" : "db";
  return projectSlug ? `${projectSlug}-${suffix}` : `${type}-${suffix}`;
}

/**
 * A new database, for someone who only knows they need "a database".
 *
 * Three decisions are in view: which engine, its name (proposed), and the
 * project it belongs to. Everything a developer may want to set (the port on
 * the host, who may connect, the credentials) is under "Avanzate", already
 * filled with values that work: a free port, the local networks, generated
 * credentials. Expert mode opens it by default.
 */
export function DatabaseForm({ projectId }: { projectId?: string }) {
  const api = useNodeApi();
  const href = useServerHref();
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const [type, setType] = useState<ServiceType>("postgresql");
  const [name, setName] = useState("");
  /*
    Seeded from the catalogue, not written out again. `chooseType` is the only
    other thing that sets this, and it only runs when a type tile is pressed —
    so a hand-written literal here is the version anyone who opens the wizard
    and presses nothing ends up creating, whatever the list says. It had been
    left at "16" while the list moved on.
  */
  const [version, setVersion] = useState(databaseOption("postgresql").versions[0]);
  /** Null until typed: until then the port follows the engine and what is free. */
  const [portTyped, setPortTyped] = useState<string | null>(null);
  const [user, setUser] = useState("runpanel");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("runpanel_db");
  const [restrict, setRestrict] = useState(false);
  const [projectChoice, setProject] = useState(projectId ?? "");

  const { data: networkData } = useResource<{ networks: { cidr: string; kind: string }[] }>(
    api("/api/network/suggestions")
  );
  const lanNetworks = (networkData?.networks ?? [])
    .filter((network) => network.kind === "lan")
    .map((network) => network.cidr);

  const { data: projectsData } = useResource<{ id: string; name: string; slug: string; port: number | null }[]>(
    api("/api/projects")
  );
  const { data: servicesData } = useResource<{ port: number; access_port?: number | null }[]>(api("/api/services"));
  const projects = useMemo(() => (Array.isArray(projectsData) ? projectsData : []), [projectsData]);
  const project = projectsData && !projects.some((p) => p.id === projectChoice) ? "" : projectChoice;
  const projectSlug = projects.find((p) => p.id === project)?.slug;

  const option = databaseOption(type);
  const used = useMemo(
    () => portsInUse([...(Array.isArray(servicesData) ? servicesData : []), ...projects]),
    [servicesData, projects]
  );
  const freePort = firstFreePort(option.defaultPort, used);
  const port = portTyped ?? String(freePort);
  const nameValue = name.trim() || suggestedName(type, projectSlug);

  function chooseType(next: ServiceType) {
    const opt = databaseOption(next);
    setType(next);
    setVersion(opt.versions[0]);
    setPortTyped(null);
    setUser(opt.credentialled ? "runpanel" : "");
    setDatabase(opt.credentialled ? "runpanel_db" : "0");
    setPassword("");
  }

  async function create() {
    if (!NAME_PATTERN.test(nameValue)) {
      toast.error("Il nome può contenere solo minuscole, numeri, trattini e underscore");
      return;
    }
    const credentials = {
      user: user.trim() || undefined,
      password: password || undefined,
      database: database.trim() || undefined,
    };
    const checked = serviceCredentialsSchema.safeParse(credentials);
    if (!checked.success) {
      toast.error(checked.error.issues[0].message);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(api("/api/services"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameValue,
          type,
          version,
          port: Number.parseInt(port, 10),
          projectId: project || undefined,
          credentials,
          access: restrict ? { mode: "restricted", allow: lanNetworks } : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // A port taken since the page loaded: take the free one the panel found.
        if (data.code === "port_taken" && typeof data.suggestedPort === "number") setPortTyped(String(data.suggestedPort));
        toast.error(data.error ?? "Creazione non riuscita");
        return;
      }
      toast.success(project ? "Database creato: arriva all'app al prossimo deploy" : "Database creato");
      router.push(href(project ? `/projects/${project}` : `/services/${data.id}`));
    } catch {
      toast.error("Creazione non riuscita");
    } finally {
      setSaving(false);
    }
  }

  const envKey = connectionEnvKey(type);

  return (
    <div className="max-w-3xl space-y-4">
      <Hint tone={project ? "tip" : "info"} icon={project ? "solar:link-circle-linear" : "solar:database-linear"}>
        {project ? (
          <>
            Il database parte subito, con i suoi dati al sicuro in un volume dedicato. Al prossimo deploy
            l&apos;app riceve <Code>{envKey}</Code> già pronta: niente credenziali da copiare.
          </>
        ) : (
          <>
            Il database parte subito, con i suoi dati al sicuro in un volume dedicato. Senza progetto,
            nella sua pagina trovi l&apos;indirizzo di connessione da incollare dove serve.
          </>
        )}
      </Hint>

      <Panel className="space-y-4">
        <PanelHeader title="Che database ti serve?" description="Se non sai quale, PostgreSQL va bene quasi sempre" />

        <ChoiceGroup label="Tipo di database" className="grid-cols-2 sm:grid-cols-4">
          {DATABASE_OPTIONS.map((opt) => (
            <ChoiceCard
              key={opt.type}
              selected={type === opt.type}
              onSelect={() => chooseType(opt.type)}
              title={opt.label}
              icon={opt.icon}
            />
          ))}
        </ChoiceGroup>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <TextField value={name} onChange={setName}>
              <Label>Nome</Label>
              <Input placeholder={suggestedName(type, projectSlug)} />
            </TextField>
            <FieldHint>
              Lascialo vuoto per usare <Code>{suggestedName(type, projectSlug)}</Code>. Minuscole, numeri,
              trattini e underscore.
            </FieldHint>
          </div>

          <Field
            label="Versione"
            hint="Quella proposta è la più recente. Se l'app la usa già in sviluppo con un'altra, scegli quella."
          >
            <ChoiceGroup label="Versione" className="flex flex-wrap">
              {option.versions.map((v) => (
                <ChoiceCard
                  key={v}
                  compact
                  selected={version === v}
                  onSelect={() => setVersion(v)}
                  title={v}
                  className="font-mono"
                />
              ))}
            </ChoiceGroup>
          </Field>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <PanelHeader title="Per quale progetto?" description="Facoltativo: con un progetto si collega da solo" />

        <ServerPicker description="Il database gira su questo server, insieme ai progetti che lo usano." />

        <SelectField
          label="Progetto"
          value={project}
          onChange={setProject}
          options={[
            { value: "", label: "Nessuno: database autonomo" },
            ...projects.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      </Panel>

      <Advanced summary="porta, chi può collegarsi, credenziali">
        <div>
          <TextField value={port} onChange={setPortTyped}>
            <Label>Porta sull&apos;host</Label>
            <Input type="number" />
          </TextField>
          <FieldHint>
            Serve per collegarti con un client esterno. Proposta una libera
            {freePort !== option.defaultPort ? ` (la ${option.defaultPort} è già usata qui)` : ""}; dentro la rete del
            progetto l&apos;app usa comunque la porta standard del container.
          </FieldHint>
        </div>

        {/*
          Off by default, because a database that answers only on this machine
          is a surprise for anyone who reaches for a client. Turning it on ticks
          the networks this host is actually on, which is the answer almost
          everyone wants and is one press away — and restricting from the start
          means the port is never open, which is not something that can be
          undone afterwards.
        */}
        <div>
          <SettingToggle
            label="Limita chi può collegarsi"
            description="Apre la porta solo alle reti locali trovate. Modificabile dopo, dalla pagina del database."
            isSelected={restrict}
            onChange={setRestrict}
          />
          {restrict && (
            <FieldHint>
              {lanNetworks.length > 0 ? (
                <>
                  Consentite: <Code>{lanNetworks.join(", ")}</Code>, più questa macchina. Mentre è attiva, è
                  il pannello a tenere aperta la porta.
                </>
              ) : (
                <>Nessuna rete locale trovata: solo questa macchina potrà collegarsi.</>
              )}
            </FieldHint>
          )}
        </div>

        {option.credentialled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField value={user} onChange={setUser}>
              <Label>Utente</Label>
              <Input className="font-mono text-sm" />
            </TextField>
            <TextField value={database} onChange={setDatabase}>
              <Label>Nome del database</Label>
              <Input className="font-mono text-sm" />
            </TextField>
          </div>
        )}

        <div>
          <TextField value={password} onChange={setPassword}>
            <Label>Password</Label>
            <Input type="password" placeholder="generata automaticamente" className="font-mono text-sm" />
          </TextField>
          <FieldHint>
            Vuota: viene generata e cifrata, e all&apos;app arriva da sola. Scrivila solo se stai ricreando un
            database che deve ritrovare dati già creati con quelle credenziali.
          </FieldHint>
        </div>
      </Advanced>

      <div className="flex justify-end">
        <Button variant="primary" isPending={saving} onPress={create}>
          Crea database
        </Button>
      </div>
    </div>
  );
}
