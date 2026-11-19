import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The panel on a phone, 375×812 with touch (the `phone` project): the tab bar
 * along the bottom, "Altro" for the rest, and a dialog drawn as a sheet along
 * the bottom edge instead of a card in the middle.
 */

/** Where an element sits once its entrance animation is over, rounded to the pixel. */
async function settledBox(locator: Locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom) };
  });
}

test("the tab bar leads to the four main pages and Altro to the rest", async ({ page }) => {
  await page.goto("/home");
  const tabs = page.getByRole("navigation", { name: "Navigazione principale" });
  await expect(tabs).toBeVisible();
  // The rail of a desktop is not drawn on a phone.
  await expect(page.getByRole("complementary")).toBeHidden();

  for (const name of ["Panoramica", "Progetti", "Database", "Backup"]) {
    await expect(tabs.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(tabs.getByRole("link", { name: "Panoramica" })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("link", { name: "Progetti", exact: true }).tap();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { level: 1, name: "Progetti" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Progetti", exact: true })).toHaveAttribute("aria-current", "page");

  // The bar stays clear of the page: it is pinned to the bottom edge.
  const bar = await settledBox(tabs);
  expect(bar).toEqual({ left: 0, right: 375, bottom: 812 });

  await tabs.getByRole("button", { name: /^Altro/ }).tap();
  const more = page.getByRole("dialog", { name: "Altro" });
  await expect(more).toBeVisible();
  await expect(more.getByRole("link", { name: "Domini" })).toBeVisible();
  await expect(more.getByRole("link", { name: "Impostazioni" })).toBeVisible();

  await more.getByRole("link", { name: "Domini" }).tap();
  await expect(page).toHaveURL(/\/domains$/);
  await expect(more).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Domini" })).toBeVisible();
});

test("a dialog opens as a sheet along the bottom edge", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByRole("heading", { level: 1, name: "Progetti" })).toBeVisible();

  await page.getByRole("button", { name: "Nuova cartella" }).tap();
  const dialog = page.getByRole("dialog", { name: "Nuova cartella" });
  await expect(dialog).toBeVisible();

  // Full width and resting on the bottom edge, once it has slid up.
  await expect.poll(() => settledBox(dialog)).toEqual({ left: 0, right: 375, bottom: 812 });
  const top = await dialog.evaluate((element) => element.getBoundingClientRect().top);
  expect(top, "a strip of the page stays visible above the sheet").toBeGreaterThan(0);

  await dialog.getByRole("button", { name: "Annulla" }).tap();
  await expect(dialog).toBeHidden();
});
