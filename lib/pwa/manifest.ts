import type { MetadataRoute } from "next";
import { THEME_COLORS } from "../theme-mode";

/**
 * The web app manifest: what makes the panel installable, and what the
 * installed app looks like before a single page of it has loaded.
 *
 * Built here rather than inline in `app/manifest.ts` so a test can read it
 * without Next. The files it names live in `public/` and are made by
 * `scripts/build-pwa-assets.mjs` from `app/icon.svg`, except the screenshots,
 * which are captures of the real panel.
 *
 * - `start_url` is the overview. A browser that is not signed in is sent to the
 *   login page by the panel itself, as it would be from a bookmark.
 * - Dark colours, because dark is the panel's default palette. The manifest
 *   cannot follow the theme chosen in the panel; the `theme-color` in the page
 *   does (see app/layout.tsx), so the splash is the only moment in the wrong
 *   palette for whoever picked "Chiaro".
 * - `display_override` stops at `minimal-ui`: `window-controls-overlay` would
 *   draw the desktop window's buttons over the top bar, which is not built to
 *   be a title bar.
 * - `launch_handler` reuses the window that is already open, as a desktop app
 *   does, instead of opening a second panel next to the first.
 */

/** The narrow captures are 390×844 at 2x, the wide one 1440×900 at 1x. */
export const MANIFEST_SCREENSHOTS = [
  { src: "/screenshots/narrow-overview.webp", sizes: "780x1688", form_factor: "narrow", label: "La panoramica: progetti, database e salute del server" },
  { src: "/screenshots/narrow-projects.webp", sizes: "780x1688", form_factor: "narrow", label: "I progetti, con lo stato di ognuno" },
  { src: "/screenshots/wide-overview.webp", sizes: "1440x900", form_factor: "wide", label: "La panoramica su un monitor" },
] as const;

export function buildManifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "RunPanel",
    short_name: "RunPanel",
    description: "Metti online i tuoi progetti e tieni d'occhio database, backup e server da un unico pannello.",
    lang: "it",
    dir: "ltr",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: THEME_COLORS.dark,
    theme_color: THEME_COLORS.dark,
    categories: ["developer", "productivity", "utilities"],
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/monochrome-192.png", sizes: "192x192", type: "image/png", purpose: "monochrome" },
      { src: "/icons/monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
    ],
    screenshots: MANIFEST_SCREENSHOTS.map((shot) => ({ ...shot, type: "image/webp" })),
    shortcuts: [
      {
        name: "Progetti",
        url: "/projects",
        description: "La lista dei progetti",
        icons: [{ src: "/icons/shortcut-projects.png", sizes: "96x96", type: "image/png" }],
      },
      {
        name: "Backup",
        url: "/backups",
        description: "Pianificazioni, destinazioni e ultime esecuzioni",
        icons: [{ src: "/icons/shortcut-backups.png", sizes: "96x96", type: "image/png" }],
      },
      {
        name: "Nuovo progetto",
        short_name: "Nuovo",
        url: "/projects/new",
        description: "Metti online un progetto da GitHub o da uno ZIP",
        icons: [{ src: "/icons/shortcut-new.png", sizes: "96x96", type: "image/png" }],
      },
    ],
    launch_handler: { client_mode: ["navigate-existing", "auto"] },
  };
}
