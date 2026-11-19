import { expect, test } from "./fixtures";

/**
 * Flow 5: a setting saved with the save bar.
 *
 * The public status page, in Impostazioni › Generale: switched on and given a
 * title, saved from the bar that appears with the first change, read back
 * after a reload — and the page itself answering at its address.
 */
test("flow 5: the save bar saves a setting, and it is still there after a reload", async ({ page, request }) => {
  const title = "Stato dei servizi della bottega";
  // Off to begin with, whatever another test left.
  expect((await request.put("/api/status-page", { data: { enabled: false } })).ok()).toBe(true);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Generale" })).toBeVisible();
  await page.getByRole("button", { name: /^Pagina di stato pubblica/ }).click();

  const publish = page.getByRole("switch", { name: /Pubblica la pagina/ });
  // The input is drawn by its label, as with any switch: the label is what a finger presses.
  const flip = () => page.getByText("Pubblica la pagina", { exact: true }).click();
  await expect(publish).not.toBeChecked();
  const bar = page.getByRole("region", { name: "Modifiche non salvate" });
  await expect(bar).toBeHidden();

  await flip();
  await expect(publish).toBeChecked();
  await page.getByRole("textbox", { name: "Titolo della pagina" }).fill(title);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("status")).toHaveText("Pagina di stato: modifiche non salvate");

  // "Annulla modifiche" puts back what was saved, and the bar goes away.
  await bar.getByRole("button", { name: /Annulla/ }).click();
  await expect(bar).toBeHidden();
  await expect(publish).not.toBeChecked();

  await flip();
  await page.getByRole("textbox", { name: "Titolo della pagina" }).fill(title);
  await bar.getByRole("button", { name: "Salva", exact: true }).click();
  await expect(page.getByText("Pagina di stato pubblicata")).toBeVisible();
  await expect(bar).toBeHidden();

  const slug = await page.getByRole("textbox", { name: "Percorso della pagina di stato" }).inputValue();
  expect(slug).toMatch(/^[a-z0-9-]+$/);

  await page.reload();
  await page.getByRole("button", { name: /^Pagina di stato pubblica/ }).click();
  await expect(page.getByRole("switch", { name: /Pubblica la pagina/ })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Titolo della pagina" })).toHaveValue(title);

  // Published: anyone with the link sees it, without signing in.
  const visitor = await page.context().browser()!.newContext();
  const outside = await visitor.newPage();
  await outside.goto(`${new URL(page.url()).origin}/status/${slug}`);
  await expect(outside.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await visitor.close();
});
