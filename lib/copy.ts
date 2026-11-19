/**
 * The words the panel uses for things that happen everywhere.
 *
 * "Salvataggio fallito" and "Salvataggio non riuscito" both existed, sometimes
 * in sibling tabs of the same screen, for the identical event. Nothing was
 * wrong with either — they had simply been written twice, months apart.
 *
 * The chosen verb is **non riuscito**, not "fallito", for a reason beyond
 * taste: `failed` is a lifecycle state in this product. A deploy is `failed`, a
 * backup run is `failed`, and those words appear as status badges. Using the
 * same Italian word for "the save request returned 500" blurs a status the
 * operator has to be able to trust.
 */
export const MSG = {
  saveFailed: "Salvataggio non riuscito",
  createFailed: "Creazione non riuscita",
  deleteFailed: "Eliminazione non riuscita",
  updateFailed: "Aggiornamento non riuscito",
  removeFailed: "Rimozione non riuscita",
  loadFailed: "Caricamento non riuscito",
  /** The request never reached the panel, as opposed to the panel refusing it. */
  unreachable: "Impossibile raggiungere il pannello",
} as const;

/**
 * The words of shared variables, as the Variabili tab's glossary has them.
 *
 * - **Variabili condivise**: the page, and the feature. Not "variabili globali":
 *   nothing reaches a project that was not attached to it or named by it.
 * - **Gruppo**: a named set of them. "Collegare" a gruppo to a progetto, like a
 *   database, and "scollegare" it.
 * - **Riferimento**: `${{ … }}` in a value, which reads another value.
 * - Where a variable comes from: **progetto**, **gruppo** «nome», **database**
 *   «nome», **RunPanel** for what the panel sets itself.
 *
 * The precedence is said in one sentence, the same on every screen that has to.
 */
export const SHARED_VARS = {
  title: "Variabili condivise",
  precedence:
    "Vince la variabile del progetto; tra i gruppi vince quello più in basso. Un database collegato vince su tutto.",
  applies: "Vale dal prossimo deploy o riavvio dei progetti che lo usano.",
  /** In a cluster: groups are not replicated. */
  serverScope: (server: string) => `I gruppi sono di ${server}: un progetto usa quelli del server su cui gira.`,
  attachNeedsPermission: "Per collegare un gruppo serve il permesso «Variabili condivise»: chi lo collega ne legge i valori.",
} as const;

/** "progetto", "gruppo «smtp»", "database «main»", "RunPanel": where a variable comes from. */
export function envSourceLabel(source: { kind: string; name?: string }): string {
  if (source.kind === "group") return `gruppo «${source.name}»`;
  if (source.kind === "database") return `database «${source.name}»`;
  if (source.kind === "panel") return "RunPanel";
  return "progetto";
}
