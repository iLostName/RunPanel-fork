import { expect, test } from "./fixtures";

/**
 * Flow 4: a backup run now, to the default destination — the disk of this
 * server, which every panel starts with — followed to its end.
 *
 * The one-click nightly schedule is what a new panel offers first, and its
 * "Esegui ora" is the immediate backup: the run's page then follows it live.
 */
test("flow 4: Esegui ora saves an archive on the local disk and the run completes", async ({ page }) => {
  await page.goto("/backups");
  await expect(page.getByRole("heading", { level: 1, name: "Backup" })).toBeVisible();

  const destinations = page.getByRole("listitem").filter({ hasText: "Disco locale" });
  await expect(destinations.getByText("Predefinita")).toBeVisible();

  await page.getByRole("button", { name: "Crea il backup notturno" }).click();
  await expect(page.getByText("Pianificazione creata: ogni giorno alle 03:00")).toBeVisible();

  await page.getByRole("button", { name: "Esegui ora Backup notturno" }).click();
  await expect(page).toHaveURL(/\/backups\/runs\/[\w-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Backup notturno" })).toBeVisible();

  // Followed live until it settles: an archive, nothing failed, on this server's disk.
  const main = page.getByRole("main");
  await expect(main.getByText("Riuscito", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(main.getByText(/\d+ ok, 0 falliti/)).toBeVisible();
  await expect(main.getByText("sul disco di questo server")).toBeVisible();
  await expect(main.getByRole("link", { name: "Scarica" })).toBeVisible();

  // And the history on the list has it.
  await main.getByRole("link", { name: "Tutti i backup" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Cronologia" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Backup notturno/ }).last()).toBeVisible();
  await expect(page.getByText("Nessun backup eseguito")).toBeHidden();
});
