/**
 * The README's screenshots, taken from the real panel.
 *
 *   bun run build
 *   node scripts/readme-screenshots.mjs [--out .github/assets] [--keep]
 *
 * A production panel on a data directory of its own (tests/e2e/server.ts), a
 * demo studio seeded into it, and Playwright photographing it in the light and
 * the dark palette, on a desktop and on a phone. The pictures are WebP, written
 * to `.github/assets`, which the READMEs point at. `--keep` leaves the panel
 * running afterwards and prints its address and password, to look around.
 *
 * Everything shown is made up: an imaginary web studio, its clients' sites,
 * example keys from the providers' own documentation. Nothing here reads the
 * machine it runs on into a picture:
 *
 *  - What the API can create is created through the API: the owner, folders,
 *    projects with their source and runtime, variables, backup destinations,
 *    schedules, and backups that really run (to the local disk).
 *  - What only a running app produces — a status of "In esecuzione", a deploy
 *    history, CPU and memory over the last hour, a month of uptime — is written
 *    into the store, as the panel itself would have written it.
 *  - What the panel reads from the host — CPU, memory, disk, the host name,
 *    whether Docker and PM2 answer — is described rather than measured: those
 *    few answers are replaced in the browser with the ones of a healthy small
 *    VPS, so the pictures neither show this computer nor depend on it.
 *
 * Uses the installed Chrome, like the e2e tests; PLAYWRIGHT_CHANNEL=chromium
 * for Playwright's own. `sharp` comes with Next (see scripts/build-pwa-assets.mjs).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel, SETUP_TOKEN } from "../tests/e2e/server.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { chromium, request: playwrightRequest } = require("@playwright/test");
const Database = require("better-sqlite3");

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("sharp is not installed: it comes with Next as an optional dependency (bun install).");
  process.exit(1);
}

const args = process.argv.slice(2);
const OUT = resolve(ROOT, args.includes("--out") ? args[args.indexOf("--out") + 1] : ".github/assets");
const KEEP = args.includes("--keep");
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";

const OWNER = { email: "giulia.rossi@studio-esempio.it", password: "demo-Password-2026" };
const ORG = "https://github.com/studio-esempio";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// --- the demo studio -----------------------------------------------------------

const FOLDERS = ["Clienti", "Siti vetrina", "Strumenti interni"];

/** `ago`: when the live deploy finished. `history`: the deploys before it, newest first. */
const PROJECTS = [
  {
    name: "osteria-da-mario", folder: "Clienti", runtime: "node", port: 3001, status: "running", ago: 2 * HOUR,
    message: "Menu del giorno modificabile dal pannello del ristorante",
    history: ["Prenotazioni: conferma via email al cliente", "Aggiornate le dipendenze", "Nuova galleria fotografica"],
    env: {
      NEXT_PUBLIC_SITE_URL: "https://osteriadamario.example",
      DATABASE_URL: "postgresql://osteria:password-di-esempio@localhost:5432/osteria",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "prenotazioni@osteriadamario.example",
      SMTP_PASSWORD: "password-di-esempio",
      PRENOTAZIONI_MAX_PERSONE: "12",
    },
  },
  {
    name: "agenzia-viaggi-sole", folder: "Clienti", runtime: "docker", port: 3002, status: "running", ago: 26 * HOUR,
    message: "Offerte estate 2027 e filtro per partenza",
    history: ["Corretto il calcolo del prezzo per i bambini", "Dockerfile su Node 24"],
  },
  {
    name: "studio-legale-bianchi", folder: "Clienti", runtime: "static", port: 3003, status: "running", ago: 3 * DAY,
    message: "Pagina dello staff aggiornata",
    history: ["Informativa privacy 2026"],
  },
  {
    name: "panificio-rossi", folder: "Siti vetrina", runtime: "static", port: 3004, status: "running", ago: 5 * DAY,
    message: "Orari delle festività",
    history: ["Nuove foto dei prodotti", "Mappa del negozio"],
  },
  {
    name: "portfolio-giulia", folder: "Siti vetrina", runtime: "static", port: 3005, status: "stopped", ago: 12 * DAY,
    message: "Progetti del 2026",
    history: [],
  },
  {
    name: "gestionale-magazzino", folder: "Strumenti interni", runtime: "node", port: 3006, status: "running", ago: 40 * MINUTE,
    message: "Esportazione dell'inventario in CSV",
    history: ["Scorte minime per fornitore", "Corretta la ricerca per codice a barre", "Login con GitHub per lo staff"],
  },
  {
    name: "api-prenotazioni", folder: "Strumenti interni", runtime: "docker", port: 3007, status: "running", ago: 15 * MINUTE,
    message: "Limite di prenotazioni per fascia oraria",
    // A deploy that failed and the one after it that fixed it: what a history looks like.
    history: [
      { message: "Limite di prenotazioni per fascia oraria (prima prova)", failed: "L'app non risponde sulla porta 3007 dopo 60 secondi" },
      "Endpoint per i tavoli liberi",
    ],
  },
  {
    name: "blog-cucina-toscana", folder: null, runtime: "node", port: 3008, status: "running", ago: 9 * HOUR,
    message: "Ricetta della ribollita, con la stampa in PDF",
    history: ["Ricerca per ingrediente", "Commenti moderati"],
  },
];

