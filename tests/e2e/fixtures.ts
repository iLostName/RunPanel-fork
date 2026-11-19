import { execFileSync } from "node:child_process";
import { test as base, expect, type Page } from "@playwright/test";
import yazl from "yazl";

export { expect };

/**
 * `test` with the browser's complaints collected: every console error and
 * every uncaught exception of the page, in the order they happened. A test
 * that cares asserts on `consoleErrors`; the others get them attached to the
 * report when they fail, which is where they explain the most.
 */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${message.text()} (${message.location().url || page.url()})`);
      });
      page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));
      await use(errors);
      if (testInfo.status !== testInfo.expectedStatus && errors.length > 0) {
        await testInfo.attach("console-errors", { body: errors.join("\n"), contentType: "text/plain" });
      }
    },
    { auto: true },
  ],
});

/**
 * Whether this machine can run a deploy for real: a Docker daemon that
 * answers, as on CI's Ubuntu runner. The same question the panel asks.
 */
export function dockerAvailable(): boolean {
  try {
    return execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 20_000 }).trim().length > 0;
  } catch {
    return false;
  }
}

/** A ZIP made in memory, the way a user would pick one from disk. */
export function makeZip(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text), name);
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

/** The project the API knows by this name, once it exists. */
export async function projectByName(page: Page, name: string): Promise<{ id: string; slug: string; status: string } | undefined> {
  const res = await page.request.get("/api/projects");
  expect(res.ok()).toBe(true);
  const projects = (await res.json()) as { id: string; slug: string; name: string; status: string }[];
  return projects.find((project) => project.name === name);
}
