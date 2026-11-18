import { redirectToSection } from "@/lib/section-entry";

/** Salute in the sidebar: the first of its tabs this account may open. */
export default async function HealthPage() {
  await redirectToSection("health");
}
