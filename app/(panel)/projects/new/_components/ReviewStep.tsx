"use client";

import { useMemo, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import { useNodeApi } from "@/lib/hooks/useNode";
import { useExpertMode } from "@/components/Providers";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { SettingToggle } from "@/components/ui/SettingToggle";
import { ChoiceCard, ChoiceGroup } from "@/components/ui/ChoiceCard";
import { Field } from "@/components/ui/Field";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { Advanced, Technical } from "@/components/ui/Technical";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { GithubConnectDialog } from "@/components/github/GithubConnectDialog";
import { firstFreePort, portsInUse } from "@/lib/ports";
import { connectionEnvKey } from "@/lib/service-env";
import { hostnameFor, normalizeSubdomain } from "@/lib/proxy-names";
import { parseDotenv } from "@/lib/dotenv-parse";
import {
  DATABASE_LABEL,
  choicesProblem,
  isNativeRuntime,
  suggestProjectName,
  type NewProjectChoices,
  type WizardDatabase,
  type WizardRuntime,
} from "@/lib/new-project-plan";
import type { DetectState, PickedSource } from "./types";

const RUNTIMES: { id: WizardRuntime; label: string; hint: string; icon: string }[] = [
  { id: "node", label: "Node.js", hint: "Installa le dipendenze, fa la build e avvia lo script start", icon: "solar:code-linear" },
  { id: "static", label: "Sito statico", hint: "Pubblica i file HTML, con una build se serve", icon: "solar:document-text-linear" },
  { id: "docker", label: "Docker", hint: "Costruisce il Dockerfile del repository", icon: "solar:box-linear" },
  { id: "compose", label: "Compose", hint: "Avvia lo stack descritto dal file compose", icon: "solar:layers-linear" },
  { id: "custom", label: "Personalizzato", hint: "Comandi tuoi, qualsiasi linguaggio", icon: "solar:command-linear" },
];

const DATABASES: WizardDatabase[] = ["postgresql", "mysql", "redis", "mongodb"];

interface DomainsResponse {
  proxy?: { state: string; detail: string };
  domains?: { id: string; name: string }[];
  hosts?: { hostname: string }[];
}

export interface LaunchRequest {
  name: string;
  choices: NewProjectChoices;
  /** For the success screen: the public address, when one was chosen. */
  hostname: string | null;
  /** Ports the database step must avoid, as seen when the button was pressed. */
  usedPorts: number[];
}

/**
 * Step 2: what was found, and the few questions that are left.
 *
 * Everything is pre-filled from the detection, so for a recognised app the
 * whole step can be one press of "Crea e metti online". The choices that need
 * knowing what a runtime or a port is sit under "Personalizza", open by
 * default in expert mode.
 */
export function ReviewStep({
  source,
  detect,
  githubConnected,
  onGithubConnected,
  onRetryDetect,
  onBack,
  onLaunch,
}: {
  source: PickedSource;
  detect: DetectState;
  githubConnected: boolean;
  onGithubConnected: () => void;
  onRetryDetect: () => void;
  onBack: () => void;
  onLaunch: (request: LaunchRequest) => void;
}) {
  const api = useNodeApi();
  const { expert } = useExpertMode();
  const canHost = useCan("host");
  const detection = detect.status === "ok" ? detect.detection : null;
  const recognised = detection?.recognised ?? false;

  // --- answers, seeded once from the detection ----------------------------------
  const [name, setName] = useState(() =>
    suggestProjectName(source.kind === "github" ? (source.repo?.name ?? source.url) : source.file.name)
  );
  const [web, setWeb] = useState(true);
  const [runtime, setRuntime] = useState<WizardRuntime>("node");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [portTyped, setPortTyped] = useState<string | null>(null);
  const [install, setInstall] = useState("");
  const [build, setBuild] = useState("");
  const [start, setStart] = useState("");
  const [branch, setBranch] = useState(source.kind === "github" ? source.branch : "");
  const [wantDatabase, setWantDatabase] = useState(false);
  const [database, setDatabase] = useState<WizardDatabase>("postgresql");
  const [envText, setEnvText] = useState("");
  const [domainId, setDomainId] = useState("");
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);

  // Seeded during render when a detection arrives (as AppForm does), not in an
  // effect, so the first paint already shows the answers. Each detection seeds
  // once: only a retry or a new source produces a new one.
  const [seededFor, setSeededFor] = useState<DetectState | null>(null);
  if (detect.status !== "loading" && seededFor !== detect) {
    setSeededFor(detect);
    if (detection?.recognised) {
      setRuntime(detection.runtime);
      setPresetId(detection.presetId);
      setWeb(detection.web);
      if (detection.databases.length > 0) {
        setWantDatabase(true);
        setDatabase(detection.databases[0]);
      }
    }
  }

  // --- what is already taken on this server ---------------------------------------
  const { data: projectsData } = useResource<{ name: string; port: number | null }[]>(api("/api/projects"));
  const { data: servicesData } = useResource<{ port: number; access_port?: number | null }[]>(api("/api/services"));
  const projects = useMemo(() => (Array.isArray(projectsData) ? projectsData : []), [projectsData]);
  const used = useMemo(
    () => portsInUse([...(Array.isArray(servicesData) ? servicesData : []), ...projects]),
    [servicesData, projects]
  );

  const detectedPort = detection?.port ?? null;
  // Native apps are handed their port in PORT, so a taken one is simply skipped;
  // a container listens where its image says, so that one is only flagged.
  const suggestedPort = !web || runtime === "compose"
    ? null
    : isNativeRuntime(runtime)
      ? firstFreePort(detectedPort ?? 3000, used)
      : detectedPort;
  const portText = portTyped ?? (suggestedPort?.toString() ?? "");
  const port = portText.trim() ? Number.parseInt(portText, 10) : null;
  const portOwner = port !== null ? projects.find((p) => p.port === port)?.name : undefined;
  const portShifted = portTyped === null && detectedPort !== null && suggestedPort !== null && suggestedPort !== detectedPort;

  // --- variables ----------------------------------------------------------------
  const parsedEnv = useMemo(() => parseDotenv(envText), [envText]);
  const dbKey = connectionEnvKey(database);
  const envOverridesDb = wantDatabase && parsedEnv.vars.some((v) => v.key === dbKey);

  // --- address ------------------------------------------------------------------
  const { data: domainsData } = useResource<DomainsResponse>(canHost ? api("/api/domains") : null);
  const domains = domainsData?.domains ?? [];
  const proxyReady = domainsData?.proxy?.state === "ready";
  const domain = domains.find((d) => d.id === domainId) ?? null;
  // From the name, but never empty by accident: empty means the bare domain,
  // which has to be a choice someone made.
  const subdomainText =
    subdomain ?? (name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "app");
  const label = normalizeSubdomain(subdomainText);
  const hostname = domain && label !== null ? hostnameFor(label, domain.name) : null;
  const hostTaken = hostname ? (domainsData?.hosts ?? []).some((h) => h.hostname === hostname) : false;
  const addressError =
    domain && label === null
      ? "Una sola parola: minuscole, numeri e trattini"
      : hostTaken
        ? `${hostname} è già usato da un altro progetto`
        : null;

  const isGithub = source.kind === "github";
  const choices: NewProjectChoices = {
    source: isGithub ? { kind: "github", url: source.url, branch } : { kind: "zip" },
    runtime,
    presetId,
    web,
    port: web ? port : null,
    commands: { install, build, start },
    autoDeploy: isGithub && githubConnected && autoDeploy,
    env: parsedEnv.vars,
    database: wantDatabase ? database : null,
    address: web && domain && label !== null && !addressError ? { domainId: domain.id, subdomain: label } : null,
  };
  const problem =
    choicesProblem(choices, name) ??
    (parsedEnv.invalid.length > 0 ? "Correggi le righe non valide delle variabili" : null) ??
    (addressError && domain ? addressError : null);

  function launch() {
    if (problem) return;
    onLaunch({ name: name.trim(), choices, hostname: choices.address ? hostname : null, usedPorts: [...used] });
  }

  const sourceLabel =
    source.kind === "github" ? `${source.repo?.full_name ?? source.url}${branch ? ` · ${branch}` : ""}` : source.file.name;

  return (
    <div className="max-w-2xl space-y-4">
      {/* --- what was found ---------------------------------------------------- */}
      <Panel className="space-y-4">
        <PanelHeader
          title="Cosa abbiamo trovato"
          description={sourceLabel}
          actions={
            <Button variant="ghost" size="sm" onPress={onBack}>
              Cambia sorgente
            </Button>
          }
        />
        {detect.status === "loading" ? (
          <div className="space-y-2" aria-live="polite">
            <p className="text-muted text-sm">Sto guardando il codice…</p>
            <SkeletonBlock className="h-10" />
            <SkeletonBlock className="h-16" />
          </div>
        ) : detection && recognised ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Icon icon="solar:check-circle-bold" width={22} className="text-success shrink-0" aria-hidden />
              <span className="text-foreground text-lg font-medium">{detection.framework}</span>
              {web && port !== null && <Badge mono>porta {port}</Badge>}
              {!web && <Badge>servizio in background</Badge>}
              {detection.packageManager && <Badge mono>{detection.packageManager}</Badge>}
              {detection.databases.map((db) => (
                <Badge key={db} tone="accent" icon="solar:database-linear">
                  {DATABASE_LABEL[db]}
                </Badge>
              ))}
            </div>
            <ul className="space-y-1.5">
              {detection.evidence.map((line) => (
                <li key={line} className="text-muted flex items-start gap-2 text-sm">
                  <Icon icon="solar:check-read-linear" width={16} className="text-success mt-0.5 shrink-0" aria-hidden />
                  {line}
                </li>
              ))}
            </ul>
            <Technical>
              <p className="text-muted text-xs">
                Runtime <Code>{detection.runtime}</Code>
                {detection.presetId && <> · preset <Code>{detection.presetId}</Code></>}
                {detection.scripts.build && <> · build <Code>{detection.scripts.build}</Code></>}
                {detection.scripts.start && <> · start <Code>{detection.scripts.start}</Code></>}
              </p>
            </Technical>
          </>
        ) : detect.status === "error" ? (
          <Hint tone="warn" title="Non sono riuscito a leggere il codice">
            <p>{detect.message}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onPress={onRetryDetect}>
                Riprova
              </Button>
              <Button variant="ghost" size="sm" onPress={onBack}>
                Cambia sorgente
              </Button>
            </div>
            <p className="mt-2 text-xs">Puoi anche continuare: scegli tu come avviarla in «Personalizza».</p>
          </Hint>
        ) : (
          <Hint tone="info" title={detect.status === "unsupported" ? "Lo riconosceremo al primo deploy" : "Non abbiamo riconosciuto il tipo di app"}>
            {detect.status === "unsupported"
              ? detect.reason
              : "Nessun file che conosciamo (package.json, Dockerfile, requirements.txt, go.mod, index.html) nella cartella principale. Scegli tu come avviarla in «Personalizza»."}
          </Hint>
        )}
      </Panel>

      {/* --- the questions ------------------------------------------------------- */}
      <Panel className="space-y-5">
        <PanelHeader title="Il progetto" />
        <div>
          <TextField value={name} onChange={setName}>
            <Label>Nome</Label>
            <Input placeholder="il-mio-sito" />
          </TextField>
          <FieldHint>Come lo vedrai nel pannello. Puoi cambiarlo quando vuoi.</FieldHint>
        </div>

        <Field
          label="Che cosa fa"
          hint={
            web
              ? "Ha delle pagine o un'API: il pannello controlla che risponda dopo ogni deploy."
              : "Un bot, un worker o una coda: niente pagine web, quindi niente controllo che risponda e niente indirizzo."
          }
        >
          <Segmented
            label="Tipo di app"
            value={web ? "web" : "worker"}
            onChange={(value) => setWeb(value === "web")}
            options={[
              { value: "web", label: "Sito o app web", icon: "solar:global-linear" },
              { value: "worker", label: "Servizio in background", icon: "solar:bolt-linear" },
            ]}
          />
        </Field>

        <div className="space-y-3">
          <SettingToggle
            label={detection?.databases.length ? `Crea anche un database ${DATABASE_LABEL[database]}` : "Questa app usa un database?"}
            description={
              wantDatabase
                ? `Viene creato insieme al progetto e collegato da solo: l'app riceve ${dbKey}, senza password da copiare.`
                : detection?.databases.length
                  ? "Il codice sembra usarne uno. Se è già ospitato altrove, lascialo spento e incolla il suo indirizzo nelle variabili."
                  : "Se serve, viene creato e collegato insieme al progetto."
            }
            isSelected={wantDatabase}
            onChange={setWantDatabase}
          />
          {wantDatabase && (
            <Segmented
              label="Tipo di database"
              value={database}
              onChange={setDatabase}
              options={DATABASES.map((db) => ({ value: db, label: DATABASE_LABEL[db] }))}
            />
          )}
          {envOverridesDb && (
            <Hint tone="warn">
              Hai incollato anche <Code>{dbKey}</Code>: l&apos;app userà il valore che hai incollato, non il database creato qui.
            </Hint>
          )}
        </div>

        {web && runtime === "docker" && port === null && detect.status !== "loading" && (
          <Hint tone="warn" title="Su che porta risponde?">
            Il Dockerfile non lo dice (manca <Code>EXPOSE</Code>): indicala in «Personalizza», altrimenti l&apos;app non sarà
            raggiungibile.
          </Hint>
        )}

        {isGithub && (
          <div className="space-y-2">
            <SettingToggle
              label="Aggiorna l'app a ogni push"
              description={
                githubConnected
                  ? `Quando arriva un commit su ${branch || "main"}, il pannello fa da solo un nuovo deploy.`
                  : "Per accorgersi dei push il pannello deve poter parlare con GitHub."
              }
              isSelected={githubConnected && autoDeploy}
              onChange={setAutoDeploy}
              isDisabled={!githubConnected}
            />
            {!githubConnected && (
              <Button variant="secondary" size="sm" onPress={() => setConnectOpen(true)}>
                <Icon icon="solar:link-round-linear" width={16} aria-hidden />
                Collega GitHub
              </Button>
            )}
          </div>
        )}
      </Panel>

      {/* --- optional: address --------------------------------------------------- */}
      {web && canHost && (
        <Panel className="space-y-4">
          <PanelHeader title="Indirizzo" description="Facoltativo: puoi aggiungerlo anche dopo" />
          {domains.length === 0 ? (
            <p className="text-muted text-sm">
              Nessun dominio configurato. Quando ne aggiungi uno in Domini potrai dare all&apos;app un indirizzo come{" "}
              <Code>app.tuodominio.it</Code>.
            </p>
          ) : (
            <>
              <SelectField
                label="Dominio"
                value={domainId}
                onChange={setDomainId}
                options={[
                  { value: "", label: "Lo aggiungo dopo" },
                  ...domains.map((d) => ({ value: d.id, label: d.name })),
                ]}
              />
              {domain && (
                <Field
                  label="Sottodominio"
                  error={addressError}
                  hint={hostname && !addressError ? <>L&apos;app sarà su <Code>https://{hostname}</Code>. Vuoto per il dominio intero.</> : undefined}
                >
                  <TextField value={subdomainText} onChange={setSubdomain} aria-label="Sottodominio">
                    <Input placeholder="app" className="font-mono text-sm" />
                  </TextField>
                </Field>
              )}
              {domain && domainsData?.proxy && !proxyReady && (
                <Hint tone="warn" title="Il proxy non è ancora pronto">
                  {domainsData.proxy.detail} L&apos;indirizzo viene salvato e funzionerà appena il proxy è configurato in Domini.
                </Hint>
              )}
            </>
          )}
        </Panel>
      )}

      {/* --- optional: variables ---------------------------------------------- */}
      <Advanced title="Variabili d'ambiente" summary="facoltative: chiavi, token, impostazioni dell'app">
        <div>
          <textarea
            aria-label="Contenuto del file .env"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={"API_KEY=…\nNODE_ENV=production"}
            rows={6}
            spellCheck={false}
            className="border-border bg-background text-foreground focus:border-accent/60 w-full resize-y rounded-[var(--radius)] border px-3 py-2 font-mono text-sm outline-none"
          />
          <FieldHint>
            Incolla il contenuto di un file <Code>.env</Code>: una variabile per riga, i commenti con # vengono ignorati.
            {parsedEnv.vars.length > 0 && <> Lette: {parsedEnv.vars.length}.</>}
          </FieldHint>
          {parsedEnv.invalid.length > 0 && (
            <ul className="text-danger mt-2 space-y-1 text-sm" role="alert">
              {parsedEnv.invalid.map((issue) => (
                <li key={issue.line}>
                  Riga {issue.line}: {issue.reason}
                </li>
              ))}
            </ul>
          )}
          {parsedEnv.duplicates.length > 0 && (
            <p className="text-warning mt-2 text-sm">
              Ripetute: {parsedEnv.duplicates.join(", ")} (vale l&apos;ultima).
            </p>
          )}
        </div>
      </Advanced>

      {/* --- customise -------------------------------------------------------------- */}
      {/* Keyed by the detection's outcome: it opens by itself when nothing was
          recognised, which is only known after the first render. */}
      <Advanced
        key={detect.status === "loading" ? "loading" : recognised ? "found" : "manual"}
        title="Personalizza"
        summary="runtime, porta, comandi"
        defaultExpanded={!recognised && detect.status !== "loading" ? true : expert}
      >
        <ChoiceGroup label="Runtime" className="sm:grid-cols-3">
          {RUNTIMES.map((r) => (
            <ChoiceCard
              key={r.id}
              compact
              selected={runtime === r.id}
              onSelect={() => {
                setRuntime(r.id);
                // A preset belongs to one runtime: keep it only if it still fits.
                if (r.id !== detection?.runtime) setPresetId(null);
                else setPresetId(detection?.presetId ?? null);
              }}
              icon={r.icon}
              title={r.label}
              description={r.hint}
            />
          ))}
        </ChoiceGroup>

        {web && (
          <Field
            label={runtime === "compose" ? "Porta (facoltativa)" : "Porta"}
            hint={
              portShifted
                ? `La ${detectedPort} è già usata su questo server: l'app riceve la ${suggestedPort} nella variabile PORT.`
                : isNativeRuntime(runtime)
                  ? "L'app la riceve nella variabile PORT e deve mettersi in ascolto lì."
                  : runtime === "compose"
                    ? "La porta che lo stack pubblica sul server: serve solo per dargli un indirizzo."
                    : "La porta su cui risponde il container."
            }
            error={portOwner && portTyped !== null ? `La usa già «${portOwner}»` : undefined}
          >
            <TextField value={portText} onChange={setPortTyped} aria-label="Porta">
              <Input inputMode="numeric" className="max-w-[10rem] font-mono text-sm" placeholder="3000" />
            </TextField>
          </Field>
        )}
        {web && runtime === "docker" && portOwner && portTyped === null && (
          <Hint tone="warn">
            La porta {port} è già usata da «{portOwner}»: cambiala qui, oppure il container non potrà partire.
          </Hint>
        )}

        {isGithub && (
          <div>
            <TextField value={branch} onChange={setBranch}>
              <Label>Branch</Label>
              <Input className="font-mono text-sm" placeholder="main" />
            </TextField>
          </div>
        )}

        {runtime !== "compose" && (
          <div className="space-y-3">
            <p className="text-muted text-sm">
              {runtime === "custom"
                ? "Con il runtime personalizzato serve almeno il comando di avvio."
                : "Lasciali vuoti: vengono ricavati dal progetto. Scrivili solo per cambiarli."}
            </p>
            {runtime !== "docker" && (
              <>
                <TextField value={install} onChange={setInstall}>
                  <Label>Installazione</Label>
                  <Input className="font-mono text-sm" placeholder={runtime === "custom" ? "pip install -r requirements.txt" : "automatica"} />
                </TextField>
                <TextField value={build} onChange={setBuild}>
                  <Label>Build</Label>
                  <Input className="font-mono text-sm" placeholder={detection?.scripts.build ?? (runtime === "custom" ? "nessuna" : "automatica")} />
                </TextField>
              </>
            )}
            <TextField value={start} onChange={setStart}>
              <Label>Avvio</Label>
              <Input className="font-mono text-sm" placeholder={detection?.scripts.start ?? (runtime === "custom" ? "python main.py" : "automatico")} />
            </TextField>
          </div>
        )}
      </Advanced>

      {/* --- launch -------------------------------------------------------------- */}
      <Panel className="space-y-3">
        <p className="text-foreground text-sm">
          {summaryLine(name.trim() || "il progetto", detection?.recognised ? detection.framework : null, choices, hostname)}
        </p>
        {problem && detect.status !== "loading" && (
          <p className="text-danger text-sm" role="alert">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 max-md:flex-col-reverse max-md:items-stretch max-md:*:w-full">
          <Button variant="ghost" onPress={onBack}>
            <Icon icon="solar:alt-arrow-left-linear" width={16} aria-hidden />
            Indietro
          </Button>
          <Button variant="primary" isDisabled={Boolean(problem) || detect.status === "loading"} onPress={launch}>
            <Icon icon="solar:rocket-2-linear" width={16} aria-hidden />
            Crea e metti online
          </Button>
        </div>
      </Panel>

      <GithubConnectDialog
        isOpen={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={() => {
          setConnectOpen(false);
          setAutoDeploy(true);
          onGithubConnected();
        }}
      />
    </div>
  );
}

/** One sentence saying what the button will do. */
function summaryLine(name: string, framework: string | null, choices: NewProjectChoices, hostname: string | null): string {
  const parts = [`Creo «${name}»`];
  if (framework) parts.push(`come app ${framework}`);
  if (choices.database) parts.push(`con un database ${DATABASE_LABEL[choices.database]}`);
  if (choices.env.length > 0) parts.push(`${choices.env.length} ${choices.env.length === 1 ? "variabile" : "variabili"}`);
  let line = parts.join(", ");
  line += hostname ? `, la metto su ${hostname}` : "";
  line += " e faccio il primo deploy.";
  if (choices.autoDeploy) line += " Poi si aggiornerà da sola a ogni push.";
  return line;
}
