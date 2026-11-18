import { redirectToSection } from "@/lib/section-entry";

/**
 * Impostazioni in the sidebar: the panel's settings for whoever may change
 * them, their own account for everyone else.
 */
export default async function PreferencesPage() {
  await redirectToSection("settings");
}
