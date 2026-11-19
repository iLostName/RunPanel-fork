import { expect, test } from "./fixtures";

/**
 * The main sections, one click of the sidebar after the other: each page shows
 * one placeholder at most, and the browser logs no error on the way.
 *
 * The routes have no `loading.tsx` on purpose (components/ui/Skeletons.tsx):
 * a route-level placeholder followed by the page's own was two different grey
 * pages in a row. That is what this walk would catch if one came back.
 *
 * A page placeholder is a set of skeleton blocks drawn while the page has no
 * control of its own yet: the route's fallback, or the page waiting for its
 * first answer. A card that waits for its own data inside a page already drawn
 * is the page loading progressively, not a second page, and is not counted.
 * The section tabs of a layout (a `nav`) stay on screen across both, so they
 * do not count as the page's own.
 */
function recordPlaceholders() {
  const CONTROLS = "a[href], button, input, select, textarea, [role='tab'], [role='switch'], [role='radio'], [role='checkbox']";
  const pages: { path: string; blocks: number }[] = [];
  let shown = new Set<Element>();
  const scan = () => {
    const main = document.getElementById("main");
    const blocks = new Set(main ? Array.from(main.querySelectorAll(".skeleton")) : []);
    const fresh = blocks.size > 0 && !Array.from(blocks).some((block) => shown.has(block));
    if (fresh && main) {
      const controls = Array.from(main.querySelectorAll(CONTROLS)).filter((control) => !control.closest("nav"));
      if (controls.length === 0) pages.push({ path: location.pathname, blocks: blocks.size });
    }
    shown = blocks;
  };
  new MutationObserver(scan).observe(document, { childList: true, subtree: true });
  (window as unknown as { __pagePlaceholders: typeof pages }).__pagePlaceholders = pages;
}

const SECTIONS = [
  { link: "Progetti", url: /\/projects$/, title: "Progetti" },
  { link: "Database", url: /\/services$/, title: "Database" },
  { link: "Variabili condivise", url: /\/shared-variables$/, title: "Variabili condivise" },
  { link: "Domini", url: /\/domains$/, title: "Domini" },
  { link: "Backup", url: /\/backups$/, title: "Backup" },
  { link: "Salute", url: /\/monitor$/, title: "Monitor" },
  { link: "Team", url: /\/users$/, title: "Utenti" },
  { link: "Impostazioni", url: /\/settings$/, title: "Generale" },
  { link: "Panoramica", url: /\/home$/, title: "Panoramica" },
];

// A project to open, so the walk ends on a page with an id in its address.
const project = { id: "" };

test.beforeAll(async ({ request }) => {
  const created = await request.post("/api/projects", { data: { name: "gestionale-magazzino" } });
  expect(created.ok()).toBe(true);
  project.id = ((await created.json()) as { id: string }).id;
});

// An empty project has no code to save: left behind, it would turn the next nightly backup partial.
test.afterAll(async ({ request }) => {
  if (project.id) await request.delete(`/api/projects/${project.id}`);
});

test("the main sections show one placeholder at most and log no errors", async ({ page, consoleErrors }) => {
  await page.addInitScript(recordPlaceholders);
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Panoramica" })).toBeVisible();

  const placeholdersOf = async () =>
    page.evaluate(() => (window as unknown as { __pagePlaceholders: { path: string; blocks: number }[] }).__pagePlaceholders.splice(0));

  const settle = async (title: string) => {
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.locator("#main .skeleton")).toHaveCount(0);
  };

  await settle("Panoramica");
  await placeholdersOf();

  const sidebar = page.getByRole("complementary");
  for (const section of SECTIONS) {
    await sidebar.getByRole("link", { name: section.link, exact: true }).click();
    await expect(page).toHaveURL(section.url);
    await settle(section.title);
    const shown = await placeholdersOf();
    expect(shown.length, `${section.link}: ${JSON.stringify(shown)}`).toBeLessThanOrEqual(1);
  }

  // A project's page, from its row in the list.
  await sidebar.getByRole("link", { name: "Progetti", exact: true }).click();
  await settle("Progetti");
  await placeholdersOf();
  await page.getByRole("link", { name: /gestionale-magazzino/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}`));
  await settle("gestionale-magazzino");
  const shown = await placeholdersOf();
  expect(shown.length, `project page: ${JSON.stringify(shown)}`).toBeLessThanOrEqual(1);

  expect(consoleErrors, "console errors while navigating").toEqual([]);
});
