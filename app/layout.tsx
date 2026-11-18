import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Providers } from "@/components/Providers";
import { Background } from "@/components/Background";
import { getSetting } from "@/lib/settings";
import { ACCENT_SETTING_KEY, DEFAULT_ACCENT, resolveAccent } from "@/lib/themes";
import { THEME_BOOT_SCRIPT, THEME_COLORS, THEME_COOKIE, resolveThemeMode, serverPalette } from "@/lib/theme-mode";
import { EXPERT_COOKIE, resolveExpertMode } from "@/lib/expert-mode";
import { launchScreenLinks } from "@/lib/pwa/launch-screens";
import "./globals.css";

const sans = Geist({
  subsets: ["latin"],
  variable: "--font-app-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-app-mono",
  display: "swap",
});

/** The theme this browser chose, read from its cookie: see lib/theme-mode.ts. */
async function chosenTheme() {
  return resolveThemeMode((await cookies()).get(THEME_COOKIE)?.value);
}

/**
 * The page's head, including what an installed app reads from it.
 *
 * The manifest is linked by `app/manifest.ts`. iOS reads its own tags: the name
 * under the icon, the launch screens, and the status bar. `black-translucent`
 * lets the top bar run under the clock, which is what makes it look like an
 * app rather than a page — but its text is always white, so a panel set to
 * "Chiaro" asks for the plain bar instead, and the safe-area padding that the
 * translucent bar needs then comes out as zero by itself.
 *
 * `telephone=no`: iOS turns any run of digits into a phone link, and this panel
 * is full of ports and IP addresses.
 */
export async function generateMetadata(): Promise<Metadata> {
  const theme = await chosenTheme();
  return {
    title: {
      default: "RunPanel",
      template: "%s · RunPanel",
    },
    description: "Il pannello per mettere online i tuoi progetti sul tuo server.",
    applicationName: "RunPanel",
    appleWebApp: {
      capable: true,
      title: "RunPanel",
      statusBarStyle: theme === "light" ? "default" : "black-translucent",
      startupImage: launchScreenLinks(theme),
    },
    formatDetection: { telephone: false },
    // Next writes the standard tag; iOS before 17.4 still looks for its own.
    other: { "apple-mobile-web-app-capable": "yes" },
  };
}

/**
 * `viewport-fit=cover` hands the notch and the home indicator to the page, which
 * keeps clear of them with `env(safe-area-inset-*)` (globals.css).
 *
 * The `theme-color` matches the page behind the top bar in the palette this
 * browser chose; "Sistema" sends both and lets the media query decide, and a
 * switch made later is applied in place by `applyPalette`.
 */
export async function generateViewport(): Promise<Viewport> {
  const theme = await chosenTheme();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor:
      theme === "system"
        ? [
            { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
            { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
          ]
        : THEME_COLORS[serverPalette(theme)],
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolved on the server so the attribute is already correct in the first
  // paint — a client-side theme switch would flash the default preset first.
  // A store that is not reachable yet must not take the whole page down, so
  // fall back to the default rather than throwing.
  let accent = DEFAULT_ACCENT;
  try {
    accent = resolveAccent(await getSetting(ACCENT_SETTING_KEY));
  } catch {
    /* first run, or the store is still starting up */
  }

  const cookieStore = await cookies();
  const themeMode = resolveThemeMode(cookieStore.get(THEME_COOKIE)?.value);
  const palette = serverPalette(themeMode);
  const expert = resolveExpertMode(cookieStore.get(EXPERT_COOKIE)?.value);

  return (
    <html
      lang="it"
      className={`${palette === "dark" ? "dark " : ""}${sans.variable} ${mono.variable}`}
      data-accent={accent}
      data-theme={palette}
      data-theme-mode={themeMode}
      data-expert={expert ? "true" : "false"}
      suppressHydrationWarning
    >
      <head>
        {/* Before anything paints: resolves "Sistema" to the OS palette, which
            the server cannot know. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <Background />
        <Providers accent={accent} themeMode={themeMode} expert={expert}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
