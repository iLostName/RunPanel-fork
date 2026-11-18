import { redirectToSection } from "@/lib/section-entry";

/** The old "Sistema" entry, kept so bookmarks land on its successor. */
export default async function SystemPage() {
  await redirectToSection("health");
}
