import { createReporter } from "../harness.mjs";
import { loadTs } from "../ts-modules.mjs";

/**
 * The folders of the Projects page: a colour per folder, a bar of what its
 * projects are doing, and the folder named by the address.
 *
 * Each rule is one a component gets subtly wrong. A colour that is not a pure
 * function of the name changes between two visits; a bar grouped by colour
 * merges "Errore" with "Non raggiungibile"; a selection that does not keep the
 * other parameters drops `?server=` and widens a list narrowed to one server;
 * and a drop payload trusted as it came would let any dragged text move a
 * project.
 *
 * Standalone: lib/project-folders.ts imports only lib/status.ts.
 */
export const meta = { name: "project-folders-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("project-folders-unit");
  const {
    folderHue,
    statusBreakdown,
    breakdownText,
    projectCountLabel,
    parseFolderParam,
    selectionKey,
    folderSelectionHref,
    inSelection,
    encodeProjectDrag,
    parseProjectDrag,
    FOLDER_PARAM,
    NO_FOLDER,
  } = await loadTs(repoRoot, "lib", "project-folders.ts");

  // --- the colour of a folder ------------------------------------------------------
  r.check("a name always has the same hue", folderHue("Clienti") === folderHue("Clienti") && folderHue("Interni") === folderHue("Interni"));
  r.check("case and outer spaces do not change it, as they do not make a name unique",
    folderHue("Clienti") === folderHue("  clienti ") && folderHue("ÀRCHIVIO") === folderHue("àrchivio"));
  const sample = ["Clienti", "Interni", "Produzione", "Staging", "Test", "", "🚀 Lanci", "a".repeat(60)];
  r.check("a hue is a whole degree from 0 to 359, whatever the name",
    sample.every((name) => Number.isInteger(folderHue(name)) && folderHue(name) >= 0 && folderHue(name) < 360),
    JSON.stringify(sample.map((name) => folderHue(name))));
  const numbered = Array.from({ length: 9 }, (_, i) => folderHue(`Clienti ${i + 1}`));
  const sectors = new Set(numbered.map((hue) => Math.floor(hue / 30)));
  r.check("names that differ only in their last letter are spread around the wheel, not a few degrees apart",
    sectors.size >= 5, JSON.stringify(numbered));
  r.check("two different names usually differ", folderHue("Clienti") !== folderHue("Interni"));

  // --- what a folder's projects are doing ----------------------------------------------
  const rows = [
    { status: "stopped" },
    { status: "running" },
    { status: "error" },
    { status: "running" },
    { status: "deploying" },
    { status: "unreachable" },
    { status: "boh" },
    { status: "chissà" },
    { status: "running" },
  ];
  const slices = statusBreakdown(rows);
  r.check("healthy first, then busy, broken and off", slices.map((s) => s.tone).join(",") === "success,warning,danger,danger,neutral,neutral",
    JSON.stringify(slices));
  r.check("each slice is counted", slices[0].label === "In esecuzione" && slices[0].count === 3 && slices[1].label === "Deploy in corso" && slices[1].count === 1,
    JSON.stringify(slices));
  r.check("an error and a server that did not answer are two slices, though both are red",
    slices.some((s) => s.label === "Errore" && s.count === 1) && slices.some((s) => s.label === "Non raggiungibile" && s.count === 1),
    JSON.stringify(slices));
  r.check("statuses nothing knows are one slice, not several with the same name",
    slices.filter((s) => s.label === "Sconosciuto").length === 1 && slices.find((s) => s.label === "Sconosciuto").count === 2,
    JSON.stringify(slices));
  r.check("within a tone, the larger slice comes first, then by name",
    slices.map((s) => s.label).join(",") === "In esecuzione,Deploy in corso,Errore,Non raggiungibile,Sconosciuto,Fermo",
    slices.map((s) => s.label).join(","));
  r.check("every project is in exactly one slice", slices.reduce((n, s) => n + s.count, 0) === rows.length);
  r.check("an empty folder has no slices", statusBreakdown([]).length === 0);
  r.check("the breakdown reads in words", breakdownText(statusBreakdown([{ status: "running" }, { status: "running" }, { status: "error" }])) === "In esecuzione: 2, Errore: 1",
    breakdownText(statusBreakdown([{ status: "running" }, { status: "running" }, { status: "error" }])));
  r.check("counts are worded, and an empty folder says so",
    projectCountLabel(0) === "Nessun progetto" && projectCountLabel(1) === "1 progetto" && projectCountLabel(12) === "12 progetti");

  // --- the folder in the address -------------------------------------------------------
  r.check("no parameter, or an empty one, is every project",
    parseFolderParam(null).kind === "all" && parseFolderParam(undefined).kind === "all" && parseFolderParam("").kind === "all" && parseFolderParam("   ").kind === "all");
  r.check(`"${NO_FOLDER}" is the projects in no folder`, parseFolderParam(NO_FOLDER).kind === "none");
  const picked = parseFolderParam(" Abc_123-xyz ");
  r.check("anything else is a folder id, trimmed", picked.kind === "folder" && picked.id === "Abc_123-xyz", JSON.stringify(picked));
  const gone = parseFolderParam("nonEsistePiu");
  r.check("an id the list may not have is still a folder, so the page can say it no longer exists", gone.kind === "folder" && gone.id === "nonEsistePiu");
  r.check("a value too long to be an id is ignored", parseFolderParam("x".repeat(65)).kind === "all");
  r.check("each selection has its own key",
    new Set([selectionKey({ kind: "all" }), selectionKey({ kind: "none" }), selectionKey({ kind: "folder", id: "all" }), selectionKey({ kind: "folder", id: "none" })]).size === 4);

  r.check("choosing a folder keeps the server the list is narrowed to",
    folderSelectionHref("/projects", "?server=node-b", { kind: "folder", id: "f1" }) === `/projects?server=node-b&${FOLDER_PARAM}=f1`,
    folderSelectionHref("/projects", "?server=node-b", { kind: "folder", id: "f1" }));
  r.check("every project drops the parameter instead of writing an empty one",
    folderSelectionHref("/projects", `?${FOLDER_PARAM}=f1&server=node-b`, { kind: "all" }) === "/projects?server=node-b"
    && folderSelectionHref("/projects", `${FOLDER_PARAM}=f1`, { kind: "all" }) === "/projects",
    folderSelectionHref("/projects", `?${FOLDER_PARAM}=f1&server=node-b`, { kind: "all" }));
  r.check("another folder replaces the one in the address", folderSelectionHref("/projects", `?${FOLDER_PARAM}=f1`, { kind: "none" }) === `/projects?${FOLDER_PARAM}=${NO_FOLDER}`);
  r.check("an id is written escaped", folderSelectionHref("/projects", "", { kind: "folder", id: "a b&c" }) === `/projects?${FOLDER_PARAM}=a+b%26c`,
    folderSelectionHref("/projects", "", { kind: "folder", id: "a b&c" }));
  const back = parseFolderParam(new URLSearchParams(folderSelectionHref("/projects", "", { kind: "folder", id: "f-9" }).split("?")[1]).get(FOLDER_PARAM));
  r.check("what is written reads back as the same selection", back.kind === "folder" && back.id === "f-9");

  // --- which projects a selection shows --------------------------------------------------
  const known = new Set(["f1", "f2"]);
  r.check("every project, whatever its folder", inSelection("f1", { kind: "all" }, known) && inSelection(null, { kind: "all" }, known) && inSelection("gone", { kind: "all" }, known));
  r.check("a folder shows only what is filed in it", inSelection("f1", { kind: "folder", id: "f1" }, known) && !inSelection("f2", { kind: "folder", id: "f1" }, known) && !inSelection(null, { kind: "folder", id: "f1" }, known));
  r.check("no folder shows what is filed nowhere", inSelection(null, { kind: "none" }, known) && !inSelection("f1", { kind: "none" }, known));
  r.check("a folder that went between two polls counts as no folder, as on the Overview", inSelection("gone", { kind: "none" }, known));
  r.check("while the folders load, only a missing folder is called unfiled", inSelection(null, { kind: "none" }, null) && !inSelection("gone", { kind: "none" }, null));

  // --- a dragged row ------------------------------------------------------------------------
  const drag = { memberId: "node-a", id: "p1", folderId: null };
  const round = parseProjectDrag(encodeProjectDrag(drag));
  r.check("a dragged project reads back as it was written", JSON.stringify(round) === JSON.stringify(drag), JSON.stringify(round));
  r.check("its folder survives the trip", parseProjectDrag(encodeProjectDrag({ ...drag, folderId: "f1" }))?.folderId === "f1");
  r.check("only what a move needs is carried", Object.keys(parseProjectDrag(JSON.stringify({ ...drag, name: "x", extra: 1 }))).join(",") === "memberId,id,folderId");
  r.check("nothing dropped, nothing read", parseProjectDrag(null) === null && parseProjectDrag("") === null);
  r.check("text that is not JSON is not a project", parseProjectDrag("https://example.com/projects/p1") === null && parseProjectDrag("{") === null);
  r.check("JSON without a project id is not a project",
    parseProjectDrag(JSON.stringify({ memberId: "a", folderId: null })) === null && parseProjectDrag(JSON.stringify({ memberId: "a", id: "", folderId: null })) === null
    && parseProjectDrag("null") === null && parseProjectDrag("[1]") === null);
  r.check("a folder that is neither an id nor null is refused, so a drop never moves a project somewhere unintended",
    parseProjectDrag(JSON.stringify({ memberId: "a", id: "p1" })) === null && parseProjectDrag(JSON.stringify({ memberId: "a", id: "p1", folderId: 3 })) === null);
  r.check("the server is part of it: two servers can hold the same id", parseProjectDrag(JSON.stringify({ id: "p1", folderId: null })) === null);

  return r.result();
}
