/**
 * Deploys without downtime: the parts that decide rather than act.
 *
 * For a Docker project served through the managed nginx, a deploy starts the
 * new version next to the one online, on a loopback port of its own; checks
 * it; moves nginx's upstream with a reload nginx has validated; and only then
 * retires the old container, after a short drain. Until nginx has moved, the
 * version online is never touched.
 *
 * What acts is in `services/docker/zero-downtime.ts` (the containers and the
 * sequence) and `services/zero-downtime.ts` (the store, nginx and the panel).
 *
 * Zero imports: the unit suite loads this file directly, and the settings page
 * runs `zeroDowntimeBlockers` in the browser on what the form holds.
 */

/**
 * Where the container of a project deployed this way is published, on
 * 127.0.0.1 only — nginx, on the same host, is the way in.
 *
 * Below Linux's ephemeral range (32768 and up): a port in there can be taken
 * at any moment by an outgoing connection, and Docker would then fail to bind
 * it halfway through a deploy. Away from the ranges people pick for their own
 * apps (3000–9999) and databases. A port another project, service or the panel
 * holds is skipped, and so is one something on the host is listening on.
 */
export const LIVE_PORT_FIRST = 21000;
export const LIVE_PORT_LAST = 21999;

/** How long the old container stays up after the switch, for the requests it is still answering. */
export const DRAIN_DEFAULT_SEC = 15;
/** nginx gives a proxied request at most 300 s (`proxy_read_timeout`): waiting longer helps nobody. */
export const DRAIN_MAX_SEC = 300;

/**
 * The next free port of the range, starting after `after` (the port the
 * project is on now) and wrapping around: consecutive deploys move along the
 * range instead of taking back, at once, the port the previous one just let
 * go. Null when every port is taken.
 */
export function pickLivePort(
  used: ReadonlySet<number>,
  after: number | null = null,
  range: { first: number; last: number } = { first: LIVE_PORT_FIRST, last: LIVE_PORT_LAST }
): number | null {
  const size = range.last - range.first + 1;
  if (!Number.isInteger(size) || size <= 0) return null;
  const start = after !== null && after >= range.first && after <= range.last ? after - range.first + 1 : 0;
  for (let i = 0; i < size; i++) {
    const port = range.first + ((start + i) % size);
    if (!used.has(port)) return port;
  }
  return null;
}

// --- Where it can work --------------------------------------------------------

export type ZeroDowntimeBlocker =
  | "runtime"
  | "healthcheck"
  | "port"
  | "healthcheck-port"
  | "network"
  | "single-instance"
  | "restricted"
  | "address"
  | "proxy";

export interface ZeroDowntimeFacts {
  runtimeType: string;
  /** `contract.docker.network`. */
  network: string;
  healthcheck: { enabled: boolean; port?: number | null };
  /** The project's port: the one the app listens on inside its container. */
  port: number | null;
  /** The panel's IP restriction is on: its gate holds the public port and forwards to one listener. */
  restricted: boolean;
  /** `runtime.singleInstance`: two live copies of the app would be wrong, not slower. */
  singleInstance: boolean;
  /** Names nginx serves the app on: not set aside by an apply, not a twin that only redirects. */
  servedHosts: number;
  /** nginx can take a configuration (`canApply` in services/proxy). */
  proxyReady: boolean;
}

/**
 * Why a project cannot be deployed this way now, in the order an operator
 * would fix them. Empty: it can.
 */
export function zeroDowntimeBlockers(facts: ZeroDowntimeFacts): ZeroDowntimeBlocker[] {
  const blockers: ZeroDowntimeBlocker[] = [];
  if (facts.runtimeType !== "docker") return ["runtime"];
  if (!facts.healthcheck.enabled) blockers.push("healthcheck");
  if (!facts.port || facts.port <= 0) blockers.push("port");
  // The probe would land on whatever answers that port on the host — the old
  // version, or nothing — and pass or fail for the wrong container.
  else if (facts.healthcheck.enabled && facts.healthcheck.port && facts.healthcheck.port !== facts.port) {
    blockers.push("healthcheck-port");
  }
  if (facts.network === "host") blockers.push("network");
  if (facts.singleInstance) blockers.push("single-instance");
  if (facts.restricted) blockers.push("restricted");
  if (facts.servedHosts <= 0) blockers.push("address");
  else if (!facts.proxyReady) blockers.push("proxy");
  return blockers;
}

/** Each reason in plain words, for the settings and the deploy log. */
export const ZERO_DOWNTIME_BLOCKERS: Record<ZeroDowntimeBlocker, string> = {
  runtime:
    "C'è solo con il runtime Docker: Compose ricrea lo stack dal suo file e un'app nativa gira come un solo processo.",
  healthcheck:
    "Serve il controllo di salute: è lui a dire quando la nuova versione è pronta a ricevere le richieste.",
  port: "Serve una porta: è quella su cui l'app riceve le richieste da nginx.",
  "healthcheck-port":
    "Il controllo di salute usa una porta diversa da quella dell'app: con due versioni accese insieme non si saprebbe quale delle due risponde.",
  network:
    "Con la rete host due container non possono ascoltare sulla stessa porta: passa alla rete project o bridge.",
  "single-instance":
    "L'app è impostata per girare in una sola copia (Risorse): durante il passaggio ne girerebbero due.",
  restricted:
    "Con l'accesso limitato per indirizzo la porta pubblica la tiene il pannello e punta a un solo container: togli il limite per usarlo.",
  address:
    "Serve almeno un indirizzo servito da nginx (Impostazioni › Indirizzi): senza, l'app si raggiunge sulla sua porta, che due versioni non possono avere insieme.",
  proxy: "nginx non è pronto su questo server (pagina Domini): è lui che passa le richieste da una versione all'altra.",
};