const FEATURED = "osteria-da-mario";

// --- seeding through the API ---------------------------------------------------

async function call(api, method, path, data) {
  const res = await api.fetch(path, { method, data });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function seedThroughApi(api) {
  await call(api, "POST", "/api/auth/login", { setup: true, email: OWNER.email, password: OWNER.password, setupToken: SETUP_TOKEN });

  const folders = {};
  for (const name of FOLDERS) folders[name] = (await call(api, "POST", "/api/folders", { name })).id;

  const ids = {};
  // Oldest first, so the list (newest first) reads in the order above.
  for (const project of [...PROJECTS].reverse()) {
    const created = await call(api, "POST", "/api/projects", { name: project.name });
    ids[project.name] = created.id;
    await call(api, "PATCH", `/api/projects/${created.id}`, {
      sourceType: "github",
      sourceUrl: `${ORG}/${project.name}`,
      sourceBranch: "main",
      runtimeType: project.runtime,
      port: project.port,
      folderId: project.folder ? folders[project.folder] : null,
    });
    if (project.env) {
      await call(api, "PUT", `/api/projects/${created.id}/env`, {
        vars: Object.entries(project.env).map(([key, value]) => ({ key, value })),
      });
    }
  }

  // Where the archives go: this server's disk (there from the start), a bucket,
  // a Nextcloud over WebDAV. The keys are AWS's own documentation examples.
  const destinations = (await call(api, "GET", "/api/backups/destinations")).destinations ?? [];
  const local = destinations.find((d) => d.type === "local")?.id;
  const s3 = await call(api, "POST", "/api/backups/destinations", {
    name: "Bucket S3 · Milano",
    type: "s3",
    config: {
      endpoint: "https://s3.eu-south-1.amazonaws.com",
      region: "eu-south-1",
      bucket: "backup-studio-esempio",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      prefix: "runpanel",
    },
  });
  const webdav = await call(api, "POST", "/api/backups/destinations", {
    name: "Nextcloud dello studio",
    type: "webdav",
    config: {
      url: "https://cloud.studio-esempio.example/remote.php/dav/files/backup",
      username: "backup",
      password: "password-di-esempio",
      folder: "runpanel",
    },
  });

  const allOf = [
    { kind: "all-services" },
    { kind: "panel" },
    { kind: "all-projects", include: ["config", "volumes"] },
  ];
  const nightly = await call(api, "POST", "/api/backups/policies", {
    name: "Notturno",
    cron: "0 3 * * *",
    destinationId: local,
    targets: allOf,
    retentionCount: 7,
  });
  await call(api, "POST", "/api/backups/policies", {
    name: "Copia fuori sede",
    cron: "30 3 * * 0",
    destinations: [{ destinationId: s3.id }, { destinationId: webdav.id }],
    targets: allOf,
    retentionCount: 8,
  });

  // Real runs, to the local disk: the history shows archives that exist.
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { runId } = await call(api, "POST", `/api/backups/policies/${nightly.id}/run`, {});
    runs.push(runId);
    for (let tries = 0; tries < 100; tries++) {
      const run = await call(api, "GET", `/api/backups/runs/${runId}`);
      if ((run.run ?? run).status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // A colleague who looks after the clients' sites: everything in their
  // folder, the warehouse tool to restart, and nothing of the server.
  const invited = await call(api, "POST", "/api/users", { email: "marco.bianchi@studio-esempio.it", hours: 72 });
  const user = invited.user.id;
  await call(api, "PATCH", `/api/users/${user}`, {
    access: {
      permissions: ["projects.create", "monitor", "backup"],
      grants: [
        { scope: "folder", scopeId: folders["Clienti"], level: "manage", terminal: true },
        { scope: "folder", scopeId: folders["Siti vetrina"], level: "operate", terminal: false },
        { scope: "project", scopeId: ids["gestionale-magazzino"], level: "read", terminal: false },
      ],
    },
  });

  // The runs announced themselves in the bell: read, like on a panel someone uses.
  await call(api, "POST", "/api/notifications/read", { all: true });

  return { ids, runs, nightly: nightly.id, user };
}

// --- seeding the store ---------------------------------------------------------

function seedStore(dataDir, { ids, runs }) {
  const db = new Database(join(dataDir, "runpanel.db"));
  db.pragma("busy_timeout = 5000");

  const sha = (seed) => {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return (h.toString(16).padStart(8, "0") + (h * 7919 >>> 0).toString(16).padStart(8, "0")).repeat(3).slice(0, 40);
  };

  const insertDeploy = db.prepare(`
    INSERT INTO deployments (id, project_id, trigger_type, commit_sha, commit_message, status, started_at, finished_at, error_message, start_cmd, artifact_dir, resolved_contract)
    VALUES (@id, @project_id, @trigger_type, @commit_sha, @commit_message, @status, @started_at, @finished_at, @error_message, NULL, NULL, NULL)
  `);
  const setStatus = db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?");

  let n = 0;
  const deployId = () => `demo${String(++n).padStart(8, "0")}`;
  for (const project of PROJECTS) {
    const id = ids[project.name];
    const finished = now - project.ago;
    // Oldest first, so the ids grow with time like the panel's own.
    [...project.history].reverse().forEach((entry, i, older) => {
      const { message, failed = null } = typeof entry === "string" ? { message: entry } : entry;
      // The newest of the history is a few hours before the live one when it failed, days otherwise.
      const at = finished - (older.length - i) * (failed ? 0.12 : 2.7) * DAY;
      insertDeploy.run({
        id: deployId(),
        project_id: id,
        trigger_type: "webhook",
        commit_sha: sha(project.name + message),
        commit_message: message,
        status: failed ? "failed" : "superseded",
        started_at: iso(at - 80_000),
        finished_at: iso(at),
        error_message: failed,
      });
    });
    insertDeploy.run({
      id: deployId(),
      project_id: id,
      trigger_type: project.runtime === "static" ? "manual" : "webhook",
      commit_sha: sha(project.name + project.message),
      commit_message: project.message,
      status: project.status === "running" ? "running" : "superseded",
      started_at: iso(finished - 95_000),
      finished_at: iso(finished),
      error_message: null,
    });
    setStatus.run(project.status, iso(finished), id);
  }

  // The last hour of the machine and of the running apps, one sample every 30 s,
  // and a month of answers for the featured project's uptime.
  const sample = db.prepare(`
    INSERT INTO metric_samples (scope, subject_id, tier, ts, n, cpu, mem, mem_pct, disk, disk_pct, net_rx, net_tx, up, latency)
    VALUES (@scope, @subject_id, @tier, @ts, @n, @cpu, @mem, @mem_pct, @disk, @disk_pct, @net_rx, @net_tx, @up, @latency)
  `);
  const wave = (t, period, phase = 0) => Math.sin((t / period) * Math.PI * 2 + phase);
  const empty = { cpu: null, mem: null, mem_pct: null, disk: null, disk_pct: null, net_rx: null, net_tx: null, up: null, latency: null };
  const MEMORY = 16 * 1024 ** 3;
  const DISK = 320e9;
  db.transaction(() => {
    for (let t = now - HOUR; t <= now; t += 30_000) {
      const cpu = 18 + 6 * wave(t, 20 * MINUTE) + 3 * wave(t, 3 * MINUTE, 1);
      const mem = 0.41 * MEMORY + 0.02 * MEMORY * wave(t, 30 * MINUTE);
      sample.run({
        ...empty, scope: "host", subject_id: "host", tier: 0, ts: Math.round(t), n: 1,
        cpu, mem, mem_pct: (mem / MEMORY) * 100, disk: 0.37 * DISK, disk_pct: 37,
        net_rx: 180_000 + 60_000 * wave(t, 7 * MINUTE), net_tx: 90_000 + 40_000 * wave(t, 9 * MINUTE, 2),
      });
      PROJECTS.filter((p) => p.status === "running").forEach((project, i) => {
        const weight = project.name === FEATURED ? 1.6 : 0.4 + (i % 3) * 0.25;
        const pmem = (project.runtime === "static" ? 38 : 160 + i * 22) * 1024 ** 2 * (1 + 0.04 * wave(t, 25 * MINUTE, i));
        sample.run({
          ...empty, scope: "project", subject_id: ids[project.name], tier: 0, ts: Math.round(t), n: 1,
          cpu: Math.max(0.2, weight * (2.4 + 1.2 * wave(t, 11 * MINUTE, i) + 0.6 * wave(t, 2 * MINUTE, i * 2))),
          mem: pmem, mem_pct: (pmem / MEMORY) * 100,
          net_rx: weight * (22_000 + 9_000 * wave(t, 6 * MINUTE, i)), net_tx: weight * (48_000 + 15_000 * wave(t, 8 * MINUTE, i)),
        });
      });
    }

    const featured = ids[FEATURED];
    const latency = (t) => 82 + 14 * wave(t, 6 * HOUR) + 6 * wave(t, 17 * MINUTE, 1);
    // A month of quarter-hours, then the last day in minutes, then the latest checks.
    for (let t = now - 30 * DAY; t < now - DAY; t += 15 * MINUTE) {
      // One short outage, nine days ago: an uptime of exactly 100% reads as made up.
      const down = t > now - 9 * DAY - 40 * MINUTE && t < now - 9 * DAY;
      sample.run({ ...empty, scope: "uptime", subject_id: featured, tier: 15 * MINUTE, ts: Math.round(t), n: 15, up: down ? 0.6 : 1, latency: latency(t) });
    }
    for (let t = now - DAY; t < now - 10 * MINUTE; t += MINUTE) {
      sample.run({ ...empty, scope: "uptime", subject_id: featured, tier: MINUTE, ts: Math.round(t), n: 1, up: 1, latency: latency(t) });
    }
    for (let t = now - 10 * MINUTE; t <= now; t += MINUTE) {
      sample.run({ ...empty, scope: "uptime", subject_id: featured, tier: 0, ts: Math.round(t), n: 1, up: 1, latency: latency(t) });
    }

    // The outage drawn in the uptime bar, as the checker would have recorded it.
    db.prepare("INSERT INTO uptime_incidents (id, project_id, started_at, ended_at, cause, resolution) VALUES (?, ?, ?, ?, ?, ?)")
      .run("demoincident1", featured, iso(now - 9 * DAY - 38 * MINUTE), iso(now - 9 * DAY - 26 * MINUTE), "timeout", "recovered");

    // The three real runs, moved back to the three nights before.
    const nights = runs.map((_, i) => {
      const night = new Date(now - (runs.length - i) * DAY);
      night.setHours(3, 0, 12, 0);
      return +night;
    });
    const move = db.prepare("UPDATE backup_runs SET started_at = ?, finished_at = ?, heartbeat_at = ? WHERE id = ?");
    runs.forEach((id, i) => move.run(iso(nights[i]), iso(nights[i] + 41_000), iso(nights[i] + 41_000), id));

    // The activity of a working day instead of the seeding's own: deploys from
    // GitHub pushes (no account: the panel acted), a change of variables, the
    // nightly backup.
    const owner = db.prepare("SELECT id FROM users WHERE email = ?").get(OWNER.email)?.id ?? null;
    db.prepare("DELETE FROM audit_log").run();
    const audit = db.prepare("INSERT INTO audit_log (id, at, user_id, category, action, scope, scope_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)");
    const activity = [
      [15 * MINUTE, owner, "deploy", "project.deploy", "project", ids["api-prenotazioni"]],
      [40 * MINUTE, null, "deploy", "project.deploy", "project", ids["gestionale-magazzino"]],
      [2 * HOUR, null, "deploy", "project.deploy", "project", ids["osteria-da-mario"]],
      [2 * HOUR + 4 * MINUTE, owner, "config", "project.env", "project", ids["osteria-da-mario"]],
      [9 * HOUR, null, "deploy", "project.deploy", "project", ids["blog-cucina-toscana"]],
      [now - nights.at(-1), null, "backup", "backup.run", "permission", "backup"],
      [26 * HOUR, null, "deploy", "project.deploy", "project", ids["agenzia-viaggi-sole"]],
    ];
    activity.forEach(([ago, user, category, action, scope, scopeId], i) => {
      audit.run(`demoaudit${String(i).padStart(4, "0")}`, iso(now - ago), user, category, action, scope, scopeId);
    });
  })();
  db.close();
}

// --- what the panel would read from a healthy host -----------------------------

async function describeHost(context, ids) {
  // Docker, PM2, the boot autostart and the disk all fine: the warnings belong to this computer.
  await context.route(/\/api\/diagnostics(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const checks = (body.checks ?? []).map((check) => (check.tone === "warn" || check.tone === "danger" ? { ...check, tone: "ok" } : check));
    await route.fulfill({ response: res, json: { ...body, checks, tone: "ok", problems: 0 } });
  });

  const host = {
    cpu: 21.4,
    memory: { total: 16 * 1024 ** 3, used: 6.6 * 1024 ** 3, free: 9.4 * 1024 ** 3 },
    disk: { total: 320e9, used: 118e9, free: 202e9 },
    uptime: 41 * 86_400 + 5 * 3_600,
    loadAverage: [0.62, 0.71, 0.66],
  };
  await context.route(/\/api\/metrics(\?|$)/, (route) =>
    route.fulfill({
      json: {
        cpu: { usage: host.cpu, cores: 8, model: "AMD EPYC 9454P", loadAverage: host.loadAverage },
        memory: { total: host.memory.total, used: host.memory.used, available: host.memory.free },
        disk: host.disk,
        uptime: host.uptime,
        platform: "linux",
        hostname: "vps-milano-01",
      },
    })
  );

  // The charts' history is in the store; what it is a share of, and whether
  // the collector runs (the schedulers are off here), are the machine's.
  await context.route(/\/api\/metrics\/history(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      response: res,
      json: {
        ...body,
        context: { ...body.context, cores: 8, memTotal: host.memory.total, diskTotal: body.scope === "host" ? host.disk.total : null },
        sampling: { ...body.sampling, collecting: true, lastSampleAt: Date.now() - 12_000 },
      },
    });
  });

  // A running project's process, as PM2 or Docker would describe it: CPU in
  // percent of one core, uptime in seconds.
  const byId = new Map(PROJECTS.map((p, i) => [ids[p.name], { project: p, i }]));
  const processOf = (known) => {
    const heavy = known.project.name === FEATURED;
    return {
      running: true,
      pid: 41_000 + known.i * 97,
      uptime: Math.round(known.project.ago / 1000),
      cpu: heavy ? 9.5 : 2.2 + known.i * 0.8,
      memory: (known.project.runtime === "static" ? 38 : 160 + known.i * 22) * 1024 ** 2,
    };
  };

  // The Monitor: the same machine, the same processes, no containers of anyone else.
  await context.route(/\/api\/monitor(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const projects = (body.projects ?? []).map((p) => {
      const known = byId.get(p.id);
      return p.status === "running" && known ? { ...p, process: processOf(known) } : p;
    });
    await route.fulfill({ response: res, json: { ...body, server: { ...body.server, ...host }, projects, others: [] } });
  });

  // A project's page asks for its own.
  await context.route(/\/api\/projects\/([^/]+)\/status(\?|$)/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const known = byId.get(new URL(route.request().url()).pathname.split("/")[3]);
    await route.fulfill({ response: res, json: body.status === "running" && known ? { ...body, process: processOf(known) } : body });
  });
}

