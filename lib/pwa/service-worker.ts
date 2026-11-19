import { PUSH_BADGE, PUSH_ICON } from "../push-rules";
import { THEME_COLORS, THEME_COOKIE } from "../theme-mode";

/**
 * The service worker, as the text `/sw.js` serves (app/sw.js/route.ts).
 *
 * What it is for, and only that:
 *
 * - **Opening fast.** Next names every file under `/_next/static/` after a
 *   hash of its contents, so a copy can never be stale: those, and the icons,
 *   come from the cache first.
 * - **Never showing old data.** Pages and everything under `/api/` always go
 *   to the server, untouched. The panel is a live view of a machine, and a
 *   cached page could show a project running that has since crashed, or a
 *   session that has since been signed out. API calls are not even
 *   intercepted, which also leaves the event streams alone.
 * - **Saying why when the server cannot be reached.** A page that fails to
 *   load gets the offline page below instead of the browser's dinosaur.
 * - **Telling an open app that the panel was updated.** The version stamped
 *   in below is the build's id, so every build is a new worker. It waits until
 *   the person presses "Aggiorna" (components/pwa/PwaRuntime.tsx), because
 *   taking over by itself would swap the code under a half-filled form.
 * - **Notifications on the device** (services/notify/push.ts sends them).
 *   Each push is shown, always: Safari takes the permission away from a site
 *   whose pushes show nothing. Its tag is the project or the service it is
 *   about, so a newer one replaces the older on the screen, silently if the
 *   older is only a moment old. It carries the unread count of the account's
 *   notification centre, which goes on the app's icon. Pressing it marks
 *   it read and opens its page in the panel's window if there is one — the
 *   page moves there with its own router — or in a new one.
 *
 * Written as text rather than a file in `public/` so that the version can be
 * stamped in per build; no backticks or `${` in the template, so it can be
 * read as the JavaScript it is.
 */

export const SW_CACHE_PREFIX = "runpanel-";

/** Fetched when the worker installs, so the installed app has its icon offline too. */
export const SW_PRECACHE = [
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-192.png",
  "/icons/maskable-512.png",
  "/icons/monochrome-192.png",
  "/icons/monochrome-512.png",
  "/icon.svg",
];

const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">' +
  '<rect width="64" height="64" rx="15" fill="#3B8EEA"/>' +
  '<rect x="13" y="40" width="38" height="10" rx="5" fill="#fff" opacity=".4"/>' +
  '<rect x="13" y="27" width="38" height="10" rx="5" fill="#fff" opacity=".7"/>' +
  '<rect x="13" y="14" width="22" height="10" rx="5" fill="#fff"/>' +
  '<path d="M45 25V12m-5.5 5.5L45 12l5.5 5.5" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</svg>";

/**
 * What a page that could not be loaded shows instead.
 *
 * Self-contained, because by definition nothing else can be fetched. It takes
 * the theme from the panel's cookie — with the same dark strip under the iOS
 * status bar as the top bar has in the light palette (`.status-bar-scrim` in
 * globals.css) — and tells apart a phone with no network
 * from a server that does not answer — after an update the panel restarts,
 * and "you are offline" would then be wrong. It reloads by itself as soon as
 * the server answers again.
 */
export function offlinePage(): string {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${THEME_COLORS.dark}">
<title>Sei offline · RunPanel</title>
<style>
:root{color-scheme:dark;--bg:${THEME_COLORS.dark};--fg:#f6f7f9;--muted:#9ca0a9;--accent:#3e96ea;--accent-fg:${THEME_COLORS.dark}}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){color-scheme:light;--bg:${THEME_COLORS.light};--fg:#16181e;--muted:#5c606a;--accent:#006cd3;--accent-fg:#fff}}
:root[data-theme=light]{color-scheme:light;--bg:${THEME_COLORS.light};--fg:#16181e;--muted:#5c606a;--accent:#006cd3;--accent-fg:#fff}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{box-sizing:border-box;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}
h1{font-size:18px;font-weight:600;margin:20px 0 6px}
p{color:var(--muted);margin:0;max-width:22rem}
button{margin-top:24px;min-height:44px;padding:0 22px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:active{opacity:.85}
body::before{content:"";position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top);background:var(--scrim,transparent)}
:root[data-theme=light]{--scrim:#16181e}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){--scrim:#16181e}}
</style>
<script>(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)(?:;|$)/);if(m)document.documentElement.setAttribute("data-theme",m[1]);}catch(e){}})();</script>
</head>
<body>
<main>
${LOGO}
<h1 id="title">Sei offline</h1>
<p id="text">Il pannello ha bisogno di raggiungere il server. Appena la connessione torna, la pagina si ricarica da sola.</p>
<button type="button" onclick="location.reload()">Riprova</button>
</main>
<script>(function(){
var title=document.getElementById("title"),text=document.getElementById("text");
function describe(){if(navigator.onLine){title.textContent="Il pannello non risponde";text.textContent="La rete c'è, ma il server non risponde: forse si sta riavviando dopo un aggiornamento. Riprovo da solo ogni pochi secondi.";}}
describe();
window.addEventListener("online",function(){location.reload();});
setInterval(function(){if(!navigator.onLine)return;fetch("/api/auth/check",{cache:"no-store"}).then(function(r){if(r.ok)location.reload();},function(){});},5000);
})();</script>
</body>
</html>`;
}

const TEMPLATE = String.raw`/* RunPanel service worker. Generated by app/sw.js/route.ts; see lib/pwa/service-worker.ts. */
"use strict";

