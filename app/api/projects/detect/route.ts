import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { hasPermission } from "@/lib/authz";
import { githubToken, parseRepoSlug } from "@/lib/github";
import { isBranchName } from "@/lib/git-ref";
import { DETECT_FILES, detectApp, type DetectInput } from "@/lib/app-detect";

/**
 * What a repository is, before a project exists: the new project wizard's
 * "Cosa abbiamo trovato".
 *
 * Two sources. A GitHub repository is read through GitHub's API, root listing
 * and the few manifests `detectApp` looks at, without cloning anything. A ZIP is
 * read in the browser, which sends the same list and files. Either way the
 * recognition is `lib/app-detect.ts`, and the deploy pipeline still decides for
 * itself at build time.
 *
 * Read-only: nothing is created, cloned or stored.
 */

const MAX_FILE_BYTES = 200_000;

const bodySchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("github"),
    url: z.string().min(1).max(500),
    branch: z.string().max(255).optional(),
  }),
  z.object({
    source: z.literal("files"),
    files: z.array(z.string().max(255)).max(5000),
    contents: z.record(z.string(), z.string().max(MAX_FILE_BYTES)).optional(),
  }),
]);

function githubHeaders(token: string | null): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "RunPanel",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function POST(request: NextRequest) {
  const denied = await requirePermission("projects.create");
  if (isDenied(denied)) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Richiesta non valida", details: parsed.error.issues }, { status: 400 });
  }

  if (parsed.data.source === "files") {
    const contents: DetectInput["contents"] = {};
    for (const name of DETECT_FILES) {
      const value = parsed.data.contents?.[name];
      if (typeof value === "string") contents[name] = value;
    }
    return NextResponse.json({ supported: true, detection: detectApp({ files: parsed.data.files, contents }) });
  }

  const slug = parseRepoSlug(parsed.data.url);
  if (!slug) {
    return NextResponse.json({
      supported: false,
      reason: "In anticipo riconosciamo solo i repository su GitHub: questo lo riconosceremo al primo deploy.",
    });
  }
  const branch = parsed.data.branch?.trim() || "";
  if (branch && !isBranchName(branch)) {
    return NextResponse.json({ error: "Nome del branch non valido" }, { status: 400 });
  }

  // The panel's token reads private repositories, so only for whoever may use it.
  const token = hasPermission(denied.principal, "github") ? await githubToken() : null;
  const headers = githubHeaders(token);
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : "";

  let listing: Response;
  try {
    listing = await fetch(`https://api.github.com/repos/${slug.full}/contents${ref}`, { headers, cache: "no-store" });
  } catch {
    return NextResponse.json({ supported: true, error: "GitHub non risponde: riprova tra poco." });
  }
  if (listing.status === 404) {
    return NextResponse.json({
      supported: true,
      error: token
        ? "Repository o branch non trovato: controlla l'indirizzo e il nome del branch."
        : "Repository non trovato. Se è privato, collega prima GitHub dal pannello.",
    });
  }
  if (listing.status === 403 || listing.status === 429) {
    return NextResponse.json({
      supported: true,
      error: token
        ? "GitHub ha raggiunto il limite di richieste: riprova tra qualche minuto."
        : "GitHub limita le richieste senza un account collegato: collega GitHub o riprova tra poco.",
    });
  }
  if (!listing.ok) {
    return NextResponse.json({ supported: true, error: `GitHub ha risposto ${listing.status}: riprova tra poco.` });
  }

  const entries = (await listing.json().catch(() => [])) as { name?: unknown; type?: unknown; size?: unknown }[];
  const files = Array.isArray(entries) ? entries.flatMap((e) => (typeof e.name === "string" ? [e.name] : [])) : [];

  const contents: DetectInput["contents"] = {};
  await Promise.all(
    DETECT_FILES.filter((name) => files.includes(name)).map(async (name) => {
      try {
        const res = await fetch(`https://api.github.com/repos/${slug.full}/contents/${name}${ref}`, {
          headers: { ...headers, Accept: "application/vnd.github.raw+json" },
          cache: "no-store",
        });
        if (!res.ok) return;
        const text = await res.text();
        if (text.length <= MAX_FILE_BYTES) contents[name] = text;
      } catch {
        /* one manifest missing only makes the guess vaguer */
      }
    })
  );

  return NextResponse.json({ supported: true, repo: slug.full, detection: detectApp({ files, contents }) });
}
