/**
 * Draws the installed app's pictures from app/icon.svg: the manifest icons
 * (plain, maskable and monochrome), the iOS home-screen icon, the shortcut
 * icons and the iOS launch screens.
 *
 * Run by hand after changing the logo, and commit what it writes:
 *
 *   node scripts/build-pwa-assets.mjs
 *
 * Not part of the build on purpose. The panel builds itself on the server it
 * runs on, and these pictures change once in a long while; a step that needs an
 * image library on every update would be a way for an update to fail over a
 * logo. `sharp` comes with Next as an optional dependency, which is why it is
 * not listed in package.json.
 *
 * The manifest screenshots (public/screenshots) are not made here: they are
 * captures of the real panel at phone and desktop size.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_SCREENS, launchScreenFile } from "../lib/pwa/launch-screens.ts";
import { THEME_COLORS } from "../lib/theme-mode.ts";

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("sharp is not installed: it comes with Next as an optional dependency (bun install).");
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(ROOT, "app/icon.svg"), "utf8");

// The logo is a blue rounded square with a white glyph on it. The glyph is
// everything after the first shape, so a redrawn logo keeps working as long as
// the background stays first.
const inner = source.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const background = inner.match(/<rect[^>]*fill="(#[0-9a-fA-F]{3,8})"[^>]*\/>/);
if (!background) throw new Error("app/icon.svg: the first shape should be the background rect");
const BRAND = background[1];
const glyph = inner.replace(background[0], "");

/** The glyph on a full square, scaled about the centre. 64 is the logo's own grid. */
function square({ fill, scale = 1, color = null }) {
  const art = color ? glyph.replaceAll("#fff", color) : glyph;
  const back = fill ? `<rect width="64" height="64" fill="${fill}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${back}<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${art}</g></svg>`;
}

async function png(svg, size, file, { flatten } = {}) {
  let image = sharp(Buffer.from(svg), { density: Math.max(72, (72 * size) / 64) }).resize(size, size);
  if (flatten) image = image.flatten({ background: flatten });
  const out = join(ROOT, file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, await image.png({ compressionLevel: 9, palette: true }).toBuffer());
  console.log(`  ${file}`);
}

console.log("icons");
// "any": the logo as it is, rounded corners and all.
for (const size of [192, 512]) await png(source, size, `public/icons/icon-${size}.png`);
// "maskable": Android cuts it to its own shape, keeping only the central circle
// of 80% — the glyph's corners sit at 41% of the side from the centre, so it
// is drawn at 80% to stay inside.
for (const size of [192, 512]) await png(square({ fill: BRAND, scale: 0.8 }), size, `public/icons/maskable-${size}.png`);
// "monochrome": only the shape counts, tinted by the system for themed icons.
for (const size of [192, 512]) await png(square({ fill: null, scale: 0.8 }), size, `public/icons/monochrome-${size}.png`);
// iOS rounds the corners itself and paints transparency black, so a full square.
await png(square({ fill: BRAND }), 180, "app/apple-icon.png", { flatten: BRAND });

console.log("shortcuts");
const solar = JSON.parse(readFileSync(join(ROOT, "node_modules/@iconify-json/solar/icons.json"), "utf8"));
const SHORTCUTS = { projects: "folder-linear", backups: "archive-linear", new: "add-circle-linear" };
for (const [name, icon] of Object.entries(SHORTCUTS)) {
  const body = solar.icons[icon]?.body;
  if (!body) throw new Error(`solar:${icon} not found`);
  // A 24-unit icon in the middle half of the square, white on the brand blue.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${BRAND}"/><g color="#fff" transform="translate(24 24) scale(2)">${body}</g></svg>`;
  await png(svg, 96, `public/icons/shortcut-${name}.png`);
}

console.log("launch screens");
for (const screen of LAUNCH_SCREENS) {
  const width = screen.width * screen.ratio;
  const height = screen.height * screen.ratio;
  // The logo at the size an app icon has on the home screen, a little over a
  // quarter of the width, so the launch reads as the icon growing into the app.
  const logo = Math.round(width * 0.28);
  const icon = await sharp(Buffer.from(source), { density: (72 * logo) / 64 }).resize(logo, logo).png().toBuffer();
  for (const scheme of ["dark", "light"]) {
    const file = `public${launchScreenFile(screen, scheme)}`;
    const out = join(ROOT, file);
    mkdirSync(dirname(out), { recursive: true });
    const image = await sharp({ create: { width, height, channels: 3, background: THEME_COLORS[scheme] } })
      .composite([{ input: icon, left: Math.round((width - logo) / 2), top: Math.round((height - logo) / 2) }])
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    writeFileSync(out, image);
    console.log(`  ${file}`);
  }
}
