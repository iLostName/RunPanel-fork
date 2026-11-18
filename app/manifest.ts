import type { MetadataRoute } from "next";
import { buildManifest } from "@/lib/pwa/manifest";

/** Served at /manifest.webmanifest and linked from every page; see lib/pwa/manifest.ts. */
export default function manifest(): MetadataRoute.Manifest {
  return buildManifest();
}