// --- The steps of a deploy ------------------------------------------------------

/**
 * The steps, in order. `committed` is the line: from there the new version
 * is the live one in nginx and in the store, and nothing is undone any more.
 */
export const RELEASE_PHASES = ["candidate", "health", "switch", "committed", "promoted", "drained"] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];

export interface FailureOutcome {
  /** The new container goes: it never served anybody. */
  removeCandidate: boolean;
  /** The deploy is recorded as failed; false when it already counts as done. */
  failed: boolean;
  /** The container online before the deploy is touched. Never, at any step. */
  touchLive: false;
}

/**
 * What a failure at `phase` leaves to undo.
 *
 * Before the switch the version online has not been touched: the candidate
 * goes and that is all — which is also what makes a separate automatic
 * return unnecessary here. A switch nginx refused changed nothing either.
 * `stuck` is the one exception: nginx took the new upstream and the store
 * could not record it, and putting nginx back failed too. Then the candidate
 * may be what nginx serves, and it stays for the next boot to settle.
 */
export function failureOutcome(phase: ReleasePhase, stuck = false): FailureOutcome {
  const committed = RELEASE_PHASES.indexOf(phase) >= RELEASE_PHASES.indexOf("committed");
  if (committed) return { removeCandidate: false, failed: false, touchLive: false };
  return { removeCandidate: !(phase === "switch" && stuck), failed: true, touchLive: false };
}

// --- One live container -----------------------------------------------------

/** The three names a project's app container can have. */
export interface ZdNames {
  /** `runpanel-<slug>`: what every feature addresses — logs, terminal, tasks, restarts. */
  live: string;
  /** A new version being checked, before it takes over. */
  next: string;
  /** The version that served until the switch, while it drains. */
  old: string;
}

export interface ZdContainer {
  name: string;
  /** Docker's `{{.State}}`: running, exited, created, restarting… */
  state: string;
  /** The deployment it was started for, from its label; null on an older container. */
  deployment: string | null;
  /** The loopback port it is published on, from its label; null when published the ordinary way. */
  livePort: number | null;
}

export interface SettlePlan {
  /** The container that stays: the live one. */
  keep: ZdContainer | null;
  /** Removed first: leftovers that never served, or that no longer do. */
  remove: string[];
  /** Then these, in order. */
  renames: { from: string; to: string }[];
  /** The container that served until now, under `names.old`: drained, then removed. */
  retire: string | null;
  /** What `projects.live_port` must say afterwards; undefined leaves it as it is (nothing is live). */
  livePort: number | null | undefined;
}

const isUp = (container: ZdContainer) => container.state === "running" || container.state === "restarting";

/**
 * Which container is the live one, and what to do with the others, so that
 * exactly one remains under the name every feature uses.
 *
 * `liveDeployment` is the deployment the store says is online (status
 * `running`): a deploy that was cut short is recorded as failed at boot, so
 * its candidate is never chosen over the version it was meant to replace,
 * and a deploy that committed is chosen even if the renames never happened.
 * Without a container of that deployment — a restart made before restarts
 * carried the label, a container removed by hand — the one under the live
 * name stays; failing that, whatever still runs, rather than nothing.
 *
 * `drain` is the deploy's own path: the container that served until now is
 * renamed out of the way and left to finish its requests. At boot there is
 * nothing to wait for, and every other container is removed at once.
 */
export function planSettle(
  names: ZdNames,
  containers: readonly ZdContainer[],
  liveDeployment: string | null,
  opts: { drain: boolean }
): SettlePlan {
  const own = containers.filter((c) => c.name === names.live || c.name === names.next || c.name === names.old);
  const matches = liveDeployment ? own.filter((c) => c.deployment === liveDeployment) : [];
  const prefer = (list: ZdContainer[]) =>
    list.find((c) => c.name === names.live && isUp(c)) ??
    list.find(isUp) ??
    list.find((c) => c.name === names.live) ??
    list[0] ??
    null;
  const keep =
    prefer(matches) ??
    own.find((c) => c.name === names.live) ??
    own.find((c) => c.name === names.old && isUp(c)) ??
    own.find((c) => c.name === names.next && isUp(c)) ??
    null;

  const remove: string[] = [];
  const renames: { from: string; to: string }[] = [];
  let retire: string | null = null;

  if (!keep) {
    // Nothing that could be live: what a deploy left behind goes, and the
    // live name keeps whatever holds it.
    for (const c of own) if (c.name !== names.live) remove.push(c.name);
    return { keep: null, remove, renames, retire, livePort: undefined };
  }

  for (const c of own) {
    if (c === keep) continue;
    const drains = opts.drain && retire === null && c.name === names.live && isUp(c) && keep.name !== names.old;
    if (drains) {
      retire = names.old;
      renames.push({ from: c.name, to: names.old });
    } else {
      remove.push(c.name);
    }
  }
  if (keep.name !== names.live) renames.push({ from: keep.name, to: names.live });

  return { keep, remove, renames, retire, livePort: keep.livePort };
}
