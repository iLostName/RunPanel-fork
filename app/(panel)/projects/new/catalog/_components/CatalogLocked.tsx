import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Why the catalogue is closed to this account. Both permissions are the
 * server's own rule (`POST /api/catalog/install`): a Compose project reaches
 * the host, as a repository or an uploaded ZIP does.
 */
export function CatalogLocked({ missing }: { missing: "projects.create" | "host" }) {
  return (
    <EmptyState
      icon="solar:lock-linear"
      title="Non puoi installare app"
      description={
        missing === "projects.create"
          ? "Serve il permesso «Creare progetti»: chiedilo a chi gestisce il pannello."
          : "Serve il permesso «Accesso all'host»: un'app del catalogo gira come uno stack Compose, che arriva al server. Chiedilo a chi gestisce il pannello."
      }
    />
  );
}
