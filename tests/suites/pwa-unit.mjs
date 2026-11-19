import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { createReporter } from "../harness.mjs";
import { loadTs } from "../ts-modules.mjs";

/**
 * The installable app, without a browser: what the service worker does with
 * each kind of request, and that everything the manifest and the launch
 * screens name is really there.
 *
 * The worker is the part that can do harm. A worker that cached a page or an
 * API answer would show a project as running after it crashed, or a session
 * after it was signed out — so it runs here against fake caches and a fake
 * network, and every kind of request is checked for where it went.
 *
 * Standalone: the modules under lib/pwa import nothing but lib/theme-mode.
 */
export const meta = { name: "pwa-unit", needsDocker: false, drivers: [], standalone: true };

const ORIGIN = "https://panel.test";

/** Width and height from a PNG or WebP header: enough to check what the manifest declares. */
function imageSize(file) {
  const b = readFileSync(file);
  if (b.toString("ascii", 1, 4) === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
  }
  return null;
}

/** A response as the network gives it: `type` is "basic" for same-origin, which a constructed one is not. */
function networkResponse(body, status = 200) {
  const response = new Response(body, { status });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

/** A window of the panel as the worker sees it, recording what is done to it. */
function fakeWindow(path, { focused = false, visibilityState = "hidden" } = {}) {
  const win = {
    url: new URL(path, ORIGIN).href,
    focused,
    visibilityState,
    focusedByWorker: false,
    messages: [],
    focus: async () => {
      win.focusedByWorker = true;
      return win;
    },
    postMessage: (message) => void win.messages.push(message),
  };
  return win;
}

/** The worker in a sandbox with fake caches and a fake network, and a way to send it events. */
function bootWorker(source) {
  const listeners = {};
  const stores = new Map();
  const network = { calls: [], requests: [], offline: false, status: 200 };
  const flags = { skipped: false, claimed: false, preloadEnabled: false };
  // What the notification APIs were asked to do.
  const notes = { shown: [], windows: [], opened: [], badge: null, subscribed: [] };

  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    const key = (request) => (typeof request === "string" ? new URL(request, ORIGIN).href : request.url);
    return {
      store,
      match: async (request) => store.get(key(request))?.clone(),
      put: async (request, response) => void store.set(key(request), response),
      addAll: async (urls) => {
        for (const url of urls) store.set(key(url), networkResponse(`precached ${url}`));
      },
    };
  };

  const sandbox = {
    self: {
      location: new URL(`${ORIGIN}/sw.js`),
      registration: {
        navigationPreload: { enable: async () => void (flags.preloadEnabled = true) },
        showNotification: async (title, options) => void notes.shown.push({ title, options }),
        getNotifications: async ({ tag } = {}) =>
          notes.shown.filter((note) => !tag || note.options.tag === tag).map((note) => ({ data: note.options.data })),
        pushManager: {
          subscribe: async (options) => {
            notes.subscribed.push(options);
            return {
              endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
              options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer },
              toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/renewed", keys: { p256dh: "B", auth: "A" } }),
            };
          },
        },
      },
      clients: {
        claim: async () => void (flags.claimed = true),
        matchAll: async () => notes.windows,
        openWindow: async (url) => void notes.opened.push(url),
      },
      navigator: {
        setAppBadge: async (count) => void (notes.badge = count),
        clearAppBadge: async () => void (notes.badge = 0),
      },
      skipWaiting: () => void (flags.skipped = true),
      addEventListener: (type, fn) => void (listeners[type] = fn),
    },
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
    },
    fetch: async (request, init) => {
      const url = typeof request === "string" ? request : request.url;
      network.calls.push(url);
      network.requests.push({ url, init });
      if (network.offline) throw new TypeError("Failed to fetch");
      if (url === "/api/notifications/read") return Response.json({ ok: true, unread: 0 });
      return networkResponse(`network ${url}`, network.status);
    },
    Response,
    URL,
    Promise,
    JSON,
    Uint8Array,
    String,
    btoa,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  /** One extendable event; resolves with what was passed to respondWith, or undefined. */
  async function dispatch(type, init = {}) {
    let responded;
    const waits = [];
    const event = {
      ...init,
      respondWith: (value) => void (responded = Promise.resolve(value)),
      waitUntil: (value) => void waits.push(Promise.resolve(value)),
    };
    listeners[type]?.(event);
    await Promise.all(waits);
    return responded ? await responded : undefined;
  }

  function request(path, { method = "GET", mode = "cors", origin = ORIGIN } = {}) {
    return { url: new URL(path, origin).href, method, mode };
  }

  return { dispatch, request, stores, network, flags, listeners, notes };
}

