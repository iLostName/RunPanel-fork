/**
 * The first-run checklist: what a server that runs on its own still needs.
 *
 * A fresh install landed on an empty Overview and a banner of warnings, and
 * nothing said in what order to deal with them or which ones mattered. These
 * are the steps, in the order that makes each next one possible, worded for
 * someone who has never run a server.
 *
 * `facts` says, per step, whether it is done; a step that is undefined does
 * not apply here (the account lacks the permission, or the server has no use
 * for it) and is left out.
 *
 * Zero imports: the unit suite loads this file directly.
 */

export type OnboardingStep = "github" | "project" | "domain" | "backup" | "autostart" | "notifications";

export type OnboardingFacts = Partial<Record<OnboardingStep, boolean>>;

export interface OnboardingItem {
  id: OnboardingStep;
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
}

const STEPS: Omit<OnboardingItem, "done">[] = [
  {
    id: "github",
    title: "Collega GitHub",
    description: "Per scegliere i repository da un elenco, usare quelli privati e fare il deploy a ogni push.",
    href: "/github",
    cta: "Collega",
  },
  {
    id: "project",
    title: "Metti online il primo progetto",
    description: "Da un repository o da uno ZIP: RunPanel riconosce il tipo di app e la avvia.",
    href: "/projects/new",
    cta: "Crea",
  },
  {
    id: "domain",
    title: "Aggiungi un dominio",
    description: "Così ogni progetto ha un indirizzo come app.tuodominio.it, con HTTPS automatico.",
    href: "/domains",
    cta: "Configura",
  },
  {
    id: "backup",
    title: "Pianifica un backup notturno",
    description: "Database, configurazione e file dei progetti, ogni notte, con le ultime copie conservate.",
    href: "/backups",
    cta: "Pianifica",
  },
  {
    id: "autostart",
    title: "Fai ripartire tutto dopo un riavvio",
    description: "Se la macchina si riavvia, pannello, progetti e database tornano su da soli.",
    href: "/autostart",
    cta: "Attiva",
  },
  {
    id: "notifications",
    title: "Ricevi un avviso quando qualcosa si rompe",
    description: "Un messaggio quando un deploy fallisce, un'app si ferma o un backup non riesce.",
    href: "/settings",
    cta: "Collega",
  },
];

export function onboardingItems(facts: OnboardingFacts): OnboardingItem[] {
  return STEPS.filter((step) => facts[step.id] !== undefined).map((step) => ({ ...step, done: facts[step.id] === true }));
}

/**
 * Whether a nightly-style schedule covers the projects' files as well.
 *
 * `targets` is the policy's stored JSON. The one-click preset used to save
 * only the projects' configuration, and the project page then warned that no
 * schedule held its volumes: that is the gap this step is about.
 */
export function policyCoversVolumes(targetsJson: string): boolean {
  let targets: unknown;
  try {
    targets = JSON.parse(targetsJson);
  } catch {
    return false;
  }
  if (!Array.isArray(targets)) return false;
  return targets.some(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      ((t as { kind?: unknown }).kind === "all-projects" || (t as { kind?: unknown }).kind === "project") &&
      Array.isArray((t as { include?: unknown }).include) &&
      ((t as { include: unknown[] }).include).includes("volumes")
  );
}
