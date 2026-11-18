/**
 * The S3-compatible services people actually use, with what each one wants.
 *
 * The form used to ask for an endpoint, a region and an "addressing style" up
 * front, which is three questions nobody can answer without the provider's
 * documentation open. Picking the provider fills them; the region is the only
 * one most people change, and the endpoint follows it.
 *
 * Shared by the form and the list: a stored destination only has its
 * endpoint, and "Backblaze B2 · runpanel-backups" is what the list should say.
 */

import { telegramWhere, type DestinationView } from "@/components/backups/types";

export type ProviderId = "aws" | "r2" | "b2" | "hetzner" | "wasabi" | "custom";

export interface Provider {
  label: string;
  region: string;
  endpoint: (region: string) => string;
  pathStyle: boolean;
  regionHint: string;
  note?: string;
  /** Recognises an endpoint as this provider's. */
  host?: RegExp;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  aws: {
    label: "Amazon S3",
    region: "eu-central-1",
    endpoint: (r) => `https://s3.${r}.amazonaws.com`,
    pathStyle: false,
    regionHint: "Per esempio eu-central-1 (Francoforte), eu-west-1 (Irlanda), eu-south-1 (Milano).",
    host: /(^|\.)amazonaws\.com$/i,
  },
  r2: {
    label: "Cloudflare R2",
    region: "auto",
    endpoint: () => "https://<account-id>.r2.cloudflarestorage.com",
    pathStyle: false,
    regionHint: "Con R2 resta «auto».",
    note: "Sostituisci <account-id> nell'endpoint con l'ID del tuo account: lo trovi nella pagina R2 di Cloudflare.",
    host: /\.r2\.cloudflarestorage\.com$/i,
  },
  b2: {
    label: "Backblaze B2",
    region: "eu-central-003",
    endpoint: (r) => `https://s3.${r}.backblazeb2.com`,
    pathStyle: false,
    regionHint: "È nella pagina del bucket, nell'endpoint: per esempio eu-central-003.",
    host: /\.backblazeb2\.com$/i,
  },
  hetzner: {
    label: "Hetzner Object Storage",
    region: "fsn1",
    endpoint: (r) => `https://${r}.your-objectstorage.com`,
    pathStyle: false,
    regionHint: "fsn1 (Falkenstein), nbg1 (Norimberga) o hel1 (Helsinki).",
    host: /\.your-objectstorage\.com$/i,
  },
  wasabi: {
    label: "Wasabi",
    region: "eu-central-1",
    endpoint: (r) => `https://s3.${r}.wasabisys.com`,
    pathStyle: false,
    regionHint: "Per esempio eu-central-1 (Amsterdam) o eu-south-1 (Milano).",
    host: /(^|\.)wasabisys\.com$/i,
  },
  custom: {
    label: "Altro (MinIO, Garage, un tuo server)",
    region: "us-east-1",
    endpoint: () => "",
    pathStyle: true,
    regionHint: "Molti server propri accettano qualsiasi valore: us-east-1 va bene.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "";
  }
}

/** Which provider a stored endpoint belongs to; anything unknown is "custom". */
export function detectProvider(endpoint: string): ProviderId {
  const host = hostOf(endpoint);
  if (!host) return "custom";
  return PROVIDER_IDS.find((id) => PROVIDERS[id].host?.test(host)) ?? "custom";
}

/** "Backblaze B2", or "S3 su minio.lan" for a server of one's own. */
export function providerLabel(endpoint: string): string {
  const id = detectProvider(endpoint);
  if (id !== "custom") return PROVIDERS[id].label;
  const host = hostOf(endpoint);
  return host ? `S3 su ${host}` : "S3";
}

/**
 * Where a destination writes, in a few words: "Disco di questo server",
 * "Cartella /mnt/usb, su questo server", "Backblaze B2 · bucket «runpanel»",
 * "Telegram · canale «RunPanel · backup di srv1»". A type this page does not
 * know yet is named by its type, so a new kind of destination shows up in
 * every list without waiting for its own words.
 */
export function describeDestination(destination: {
  type: string;
  target?: { endpoint: string; bucket: string } | null;
  directory?: string | null;
  telegram?: DestinationView["telegram"];
}): string {
  if (destination.type === "local") {
    return destination.directory ? `Cartella ${destination.directory}, su questo server` : "Disco di questo server";
  }
  if (destination.type === "s3") {
    return destination.target ? `${providerLabel(destination.target.endpoint)} · bucket «${destination.target.bucket}»` : "Archivio S3";
  }
  if (destination.type === "telegram") return telegramWhere(destination.telegram ?? null);
  return destination.type.charAt(0).toUpperCase() + destination.type.slice(1);
}
