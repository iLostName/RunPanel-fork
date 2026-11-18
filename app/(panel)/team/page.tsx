import { redirectToSection } from "@/lib/section-entry";

/** Team in the sidebar: the first of its tabs this account may open. */
export default async function TeamPage() {
  await redirectToSection("team");
}