/** A push as the browser hands it to the worker. */
function pushEvent(payload) {
  return {
    data:
      payload === undefined
        ? null
        : {
            json: () => (typeof payload === "string" ? JSON.parse(payload) : payload),
          },
  };
}

export async function run({ repoRoot }) {
  const r = createReporter("pwa-unit");
  const sw = await loadTs(repoRoot, "lib", "pwa", "service-worker.ts");
  const { buildManifest } = await loadTs(repoRoot, "lib", "pwa", "manifest.ts");
  const { launchScreenLinks, LAUNCH_SCREENS } = await loadTs(repoRoot, "lib", "pwa", "launch-screens.ts");
  const { isIosDevice } = await loadTs(repoRoot, "lib", "pwa", "install.ts");
  const { THEME_COLORS } = await loadTs(repoRoot, "lib", "theme-mode.ts");

  // --- the worker's text ---------------------------------------------------------
  const source = sw.serviceWorkerSource("build-42");
  r.check("the build is stamped into the worker", source.includes('"build-42"'));
  r.check("no placeholder is left behind", !/__[A-Z_]+__/.test(source));
  r.check("a new build is a different worker", sw.serviceWorkerSource("build-43") !== source);
  r.check("it is valid JavaScript", (() => {
    try {
      new vm.Script(source);
      return true;
    } catch {
      return false;
    }
  })());

  const worker = bootWorker(source);
  const current = `${sw.SW_CACHE_PREFIX}static-build-42`;

  // --- install and activate ----------------------------------------------------------
  await worker.dispatch("install");
  const precached = [...(worker.stores.get(current)?.keys() ?? [])].map((url) => new URL(url).pathname);
  r.check("installing precaches the app's icons", sw.SW_PRECACHE.every((path) => precached.includes(path)), precached.join(", "));
  r.check("installing does not take over by itself", worker.flags.skipped === false);

  worker.stores.set(`${sw.SW_CACHE_PREFIX}static-build-41`, new Map());
  worker.stores.set("someone-else", new Map());
  await worker.dispatch("activate");
  r.check("activating drops the caches of older builds", !worker.stores.has(`${sw.SW_CACHE_PREFIX}static-build-41`));
  r.check("and leaves caches it does not own alone", worker.stores.has("someone-else"));
  r.check("activating turns on navigation preload and claims the pages", worker.flags.preloadEnabled && worker.flags.claimed);

  await worker.dispatch("message", { data: { type: "SKIP_WAITING" } });
  r.check('"Aggiorna" makes the waiting worker take over', worker.flags.skipped === true);

  // --- what it does not touch ----------------------------------------------------------
  const untouched = async (label, req) => r.check(label, (await worker.dispatch("fetch", { request: req })) === undefined);
  await untouched("an API call is not intercepted", worker.request("/api/projects"));
  await untouched("nor an event stream", worker.request("/api/notifications/stream"));
  await untouched("nor a write", worker.request("/_next/static/chunks/app.js", { method: "POST" }));
  await untouched("nor another site", worker.request("/_next/static/x.js", { origin: "https://cdn.example" }));
  await untouched("nor a page's data request", worker.request("/projects?_rsc=abc"));

  // --- pages: always the network ---------------------------------------------------------
  worker.network.calls.length = 0;
  let res = await worker.dispatch("fetch", { request: worker.request("/home", { mode: "navigate" }), preloadResponse: Promise.resolve(undefined) });
  r.check("a page comes from the network", res && (await res.text()) === `network ${ORIGIN}/home` && worker.network.calls.length === 1);

  const preloaded = networkResponse("preloaded");
  worker.network.calls.length = 0;
  res = await worker.dispatch("fetch", { request: worker.request("/projects", { mode: "navigate" }), preloadResponse: Promise.resolve(preloaded) });
  r.check("a preloaded page is used as it is", res === preloaded && worker.network.calls.length === 0);

  worker.network.status = 500;
  res = await worker.dispatch("fetch", { request: worker.request("/home", { mode: "navigate" }), preloadResponse: Promise.resolve(undefined) });
  r.check("a server error is shown as the server sent it", res?.status === 500);
  worker.network.status = 200;

  worker.network.offline = true;
  res = await worker.dispatch("fetch", { request: worker.request("/home", { mode: "navigate" }), preloadResponse: Promise.resolve(undefined) });
  const offlineText = res ? await res.text() : "";
  r.check("with no network a page gets the offline page", res?.status === 503 && offlineText.includes("Sei offline"), String(res?.status));
  r.check("in Italian, with a way to retry", offlineText.includes('lang="it"') && offlineText.includes("Riprova"));
  r.check("which is never stored", res?.headers.get("cache-control") === "no-store");
  worker.network.offline = false;

  // --- hashed files: the cache first -----------------------------------------------------------
  const chunk = worker.request("/_next/static/chunks/main-abc123.js");
  worker.network.calls.length = 0;
  res = await worker.dispatch("fetch", { request: chunk });
  r.check("a build file is fetched the first time", res && worker.network.calls.length === 1);
  worker.network.calls.length = 0;
  res = await worker.dispatch("fetch", { request: chunk });
  r.check("and comes from the cache after that", res && (await res.text()).startsWith("network") && worker.network.calls.length === 0);

  worker.network.status = 404;
  await worker.dispatch("fetch", { request: worker.request("/_next/static/chunks/gone-999.js") });
  worker.network.status = 200;
  const cachedPaths = [...worker.stores.get(current).keys()].map((url) => new URL(url).pathname);
  r.check("a missing file is not cached", !cachedPaths.includes("/_next/static/chunks/gone-999.js"));
  r.check(
    "the cache holds only build files and icons, never a page or an API answer",
    cachedPaths.every((path) => path.startsWith("/_next/static/") || path.startsWith("/icons/") || path === "/icon.svg"),
    cachedPaths.join(", ")
  );

  // --- notifications on the device ----------------------------------------------------------------
  const { PUSH_ICON, PUSH_BADGE } = await loadTs(repoRoot, "lib", "push-rules.ts");
  const pushed = bootWorker(source);
  await pushed.dispatch(
    "push",
    pushEvent({
      v: 1,
      title: "Deploy fallito — api",
      body: "Deploy automatico da GitHub. Il motivo e il log sono nella pagina del progetto.",
      url: "/projects/p1",
      tag: "project:p1",
      level: "danger",
      unread: 3,
      ids: ["n1"],
      at: 1_700_000_000_000,
      icon: PUSH_ICON,
      badge: PUSH_BADGE,
    })
  );
  let note = pushed.notes.shown[0];
  r.check("a push is shown, with its title and body", note?.title === "Deploy fallito — api" && note?.options.body.startsWith("Deploy automatico"), JSON.stringify(note));
  r.check("tagged by what it is about, so a newer one replaces it", note?.options.tag === "project:p1");
  r.check("with the panel's icon and status-bar badge", note?.options.icon === PUSH_ICON && note?.options.badge === PUSH_BADGE);
  r.check("it remembers the page to open and the notification to mark read", note?.options.data.url === "/projects/p1" && note?.options.data.ids.join() === "n1");
  r.check("and puts the unread count on the app's icon", pushed.notes.badge === 3, String(pushed.notes.badge));

  await pushed.dispatch("push", pushEvent({ title: "L'app non risponde — api", body: "…", url: "/projects/p1", tag: "project:p1", ids: ["n2"], unread: 4 }));
  note = pushed.notes.shown[1];
  r.check("a second one about the same project, moments later, replaces it without sounding again", note?.options.renotify === false, JSON.stringify(note?.options));
  r.check("and pressing it marks both read", note?.options.data.ids.join() === "n1,n2", JSON.stringify(note?.options.data));
  await pushed.dispatch("push", pushEvent({ title: "Docker non risponde", tag: "event:docker.down", unread: 0 }));
  r.check("one about something else does sound", pushed.notes.shown[2]?.options.renotify === true);
  r.check("an unread count of zero clears the badge", pushed.notes.badge === 0);

  await pushed.dispatch("push", pushEvent({ title: "x", url: "https://evil.example/", icon: "https://tracker.example/pixel.png", tag: "t" }));
  note = pushed.notes.shown[3];
  r.check("a notification never opens another site", note?.options.data.url === "/notifications", note?.options.data.url);
  r.check("nor fetches a picture from one", note?.options.icon === PUSH_ICON, note?.options.icon);
  await pushed.dispatch("push", pushEvent());
  r.check("a push with nothing in it is still shown, as RunPanel", pushed.notes.shown[4]?.title === "RunPanel");
  await pushed.dispatch("push", pushEvent("not json"));
  r.check("and so is one that is not JSON", pushed.notes.shown.length === 6);

  // Pressing it, with the panel already open in a window.
  const statusPage = fakeWindow("/status/abc", { visibilityState: "visible" });
  const panelWindow = fakeWindow("/home");
  pushed.notes.windows.push(statusPage, panelWindow);
  pushed.notes.badge = null;
  let closed = false;
  await pushed.dispatch("notificationclick", { notification: { data: { url: "/projects/p1", ids: ["n1", "n2"] }, close: () => void (closed = true) } });
  r.check("pressing it closes it", closed);
  r.check("and focuses the panel's window, not the public status page", panelWindow.focusedByWorker && !statusPage.focusedByWorker);
  r.check(
    "which is asked to show the page itself, with its router",
    JSON.stringify(panelWindow.messages) === JSON.stringify([{ type: "runpanel:open", url: "/projects/p1" }]),
    JSON.stringify(panelWindow.messages)
  );
  r.check("no second window is opened", pushed.notes.opened.length === 0);
  const read = pushed.network.requests.find((entry) => entry.url === "/api/notifications/read");
  r.check(
    "what it stood for is marked read",
    read?.init?.method === "POST" && JSON.parse(read.init.body).ids.join() === "n1,n2" && read.init.credentials === "same-origin",
    JSON.stringify(read)
  );
  r.check("and the badge follows the answer", pushed.notes.badge === 0, String(pushed.notes.badge));

  pushed.notes.windows.length = 0;
  pushed.notes.windows.push(fakeWindow("/status/abc", { focused: true }));
  await pushed.dispatch("notificationclick", { notification: { data: { url: "/backups" }, close: () => {} } });
  r.check("with no window of the panel, it opens one on the page", pushed.notes.opened.join() === `${ORIGIN}/backups`, pushed.notes.opened.join());
  await pushed.dispatch("notificationclick", { notification: { data: { url: "//evil.example" }, close: () => {} } });
  r.check("and never on another site", pushed.notes.opened[1] === `${ORIGIN}/notifications`, pushed.notes.opened[1]);

  // The push service replaced the subscription.
  pushed.network.requests.length = 0;
  await pushed.dispatch("pushsubscriptionchange", {
    oldSubscription: { endpoint: "https://fcm.googleapis.com/fcm/send/old", options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer } },
    newSubscription: null,
  });
  const renewed = pushed.network.requests.find((entry) => entry.url === "/api/account/push/devices");
  const renewal = renewed ? JSON.parse(renewed.init.body) : null;
  r.check("a replaced subscription subscribes again with the same key", pushed.notes.subscribed.length === 1 && pushed.notes.subscribed[0].userVisibleOnly === true);
  r.check(
    "and tells the panel, naming the endpoint it replaces so the device keeps its name",
    renewal?.previousEndpoint === "https://fcm.googleapis.com/fcm/send/old" && renewal?.subscription?.endpoint === "https://fcm.googleapis.com/fcm/send/renewed",
    JSON.stringify(renewal)
  );
  r.check("with the key it used, so a stale one is refused", renewal?.applicationServerKey === "BAEC", renewal?.applicationServerKey);

  // --- the manifest ------------------------------------------------------------------------------
  const manifest = buildManifest();
  r.check("it opens as an app, on the overview", manifest.display === "standalone" && manifest.start_url === "/home" && manifest.scope === "/");
  r.check("it has a stable id", typeof manifest.id === "string" && manifest.id.length > 0);
  r.check("Italian, like the panel", manifest.lang === "it");
  r.check("the colours are the dark page's", manifest.theme_color === THEME_COLORS.dark && manifest.background_color === THEME_COLORS.dark);
  for (const purpose of ["any", "maskable"]) {
    const sizes = manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
    r.check(`icons for "${purpose}" at 192 and 512`, sizes.includes("192x192") && sizes.includes("512x512"), sizes.join(", "));
  }
  r.check("a monochrome icon for themed icons", manifest.icons.some((icon) => icon.purpose === "monochrome"));

  const files = [
    ...manifest.icons.map((icon) => icon),
    ...manifest.screenshots.map((shot) => shot),
    ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons ?? []),
  ];
  const wrong = files.filter((file) => {
    const path = join(repoRoot, "public", file.src);
    if (!existsSync(path)) return true;
    const size = imageSize(path);
    return !size || `${size.width}x${size.height}` !== file.sizes;
  });
  r.check("every picture it names exists, at the size it says", wrong.length === 0, wrong.map((f) => f.src).join(", "));
  r.check(
    "screenshots for the phone and the desktop install dialogs",
    manifest.screenshots.some((s) => s.form_factor === "narrow") && manifest.screenshots.some((s) => s.form_factor === "wide")
  );

  const shortcutUrls = manifest.shortcuts.map((s) => s.url);
  r.check("shortcuts to projects, backups and a new project", ["/projects", "/backups", "/projects/new"].every((url) => shortcutUrls.includes(url)), shortcutUrls.join(", "));
  const missingPages = shortcutUrls.filter((url) => !existsSync(join(repoRoot, "app", "(panel)", ...url.split("/").filter(Boolean), "page.tsx")));
  r.check("each shortcut leads to a page that exists", missingPages.length === 0, missingPages.join(", "));

  // --- iOS launch screens -------------------------------------------------------------------------
  const links = launchScreenLinks("system");
  r.check("a dark and a light launch screen per iPhone size", links.length === LAUNCH_SCREENS.length * 2);
  const badScreens = links.filter((link) => {
    const path = join(repoRoot, "public", link.url);
    const size = existsSync(path) ? imageSize(path) : null;
    const [w, h] = link.url.match(/(\d+)x(\d+)/).slice(1).map(Number);
    return !size || size.width !== w || size.height !== h;
  });
  r.check("every launch screen exists, at the size of its screen", badScreens.length === 0, badScreens.map((l) => l.url).join(", "));
  r.check(
    "'Sistema' lets the phone's scheme pick, a fixed theme does not ask",
    links.every((l) => /prefers-color-scheme: (dark|light)/.test(l.media)) && launchScreenLinks("dark").every((l) => !l.media.includes("prefers-color-scheme"))
  );

  // --- telling iOS apart ------------------------------------------------------------------------------
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
  const android = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
  r.check("an iPhone is iOS", isIosDevice(iphone, "iPhone", 5));
  r.check("an iPad that introduces itself as a Mac is iOS", isIosDevice(mac, "MacIntel", 5));
  r.check("a Mac is not", !isIosDevice(mac, "MacIntel", 0));
  r.check("Android is not", !isIosDevice(android, "Linux armv8l", 5));

  return r.result();
}
