import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { AUTH_FILE, OWNER } from "./paths";
import { SETUP_TOKEN } from "./server";

/**
 * Flow 1: the first setup, with the token the panel prints at boot.
 *
 * Runs before every other test (the `setup` project), on the panel the global
 * setup has just started, and keeps the owner's cookie for them.
 */
test("the first run asks for the setup token, then creates the owner", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Crea l'account proprietario del pannello")).toBeVisible();

  await page.getByRole("textbox", { name: "Token di setup" }).fill("non-e-il-token");
  await page.getByRole("textbox", { name: "Email" }).fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByRole("textbox", { name: "Conferma password" }).fill(OWNER.password);
  await page.getByRole("button", { name: "Configura il pannello" }).click();

  // A wrong token is refused where it was typed, and nothing is created.
  await expect(page.getByRole("alert").filter({ hasText: /token/i })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole("textbox", { name: "Token di setup" }).fill(SETUP_TOKEN);
  await page.getByRole("button", { name: "Configura il pannello" }).click();

  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { level: 1, name: "Panoramica" })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`account ${OWNER.email}`) })).toBeVisible();

  // The setup screen is gone for good: the next visitor is asked to sign in.
  const check = await page.request.get("/api/auth/check");
  expect(await check.json()).toMatchObject({ authenticated: true, firstRun: false });

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
