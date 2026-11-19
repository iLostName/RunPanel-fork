import { dockerAvailable, expect, makeZip, projectByName, test } from "./fixtures";

/**
 * Flows 2 and 3: a project from a ZIP, then a variable saved with
 * "Salva e ridistribuisci".
 *
 * Without Docker (or PM2) the deploy cannot run, so on such a machine the
 * tests stop where the panel takes over: the project exists, its deploy was
 * queued, and the page says why it did not go online. Where a Docker daemon
 * answers, as on CI's Ubuntu runner, they wait for the app to be online.
 *
 * Serial: the variable goes on the project the first test created.
 */
const NAME = "vetrina-bottega";
const APP_PORT = 5690;
const SITE = {
  // busybox's httpd: a few megabytes to pull, and a page that answers at once.
  Dockerfile: [
    "FROM busybox:1.37",
    "WORKDIR /www",
    "COPY index.html .",
    `EXPOSE ${APP_PORT}`,
    `CMD ["httpd", "-f", "-p", "${APP_PORT}", "-h", "/www"]`,
    "",
  ].join("\n"),
  "index.html": "<!doctype html><title>Vetrina della bottega</title><h1>Bottega Rossi</h1>\n",
};

const docker = dockerAvailable();

test.describe.serial("a project from a ZIP", () => {
  test.afterAll(async ({ request }) => {
    // Stops and removes its container too: a leftover would hold the port for the next run.
    const res = await request.get("/api/projects");
    const project = ((await res.json()) as { id: string; name: string }[]).find((p) => p.name === NAME);
    if (project) await request.delete(`/api/projects/${project.id}?services=delete`);
  });

  test("flow 2: the ZIP becomes a project and its first deploy is queued", async ({ page }) => {
    test.setTimeout(docker ? 360_000 : 60_000);

    await page.goto("/projects/new");
    await page.getByRole("radio", { name: /Da un archivio ZIP/ }).check();

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Scegli o trascina un archivio ZIP" }).click();
    await (await chooser).setFiles({ name: `${NAME}.zip`, mimeType: "application/zip", buffer: await makeZip(SITE) });
    await expect(page.getByText(`${NAME}.zip`)).toBeVisible();
    await page.getByRole("button", { name: "Continua" }).click();

    // What the panel read from the archive, before anything is created.
    await expect(page.getByRole("heading", { name: "Cosa abbiamo trovato" })).toBeVisible();
    await expect(page.getByText(`Dockerfile, che espone la porta ${APP_PORT}`)).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome" })).toHaveValue(NAME);

    await page.getByRole("button", { name: "Crea e metti online" }).click();
    await expect(page.getByRole("heading", { name: `Metto online «${NAME}»` })).toBeVisible();

    // The deploy was handed to the panel: it has an id and a page of its own.
    await expect(page.getByRole("heading", { name: "Primo deploy" })).toBeVisible();
    const project = await projectByName(page, NAME);
    expect(project, "the project is in the list").toBeTruthy();
    const detail = await (await page.request.get(`/api/projects/${project!.id}`)).json();
    expect(detail.deploy_count).toBe(1);

    if (docker) {
      await expect(page.getByText(`«${NAME}» è online`)).toBeVisible({ timeout: 300_000 });
    } else {
      // Docker is missing: the deploy stops, and the page says so in words, with the log under it.
      await expect(page.getByText("Il deploy non è riuscito")).toBeVisible();
      await expect(page.getByRole("log", { name: "Log del deploy" })).toContainText(/docker/i);
      await expect(page.getByRole("button", { name: "Riprova il deploy" })).toBeVisible();
    }
    await expect(page.getByRole("link", { name: "Vai al progetto" })).toBeVisible();
  });

  test("flow 3: a new variable is saved and redeployed from the save bar", async ({ page }) => {
    test.setTimeout(docker ? 360_000 : 60_000);
    const project = await projectByName(page, NAME);
    test.skip(!project, "needs the project of the previous test");
    const before = (await (await page.request.get(`/api/projects/${project!.id}`)).json()).deploy_count as number;

    await page.goto(`/projects/${project!.id}`);
    await page.getByRole("tab", { name: "Variabili" }).click();
    await expect(page.getByRole("heading", { name: "Variabili d'ambiente" })).toBeVisible();
    await page.getByRole("button", { name: "Aggiungi a mano" }).click();
    await page.getByRole("textbox", { name: "Nome della variabile" }).fill("NEGOZIO_CITTA");
    // Named after the variable once it has a name: "Valore di NEGOZIO_CITTA".
    await page.getByRole("textbox", { name: /^Valore di/ }).fill("Bologna");

    const bar = page.getByRole("region", { name: "Modifiche non salvate" });
    await expect(bar).toBeVisible();
    await bar.getByRole("button", { name: "Salva e ridistribuisci" }).click();

    await expect(page.getByText(/^1 variabile salvata(, deploy avviato|: il deploy partirà dopo quello in corso)$/)).toBeVisible();
    await expect(bar).toBeHidden();
    await expect.poll(async () => (await (await page.request.get(`/api/projects/${project!.id}`)).json()).deploy_count).toBe(before + 1);

    if (docker) {
      await expect
        .poll(async () => (await (await page.request.get(`/api/projects/${project!.id}`)).json()).last_deployment?.status, {
          timeout: 300_000,
        })
        .toBe("running");
    }

    // Saved for real: a reload reads it back from the panel.
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Nome della variabile" })).toHaveValue("NEGOZIO_CITTA");
  });
});
