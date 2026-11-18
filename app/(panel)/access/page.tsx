import { redirectToSection } from "@/lib/section-entry";

/** The old "Accessi" entry, kept so bookmarks land on its successor. */
export default async function AccessPage() {
  await redirectToSection("team");
}
