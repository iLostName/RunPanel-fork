import { defineConfig, devices } from "@playwright/test";
import { AUTH_FILE } from "./paths";

/**
 * The browser tests: `bun run test:e2e`, after `bun run build`.
 *
 * One production panel for the whole run, started by `global-setup.ts` on a
 * data directory of its own. The `setup` project claims it through the
 * first-run screen and keeps the owner's cookie; every other test starts from
 * that cookie in a fresh browser context.
 *
 * One worker: the tests share one panel, and a backup started by one while
 * another saves a setting would make a red result mean nothing.
 *
 * Locally the installed Chrome is used, so nothing has to be downloaded; CI
 * installs Playwright's Chromium (`bunx playwright install --with-deps
 * chromium`) and sets `CI`, which selects it. `PLAYWRIGHT_CHANNEL` overrides
 * either: `msedge`, say, or `chromium`.
 */
const channel = process.env.PLAYWRIGHT_CHANNEL ?? (process.env.CI ? undefined : "chrome");
const browser = { ...devices["Desktop Chrome"], ...(channel && channel !== "chromium" ? { channel } : {}) };

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    // Set by the global setup, which picks a free port from 5600.
    baseURL: process.env.RUNPANEL_E2E_BASE_URL,
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /first-run\.setup\.ts/,
      use: { ...browser, viewport: { width: 1280, height: 860 } },
    },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /phone\.spec\.ts/,
      use: { ...browser, viewport: { width: 1440, height: 900 }, storageState: AUTH_FILE },
    },
    {
      name: "phone",
      dependencies: ["setup"],
      testMatch: /phone\.spec\.ts/,
      use: {
        ...browser,
        userAgent: devices["Pixel 7"].userAgent,
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        storageState: AUTH_FILE,
      },
    },
  ],
});
