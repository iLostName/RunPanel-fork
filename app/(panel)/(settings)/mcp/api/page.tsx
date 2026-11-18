import { ROUTES } from "@/services/mcp/catalog";
import { ApiReference } from "./ApiReference";

/**
 * The REST API, every endpoint a token can call — read from the same catalog
 * the MCP server hands an AI assistant (`services/mcp/catalog.ts`), so the
 * page cannot drift from what the panel actually serves: `mcp-catalog-unit`
 * fails the build when a route and its entry disagree.
 *
 * A server component only to pass the catalog in as data: the client part
 * does the searching.
 */
export default function ApiReferencePage() {
  return <ApiReference routes={ROUTES} />;
}
