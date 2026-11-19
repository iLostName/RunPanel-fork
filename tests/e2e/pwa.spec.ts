import { expect, test } from "./fixtures";

/**
 * The installable app: the manifest every page links, and the service worker,
 * which a browser registers only on a secure origin — `localhost` is one over
 * plain http, which is why the run's address uses it.
 */
test("the manifest is linked and the service worker takes control on localhost", async ({ page }) => {
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1, name: "Panoramica" })).toBeVisible();

  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBeTruthy();
  const res = await page.request.get(new URL(href!, page.url()).href);
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: "RunPanel", display: "standalone" });
  expect(manifest.start_url).toBeTruthy();
  const sizes = (manifest.icons as { sizes: string }[]).map((icon) => icon.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));

  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.active ? { state: registration.active.state, script: new URL(registration.active.scriptURL).pathname, scope: new URL(registration.scope).pathname } : null;
      })
    )
    .toEqual({ state: "activated", script: "/sw.js", scope: "/" });
});