var VERSION = __VERSION__;
var PREFIX = __PREFIX__;
var STATIC_CACHE = PREFIX + "static-" + VERSION;
var PRECACHE = __PRECACHE__;
var OFFLINE_HTML = __OFFLINE__;

/* Hashed by Next, and the pictures of the installed app: safe to serve from the cache. */
function isStatic(url) {
  return url.pathname.indexOf("/_next/static/") === 0 || url.pathname.indexOf("/icons/") === 0 || url.pathname === "/icon.svg" || url.pathname === "/favicon.ico" || url.pathname.indexOf("/apple-icon") === 0;
}

self.addEventListener("install", function (event) {
  /* No skipWaiting: a new version waits for "Aggiorna". A failed precache must not stop the worker installing. */
  event.waitUntil(caches.open(STATIC_CACHE).then(function (cache) { return cache.addAll(PRECACHE); }).catch(function () {}));
});

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (key) { return key.indexOf(PREFIX) === 0 && key !== STATIC_CACHE; }).map(function (key) { return caches.delete(key); }));
    /* The page request starts while the worker is still waking up, instead of after. */
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(page(event));
    return;
  }
  /* The API and everything else go to the network untouched: not intercepted at all. */
  if (url.pathname.indexOf("/api/") === 0) return;
  if (isStatic(url)) event.respondWith(fromCacheFirst(request));
});

/* Always from the server. The offline page only when the server cannot be reached at all. */
async function page(event) {
  try {
    var preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (error) {
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

async function fromCacheFirst(request) {
  var cache = await caches.open(STATIC_CACHE);
  var hit = await cache.match(request);
  if (hit) return hit;
  var response = await fetch(request);
  /* Only real answers: a 404 for a file of an older build must not stick. */
  if (response.ok && response.type === "basic") cache.put(request, response.clone());
  return response;
}

/* --- Notifications on the device: what a payload holds is PushPayload in lib/push-rules.ts --- */

var PUSH_ICON = __PUSH_ICON__;
var PUSH_BADGE = __PUSH_BADGE__;
/* A newer notification with the same tag replaces the older one: without sounding again if the older is this recent. */
var QUIET_REPLACE_MS = 2 * 60 * 1000;
var MAX_IDS = 50;

/* A path inside the panel, never another site: what a notification opens. */
function panelPath(raw) {
  if (typeof raw !== "string" || raw.charAt(0) !== "/" || raw.charAt(1) === "/" || raw.indexOf("\\") !== -1 || raw.length > 512) return "/notifications";
  return raw;
}

/* Pictures only from the panel itself: a notification must not fetch anything from elsewhere. */
function panelAsset(raw, fallback) {
  return typeof raw === "string" && raw.charAt(0) === "/" && raw.charAt(1) !== "/" ? raw : fallback;
}

/* The unread count on the app's icon; nothing where the browser has no badge. */
function setBadge(count) {
  var nav = self.navigator;
  if (typeof count !== "number" || !nav) return Promise.resolve();
  try {
    if (count > 0 && nav.setAppBadge) return nav.setAppBadge(count).catch(function () {});
    if (count <= 0 && nav.clearAppBadge) return nav.clearAppBadge().catch(function () {});
  } catch (error) {
    /* not supported here */
  }
  return Promise.resolve();
}

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch (error) {
    data = {};
  }
  event.waitUntil(showPush(data));
});

async function showPush(data) {
  var title = typeof data.title === "string" && data.title ? data.title : "RunPanel";
  var tag = typeof data.tag === "string" && data.tag ? data.tag : "runpanel";
  var now = Date.now();
  var ids = Array.isArray(data.ids) ? data.ids.filter(function (id) { return typeof id === "string"; }) : [];
  var renotify = true;
  try {
    var shown = await self.registration.getNotifications({ tag: tag });
    for (var i = 0; i < shown.length; i++) {
      var before = shown[i].data || {};
      if (typeof before.shownAt === "number" && now - before.shownAt < QUIET_REPLACE_MS) renotify = false;
      /* The one it replaces is still unread: pressing this one marks both. */
      if (Array.isArray(before.ids)) ids = before.ids.concat(ids);
    }
  } catch (error) {
    /* no list of what is shown: it is simply shown */
  }
  await self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    icon: panelAsset(data.icon, PUSH_ICON),
    badge: panelAsset(data.badge, PUSH_BADGE),
    tag: tag,
    renotify: renotify,
    timestamp: typeof data.at === "number" ? data.at : now,
    data: { url: panelPath(data.url), ids: ids.slice(-MAX_IDS), shownAt: now },
  });
  await setBadge(data.unread);
}