// --- photographing -------------------------------------------------------------

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.locator("#main .skeleton").first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  // Fonts and the last chart frame.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

async function webp(png, file, width) {
  let image = sharp(png);
  if (width) image = image.resize({ width, withoutEnlargement: true });
  const out = join(OUT, file);
  writeFileSync(out, await image.webp({ quality: 82, effort: 6 }).toBuffer());
  console.log(`  ${file}`);
  return out;
}

async function shootDesktop(browser, base, storageState, palette, { ids, user }) {
  const context = await browser.newContext({
    baseURL: base,
    storageState,
    viewport: { width: 1440, height: 920 },
    deviceScaleFactor: 2,
    colorScheme: palette,
    reducedMotion: "reduce",
    locale: "it-IT",
    timezoneId: "Europe/Rome",
  });
  await context.addCookies([{ name: "runpanel_theme", value: palette, url: base }]);
  await context.addInitScript(() => localStorage.setItem("runpanel.onboarding.hidden", "1"));
  await describeHost(context, ids);
  const page = await context.newPage();

  // The overview taller: its projects, in their folders, come after the machine's tiles.
  const shots = [
    { file: `overview-${palette}.webp`, path: "/home", height: 1500 },
    { file: `projects-${palette}.webp`, path: "/projects", height: 920 },
    { file: `project-${palette}.webp`, path: `/projects/${ids[FEATURED]}`, height: 920 },
    { file: `variables-${palette}.webp`, path: `/projects/${ids[FEATURED]}/env`, height: 920 },
    { file: `backups-${palette}.webp`, path: "/backups", height: 920 },
    { file: `monitor-${palette}.webp`, path: "/monitor", height: 920 },
    { file: `user-detail-${palette}.webp`, path: `/users/${user}`, height: 920 },
  ];
  for (const shot of shots) {
    await page.setViewportSize({ width: 1440, height: shot.height });
    await page.goto(shot.path);
    await settle(page);
    await webp(await page.screenshot(), shot.file, 1600);
  }
  await context.close();
}

