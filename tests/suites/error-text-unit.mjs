import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * What reaches the screen when a request fails, who may open what, and what
 * each page is called.
 *
 * `HTTP 403`, `Failed to fetch` and `ECONNREFUSED` were all shown as they came.
 * The two rules that matter: a code never reaches the reader as the sentence,
 * and a refusal is told apart from a failure, because only one of the two is
 * worth a Riprova.
 *
 * Standalone: `lib/error-text.ts` and `lib/nav.ts` have no runtime imports.
 */
export const meta = { name: "error-text-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("error-text-unit");
  const load = (file) => import(pathToFileURL(join(repoRoot, "lib", file)).href);
  const { readableError, refusalNote, FORBIDDEN_TEXT, isNotFound } = await load("error-text.ts");
  const { pageAt, passesNavPermission, titleOfPath, SUBPAGE_TITLES, CRUMBS_WITHOUT_PAGE } = await load("nav.ts");

  // --- failures in words ------------------------------------------------------
  {
    const raw = "ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3988";
    const down = readableError(raw);
    r.check("a refused connection is a sentence", down.text === "Server non raggiungibile", down.text);
    r.check("and keeps the original for an operator", down.detail === raw, String(down.detail));
    r.check("a TLS code too", readableError("DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate").text === "Server non raggiungibile");
    r.check("the browser failure names the panel", readableError("Failed to fetch").text === "Non riesco a contattare il pannello");
    r.check("Firefox wording too", readableError("NetworkError when attempting to fetch resource.").text === "Non riesco a contattare il pannello");
    const http = readableError("HTTP 500");
    r.check("a 500 is a sentence", http.text === "Errore interno del server" && http.detail === "HTTP 500", http.text);
    r.check("the hand-written form reads the same", readableError("Il server ha risposto 500").text === http.text);
    r.check("a 401 here is the session", readableError("HTTP 401").text.startsWith("Sessione scaduta"));
    r.check("a 401 from a member is not", readableError("HTTP 401 dal server").text === "Il server non riconosce questo pannello");
    r.check("a gateway error says nobody answers", readableError("HTTP 502").text === "Il server non risponde");
  }

  // --- what passes through ----------------------------------------------------
  {
    const sentence = "Nessuna risposta entro il tempo limite";
    const same = readableError(sentence);
    r.check("a sentence is left alone", same.text === sentence && same.detail === null && !same.forbidden);
    r.check("an uppercase word in a sentence is not a code", readableError("DNS non configurato").text === "DNS non configurato");
  }

  // --- refusals ---------------------------------------------------------------
  {
    r.check("a 403 is a refusal", readableError("HTTP 403").forbidden && readableError("HTTP 403").text === FORBIDDEN_TEXT);
    r.check("from a member too", readableError("HTTP 403 dal server").forbidden);
    r.check("the words of the route are one", readableError("Non hai il permesso per questa operazione").forbidden);
    r.check("the owner-only refusal keeps its words", readableError("Solo il proprietario può farlo").text === "Solo il proprietario può farlo");
    r.check("a failure is not one", !readableError("HTTP 500").forbidden && !readableError("Failed to fetch").forbidden);
    r.check("the bracket stays out of a refusal", refusalNote("HTTP 403") === "");
    r.check("and out of nothing", refusalNote(null) === "");
    r.check("and carries a failure in words", refusalNote("HTTP 500") === " (Errore interno del server)", refusalNote("HTTP 500"));
  }

  // --- which page a path belongs to -------------------------------------------
  {
    r.check("a page is itself", pageAt("/monitor")?.href === "/monitor");
    r.check("a detail belongs to its list", pageAt("/users/abc")?.href === "/users");
    r.check("however deep", pageAt("/backups/runs/abc")?.href === "/backups");
    r.check("a prefix of a name is not the page", pageAt("/monitoring") === undefined);
    r.check("an unknown path has no page", pageAt("/nope") === undefined);
    r.check("the Overview needs nothing", pageAt("/home")?.permission === undefined);
    const settings = pageAt("/settings");
    r.check("Pannello opens with either permission", passesNavPermission(settings?.permission, (p) => p === "registries"));
    r.check("and stays shut with neither", !passesNavPermission(settings?.permission, () => false));
  }

  // --- what a path is called: the crumb, the phone's bar, the heading ---------
  {
    r.check("a destination is called what the sidebar calls it", titleOfPath("/services") === "Database" && titleOfPath("/settings") === "Generale");
    r.check(
      "new is three pages, each under its own name",
      titleOfPath("/projects/new") === "Nuovo progetto" && titleOfPath("/services/new") === "Nuovo database" && titleOfPath("/backups/new") === "Nuova pianificazione",
      [titleOfPath("/projects/new"), titleOfPath("/services/new"), titleOfPath("/backups/new")].join(", ")
    );
    r.check("the catalogue is what its heading says", titleOfPath("/projects/new/catalog") === SUBPAGE_TITLES["/projects/new/catalog"]);
    r.check("a project's settings are not the panel's", titleOfPath("/projects/abc/settings") === undefined);
    r.check("an id is left to its page", titleOfPath("/projects/abc") === undefined && titleOfPath("/backups/runs/abc") === undefined);
    r.check("a level with no page is named, not linked", titleOfPath("/backups/runs") === "Esecuzioni" && CRUMBS_WITHOUT_PAGE.has("/backups/runs"));
    r.check("every sub-page is a real page", Object.keys(SUBPAGE_TITLES).every((path) => !CRUMBS_WITHOUT_PAGE.has(path)));
    r.check("nothing inherited is a title", titleOfPath("constructor") === undefined && titleOfPath("__proto__") === undefined);
  }

  // --- gone, rather than failed -------------------------------------------------
  r.check("a 404 from the hook means gone", isNotFound("HTTP 404") === true);
  r.check("a 404 forwarded from another server means gone", isNotFound("Il server ha risposto 404") === true);
  r.check("a route's own sentence means gone", isNotFound("Progetto non trovato") === true && isNotFound("Pianificazione non trovata") === true);
  r.check("a 500 is a failure, not gone", isNotFound("HTTP 500") === false);
  r.check("a refusal is not gone", isNotFound("HTTP 403") === false);
  r.check("nothing is not gone", isNotFound(null) === false && isNotFound("") === false);
  r.check("a word that only contains it does not count", isNotFound("ritrovato") === false);

  return r.result();
}
