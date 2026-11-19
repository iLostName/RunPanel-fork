import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * axe on the main pages, in the light and the dark palette: a serious or
 * critical violation fails the test, with the rule, the elements and how to
 * fix it in the message. Moderate and minor ones are left to review.
 *
 * Motion is reduced so that nothing is caught half-faded: a colour measured in
 * the middle of an entrance animation is not the colour the page has.
 */
type Palette = "light" | "dark";

const PAGES: { name: string; path: (ids: { project: string; status: string }) => string; title: string }[] = [
  { name: "Panoramica", path: () => "/home", title: "Panoramica" },
  { name: "Progetti", path: () => "/projects", title: "Progetti" },
  { name: "Progetto", path: ({ project }) => `/projects/${project}`, title: "listino-prezzi" },
  { name: "Backup", path: () => "/backups", title: "Backup" },
  { name: "Impostazioni", path: () => "/settings", title: "Generale" },
  { name: "Pagina di stato", path: ({ status }) => `/status/${status}`, title: "Stato dei servizi" },
];

const ids = { project: "", status: "stato-e2e-a11y" };

test.beforeAll(async ({ request }) => {
  const projects = (await (await request.get("/api/projects")).json()) as { id: string; name: string }[];
  const existing = projects.find((project) => project.name === "listino-prezzi");
  if (existing) {
    ids.project = existing.id;
  } else {
    const created = await request.post("/api/projects", { data: { name: "listino-prezzi" } });
    expect(created.ok()).toBe(true);
    ids.project = ((await created.json()) as { id: string }).id;
  }

  // Published for these tests only, so that the public page exists.
  const res = await request.put("/api/status-page", {
    data: { enabled: true, slug: ids.status, title: "Stato dei servizi", message: "Tutto sotto controllo.", allowIndexing: false, projects: [] },
  });
  expect(res.ok(), await res.text()).toBe(true);
});

// An empty project has no code to save: left behind, it would turn the next nightly backup partial.
test.afterAll(async ({ request }) => {
  await request.put("/api/status-page", { data: { enabled: false } });
  if (ids.project) await request.delete(`/api/projects/${ids.project}`);
});

async function open(page: Page, origin: string, palette: Palette, path: string, title: string) {
  // The palette is a cookie, so the server draws the page in it from the first byte.
  await page.context().addCookies([{ name: "runpanel_theme", value: palette, url: origin }]);
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: palette });
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-theme", palette);
  await expect(page.getByRole("heading", { level: 1, name: title }).first()).toBeVisible();
  await expect(page.locator(".skeleton")).toHaveCount(0);
}

function report(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"]): string {
  return violations
    .map((violation) => {
      const nodes = violation.nodes
        .slice(0, 5)
        .map((node) => `    ${node.target.join(" ")}\n      ${node.failureSummary?.split("\n").join("\n      ")}`)
        .join("\n");
      return `[${violation.impact}] ${violation.id}: ${violation.help}\n  ${violation.helpUrl}\n${nodes}`;
    })
    .join("\n\n");
}

for (const palette of ["light", "dark"] as const) {
  test.describe(`${palette} palette`, () => {
    for (const target of PAGES) {
      test(`${target.name} has no serious or critical axe violations`, async ({ page, baseURL }) => {
        await open(page, baseURL!, palette, target.path(ids), target.title);
        const results = await new AxeBuilder({ page }).analyze();
        const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
        expect(blocking, report(blocking)).toEqual([]);
      });
    }
  });
}
