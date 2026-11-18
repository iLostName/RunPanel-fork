/**
 * What is at the root of a ZIP, read in the browser before anything is uploaded.
 *
 * The new project wizard recognises an app from its root file list and a few
 * manifests (`lib/app-detect.ts`). For a ZIP that means reading its central
 * directory: the list sits at the end of the file, so no upload and no full
 * extraction. The manifests are read and inflated with the platform's own
 * `DecompressionStream`.
 *
 * Like the upload route, a ZIP whose entries all sit in one top-level folder is
 * read from inside that folder (`progetto.zip → progetto/package.json`).
 *
 * Plain ZIP only (no ZIP64): the upload limit is 100 MB, far below where ZIP64
 * starts. Zero imports: the unit suite loads this file directly.
 */

export interface ZipListing {
  /** Names at the root, after unwrapping a single top-level folder. */
  files: string[];
  /** Contents of the requested files found at the root. */
  contents: Record<string, string>;
}

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_MANIFEST_BYTES = 200_000;

function findEndOfCentralDirectory(view: DataView): number {
  // The record is 22 bytes plus a comment of up to 65535.
  const lowest = Math.max(0, view.byteLength - 22 - 65_535);
  for (let i = view.byteLength - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function readEntries(buffer: ArrayBuffer): Entry[] {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("Il file non è un archivio ZIP valido");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: Entry[] = [];

  for (let i = 0; i < count; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The one folder every entry sits in, or null. Hidden macOS metadata does not count. */
function wrapperFolder(names: string[]): string | null {
  const meaningful = names.filter((n) => !n.startsWith("__MACOSX/") && n !== "");
  const tops = new Set(meaningful.map((n) => n.split("/")[0]));
  if (tops.size !== 1) return null;
  const [top] = [...tops];
  // A lone file is not a folder.
  return meaningful.some((n) => n.startsWith(`${top}/`)) ? `${top}/` : null;
}

async function inflate(data: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return data;
  if (method !== 8) throw new Error(`compressione ${method} non supportata`);
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(buffer: ArrayBuffer, entry: Entry): Promise<string | null> {
  const view = new DataView(buffer);
  const at = entry.localOffset;
  if (at + 30 > view.byteLength || view.getUint32(at, true) !== LOCAL_SIGNATURE) return null;
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > view.byteLength) return null;
  const raw = new Uint8Array(buffer, start, entry.compressedSize);
  const bytes = await inflate(raw, entry.method);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return null;
  return new TextDecoder().decode(bytes);
}

export async function listZipRoot(buffer: ArrayBuffer, wanted: readonly string[]): Promise<ZipListing> {
  const entries = readEntries(buffer);
  const wrapper = wrapperFolder(entries.map((e) => e.name));
  const rooted = entries
    .filter((e) => !e.name.startsWith("__MACOSX/"))
    .map((e) => ({ ...e, path: wrapper && e.name.startsWith(wrapper) ? e.name.slice(wrapper.length) : e.name }))
    .filter((e) => e.path !== "");

  const files = [...new Set(rooted.map((e) => e.path.split("/")[0]).filter(Boolean))];
  const contents: Record<string, string> = {};
  for (const name of wanted) {
    const entry = rooted.find((e) => e.path === name);
    if (!entry) continue;
    try {
      const text = await readEntry(buffer, entry);
      if (text !== null) contents[name] = text;
    } catch {
      /* an unreadable manifest only makes the guess vaguer */
    }
  }
  return { files, contents };
}
