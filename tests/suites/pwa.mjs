import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createReporter } from "../harness.mjs";

/**
 * The installable app as a browser meets it: the files it fetches before
 * anyone has signed in, and the tags in the page that point at them.
 *
 * The manifest, the worker and the icons must answer without a session — a
 * browser asks for them on the login page, and the proxy's floor only covers
 * `/api`. The worker must carry this build's id, since that is how an open app
 * learns the panel under it was updated, and must not be cached by anything
 * between the panel and the browser.
 */
export const meta = { name: "pwa", needsDocker: false, drivers: ["sqlite"] };

export async function run({ base, repoRoot }) {
  const r = createReporter("pwa");

  let res = await fetch(`${base}/manifest.webmanifest`);
  r.check("the manifest answers without a session", res.status === 200, `status ${res.status}`);
  r.check("as a web app manifest", (res.headers.get("content-type") ?? "").includes("application/manifest+json"), res.headers.get("content-type"));
  const manifest = await res.json().catch(() => null);
  r.check("named, standalone, starting on the overview", manifest?.name === "RunPanel" && manifest?.display === "standalone" && manifest?.start_url === "/home");

  res = await fetch(`${base}/sw.js`);
  const worker = await res.text();
  r.check("the service worker answers without a session", res.status === 200, `status ${res.status}`);
  r.check("as JavaScript", (res.headers.get("content-type") ?? "").includes("javascript"), res.headers.get("content-type"));
  r.check("and is never cached on the way", /no-store/.test(res.headers.get("cache-control") ?? ""), res.headers.get("cache-control"));
  const buildId = readFileSync(join(repoRoot, process.env.RUNPANEL_DIST_DIR || ".next", "BUILD_ID"), "utf8").trim();
  r.check("it carries this build's id", worker.includes(JSON.stringify(buildId)), buildId);

  for (const path of [manifest?.icons?.[0]?.src ?? "/icons/icon-192.png", "/icons/maskable-512.png", manifest?.screenshots?.[0]?.src, "/splash/1170x2532-dark.png"]) {
    if (!path) continue;
    res = await fetch(`${base}${path}`);
    r.check(`${path} is served`, res.status === 200 && /^image\//.test(res.headers.get("content-type") ?? ""), `${res.status} ${res.headers.get("content-type")}`);
  }

  // The login page is where an installed app lands without a session.
  res = await fetch(`${base}/login`);
  const html = await res.text();
  r.check("the page links the manifest", /<link rel="manifest" href="\/manifest\.webmanifest"/.test(html));
  r.check("it hands the notch and the home indicator to the page", /viewport-fit=cover/.test(html));
  r.check("it names the app for the iOS home screen", /apple-mobile-web-app-capable" content="yes"/.test(html) && /apple-mobile-web-app-title" content="RunPanel"/.test(html));
  const touchIcon = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)?.[1];
  r.check("it links the iOS icon", Boolean(touchIcon) && (await fetch(`${base}${touchIcon}`)).status === 200, touchIcon ?? "missing");
  const screens = [...html.matchAll(/<link href="([^"]+)" media="[^"]+" rel="apple-touch-startup-image"/g)].map((m) => m[1]);
  r.check("it links a dark launch screen per iPhone", screens.length === 12 && screens.every((url) => url.endsWith("-dark.png")), `${screens.length}`);
  r.check("iOS does not turn ports and addresses into phone links", /format-detection" content="telephone=no"/.test(html));
  r.check("dark by default: translucent status bar, dark theme-color", /status-bar-style" content="black-translucent"/.test(html) && /name="theme-color" content="#07080b"/.test(html));

  res = await fetch(`${base}/login`, { headers: { Cookie: "runpanel_theme=light" } });
  const light = await res.text();
  r.check(
    "light chosen: the plain status bar, whose text stays readable, and a light theme-color",
    /status-bar-style" content="default"/.test(light) && /name="theme-color" content="#f8f9fb"/.test(light)
  );
  res = await fetch(`${base}/login`, { headers: { Cookie: "runpanel_theme=system" } });
  const system = await res.text();
  r.check("'Sistema': one theme-color per scheme", (system.match(/name="theme-color"/g) ?? []).length === 2 && /prefers-color-scheme: light/.test(system));
  r.check("and both sets of launch screens, picked by the phone's scheme", (system.match(/rel="apple-touch-startup-image"/g) ?? []).length === 24);

  return r.result();
}