self.addEventListener("notificationclick", function (event) {
  var data = (event.notification && event.notification.data) || {};
  event.notification.close();
  event.waitUntil(Promise.all([openPanel(panelPath(data.url)), markRead(data.ids)]));
});

/* The panel's window if there is one, moved to the page by its own router; a new window otherwise. */
async function openPanel(path) {
  var windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  var panel = windows.filter(function (client) {
    var at = new URL(client.url);
    return at.origin === self.location.origin && at.pathname.indexOf("/status/") !== 0;
  });
  var target =
    panel.find(function (client) { return client.focused; }) ||
    panel.find(function (client) { return client.visibilityState === "visible"; }) ||
    panel[0];
  if (target) {
    try {
      target = (await target.focus()) || target;
    } catch (error) {
      /* focus is only allowed while the click is being handled; the message still goes */
    }
    target.postMessage({ type: "runpanel:open", url: path });
    return;
  }
  if (self.clients.openWindow) await self.clients.openWindow(new URL(path, self.location.origin).href);
}

async function markRead(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  try {
    var res = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ids: ids.slice(0, 200) }),
    });
    if (!res.ok) return;
    var body = await res.json();
    await setBadge(body && body.unread);
  } catch (error) {
    /* signed out, or the server is away: the bell will say so when the panel opens */
  }
}

function toBase64Url(buffer) {
  var bytes = new Uint8Array(buffer);
  var text = "";
  for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* The push service replaced the subscription: tell the panel, which keeps the device's name and choices. */
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(renewSubscription(event.oldSubscription || null, event.newSubscription || null));
});

async function renewSubscription(previous, next) {
  try {
    var key = previous && previous.options && previous.options.applicationServerKey;
    var current = next || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
    if (!current) return;
    var usedKey = current.options && current.options.applicationServerKey;
    await fetch("/api/account/push/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        subscription: current.toJSON(),
        name: "Dispositivo",
        previousEndpoint: previous ? previous.endpoint : null,
        applicationServerKey: usedKey ? toBase64Url(usedKey) : undefined,
      }),
    });
  } catch (error) {
    /* signed out: the next time the panel opens here, it subscribes again */
  }
}
`;

/** The worker for one build. `version` should change with every build: see app/sw.js/route.ts. */
export function serviceWorkerSource(version: string): string {
  // Replacer functions, not strings: a `$` in the inserted text would otherwise
  // be read as a replacement pattern, and the offline page has a regex in it.
  return TEMPLATE.replace("__VERSION__", () => JSON.stringify(version))
    .replace("__PREFIX__", () => JSON.stringify(SW_CACHE_PREFIX))
    .replace("__PRECACHE__", () => JSON.stringify(SW_PRECACHE))
    .replace("__OFFLINE__", () => JSON.stringify(offlinePage()))
    .replace("__PUSH_ICON__", () => JSON.stringify(PUSH_ICON))
    .replace("__PUSH_BADGE__", () => JSON.stringify(PUSH_BADGE));
}