async function shootPhone(browser, base, storageState, palette, ids) {
  const context = await browser.newContext({
    baseURL: base,
    storageState,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: palette,
    reducedMotion: "reduce",
    locale: "it-IT",
    timezoneId: "Europe/Rome",
  });
  await context.addCookies([{ name: "runpanel_theme", value: palette, url: base }]);
  await context.addInitScript(() => {
    localStorage.setItem("runpanel.onboarding.hidden", "1");
  });
  await describeHost(context, ids);
  const page = await context.newPage();

  const frames = [];
  for (const path of ["/home", "/projects", `/projects/${ids[FEATURED]}`]) {
    await page.goto(path);
    await settle(page);
    frames.push(await page.screenshot());
  }
  await context.close();

  // Three phones side by side on the page colour, each with rounded corners.
  const [w, h] = [390 * 2, 844 * 2];
  const gap = 96;
  const radius = 64;
  const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}"/></svg>`);
  const rounded = await Promise.all(
    frames.map((frame) => sharp(frame).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer())
  );
  const background = palette === "dark" ? "#07080b" : "#f8f9fb";
  const canvas = sharp({
    create: { width: w * 3 + gap * 4, height: h + gap * 2, channels: 4, background },
  }).composite(rounded.map((input, i) => ({ input, left: gap + i * (w + gap), top: gap })));
  await webp(await canvas.png().toBuffer(), `phone-${palette}.webp`, 1600);
}

// --- run -----------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
console.log("starting a demo panel…");
const server = await startPanel({ root: ROOT, port: Number(process.env.RUNPANEL_SCREENSHOT_PORT) || 5650 });
const api = await playwrightRequest.newContext({ baseURL: server.base });
let browser;
try {
  console.log(`seeding ${server.base}`);
  const seeded = await seedThroughApi(api);
  seedStore(server.dataDir, seeded);
  const storageState = await api.storageState();

  browser = await chromium.launch(CHANNEL === "chromium" ? {} : { channel: CHANNEL });
  console.log(`writing to ${OUT}`);
  for (const palette of ["dark", "light"]) {
    await shootDesktop(browser, server.base, storageState, palette, seeded);
    await shootPhone(browser, server.base, storageState, palette, seeded.ids);
  }
} finally {
  await browser?.close();
  await api.dispose();
  if (KEEP) {
    console.log(`\nThe demo panel stays up: ${server.base} — ${OWNER.email} / ${OWNER.password}. Ctrl+C to stop it.`);
    process.on("SIGINT", async () => {
      await server.stop();
      process.exit(0);
    });
  } else {
    await server.stop();
  }
}
