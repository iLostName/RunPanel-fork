import { createReporter } from "../harness.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Reading a ZIP's root in the browser, before uploading it.
 *
 * The wizard recognises the app from this list; it has to agree with what the
 * upload route will unpack, single wrapper folder included. Built with yazl,
 * which the panel already uses to write its own archives.
 */
export const meta = { name: "zip-listing-unit", needsDocker: false, drivers: [], standalone: true };

function zipBuffer(yazl, files) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content, compress] of files) {
      if (name.endsWith("/")) zip.addEmptyDirectory(name.slice(0, -1));
      else zip.addBuffer(Buffer.from(content), name, { compress: compress !== false });
    }
    zip.end();
    const chunks = [];
    zip.outputStream.on("data", (c) => chunks.push(c));
    zip.outputStream.on("end", () => {
      const buf = Buffer.concat(chunks);
      resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    });
    zip.outputStream.on("error", reject);
  });
}

export async function run({ repoRoot }) {
  const r = createReporter("zip-listing-unit");
  const require = createRequire(join(repoRoot, "package.json"));
  const yazl = require("yazl");
  const { listZipRoot } = await import(pathToFileURL(join(repoRoot, "lib", "zip-listing.ts")).href);
  const pkg = JSON.stringify({ dependencies: { next: "15" }, scripts: { build: "next build" } });

  const flat = await listZipRoot(await zipBuffer(yazl, [
    ["package.json", pkg],
    ["src/index.ts", "x"],
    ["Dockerfile", "FROM node:22\nEXPOSE 3000\n", false],
  ]), ["package.json", "Dockerfile"]);
  r.check("root names are listed once", JSON.stringify(flat.files.sort()) === JSON.stringify(["Dockerfile", "package.json", "src"]), flat.files.join(","));
  r.check("a deflated manifest is inflated", flat.contents["package.json"] === pkg);
  r.check("a stored manifest is read as is", flat.contents.Dockerfile?.includes("EXPOSE 3000") === true);

  const wrapped = await listZipRoot(await zipBuffer(yazl, [
    ["progetto/package.json", pkg],
    ["progetto/public/index.html", "<h1>x</h1>"],
    ["__MACOSX/progetto/._package.json", "junk"],
  ]), ["package.json"]);
  r.check("a single wrapper folder is opened, like the upload route", JSON.stringify(wrapped.files.sort()) === JSON.stringify(["package.json", "public"]), wrapped.files.join(","));
  r.check("and its manifest is found inside", wrapped.contents["package.json"] === pkg);

  const lone = await listZipRoot(await zipBuffer(yazl, [["index.html", "<h1>x</h1>"]]), []);
  r.check("a lone file is not taken for a folder", JSON.stringify(lone.files) === JSON.stringify(["index.html"]));

  let threw = null;
  try {
    await listZipRoot(new TextEncoder().encode("not a zip at all").buffer, []);
  } catch (err) {
    threw = err;
  }
  r.check("garbage is refused in Italian", threw instanceof Error && /non è un archivio ZIP/.test(threw.message));

  return r.result();
}
