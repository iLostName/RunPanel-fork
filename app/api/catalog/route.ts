import { NextResponse } from "next/server";
import { isDenied, requireUser } from "@/lib/auth-guard";
import { CATALOG, CATEGORY_LABEL, catalogCategories, catalogEntry } from "@/lib/app-catalog";

/**
 * The apps this server can install, with everything an install asks.
 *
 * The panel's own pages bundle the same list and do not call this; it is for
 * API and MCP clients, which need the questions and the compose file to fill
 * `POST /api/catalog/install` — and for whoever wants to read what a template
 * deploys before deciding. Nothing in it is a secret: templates are code.
 */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  return NextResponse.json({
    templates: CATALOG.map(catalogEntry),
    categories: catalogCategories().map((id) => ({ id, label: CATEGORY_LABEL[id] })),
  });
}
