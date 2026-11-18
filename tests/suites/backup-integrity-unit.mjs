import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { gzipSync } from "node:zlib";

/**
 * Checking an archive is still what the panel wrote — on real zips.
 *
 * The archives are made by `writeArchive` itself, so what is checked is the
 * pair as it runs: a clean archive passes, a flipped byte fails the archive's
 * sha256, a member that changed fails its own checks, and a dump cut short —
 * which still checksums perfectly as its own short self — fails because it is
 * read to the end. That last one is the case a restore must never reach.
 */
export const meta = { name: "backup-integrity-unit", needsDocker: false, drivers: [], standalone: true };

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

export async function run({ repoRoot }) {
  const r = createReporter("backup-integrity-unit");
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);
  const { writeArchive } = await load("services", "backup", "archive.ts");
  const integrity = await load("services", "backup", "integrity.ts");

  const root = fs.mkdtempSync(join(os.tmpdir(), "runpanel-integrity-"));
  try {
    const stage = (entryPath, data, { precompressed = false, hashed = true } = {}) => {
      const absolutePath = join(root, "staging", entryPath);
      fs.mkdirSync(join(absolutePath, ".."), { recursive: true });
      fs.writeFileSync(absolutePath, data);
      return { absolutePath, entryPath, bytes: data.length, sha256: hashed ? sha256(data) : null, precompressed };
    };

    const sql = Buffer.from("CREATE TABLE t (id int);\n".repeat(4000));
    const dump = gzipSync(sql);
    const manifest = (runId) => ({
      schemaVersion: 1,
      runId,
      policyId: null,
      policyName: null,
      trigger: "manual",
      createdAt: new Date().toISOString(),
      panel: { version: "test", storeDriver: "sqlite" },
      artifacts: [],
    });

    const files = [
      stage("databases/pg/all.sql.gz", dump, { precompressed: true }),
      stage("projects/shop/config.enc.json", Buffer.from('{"v":"ciphertext"}')),
      stage("projects/shop/repo/index.js", Buffer.from("console.log('hi')\n"), { hashed: false }),
      stage("projects/shop/repo/lib/a.js", Buffer.from("export const a = 1;\n".repeat(200)), { hashed: false }),
    ];
    const archive = await writeArchive(join(root, "good.zip"), files, manifest("good"));

    // --- a clean archive ----------------------------------------------------
    {
      const report = await integrity.verifyArchiveFile(archive.absolutePath, { expectedSha256: archive.sha256 });
      r.check("a clean archive passes", report.ok, report.message);
      r.check("its sha256 is the one recorded", report.archiveMatches === true && report.archiveSha256 === archive.sha256);
      // Four files plus checksums.txt, LEGGIMI.txt and manifest.json.
      r.check("every member is opened", report.members?.checked === 7, String(report.members?.checked));
      r.check("the hashed ones are compared by sha256", report.members?.withSha256 === 2, String(report.members?.withSha256));
      r.check("the message says it is identical", /Identico/.test(report.message), report.message);
    }
    {
      const checksums = await integrity.readArchiveChecksums(archive.absolutePath);
      r.check("checksums.txt is read back", checksums.get("databases/pg/all.sql.gz") === sha256(dump), [...checksums.keys()].join(","));
      r.check("tree files are not listed in it", !checksums.has("projects/shop/repo/index.js"));
    }
    {
      const only = await integrity.verifyMembers(archive.absolutePath, { only: ["databases/pg/all.sql.gz"] });
      r.check("a restore checks only what it uses", only.checked === 1 && only.failures.length === 0, JSON.stringify(only));
      const tree = await integrity.verifyMembers(archive.absolutePath, { only: ["projects/shop/repo/"] });
      r.check("a repository is checked as a tree", tree.checked === 2 && tree.failures.length === 0, JSON.stringify(tree));
      const missing = await integrity.verifyMembers(archive.absolutePath, { only: ["databases/pg/other.sql.gz"] });
      r.check("a member asked for and missing fails", missing.failures.some((f) => /manca/.test(f.reason)), JSON.stringify(missing.failures));
    }

    // --- a flipped byte -------------------------------------------------------
    {
      const bytes = fs.readFileSync(archive.absolutePath);
      // Inside the stored dump: stored members keep their bytes as they are,
      // so the flip lands in data and not in a header.
      const at = bytes.indexOf(dump.subarray(100, 140));
      r.check("the dump is stored as is", at > 0);
      bytes[at + 5] ^= 0xff;
      const flipped = join(root, "flipped.zip");
      fs.writeFileSync(flipped, bytes);

      const withHash = await integrity.verifyArchiveFile(flipped, { expectedSha256: archive.sha256 });
      r.check("a flipped byte fails the archive's sha256", !withHash.ok && withHash.archiveMatches === false, withHash.message);
      const withoutHash = await integrity.verifyArchiveFile(flipped);
      r.check(
        "and without a recorded sha256 the member itself fails",
        !withoutHash.ok && withoutHash.members?.failures.some((f) => f.entryPath === "databases/pg/all.sql.gz"),
        JSON.stringify(withoutHash.members?.failures)
      );
      const message = integrity.memberFailureMessage(withoutHash.members?.failures ?? []);
      r.check("a restore says nothing was touched", /prima di toccare/.test(message), message);
    }

    // --- a dump cut short, consistently checksummed ----------------------------
    {
      const truncated = dump.subarray(0, Math.floor(dump.length / 2));
      const cut = await writeArchive(
        join(root, "cut.zip"),
        [stage("databases/pg/cut.sql.gz", truncated, { precompressed: true })],
        manifest("cut")
      );
      const report = await integrity.verifyArchiveFile(cut.absolutePath, { expectedSha256: cut.sha256 });
      r.check("the archive itself is intact", report.archiveMatches === true);
      r.check(
        "but a truncated dump is caught by reading it to the end",
        !report.ok && report.members?.failures.some((f) => /troncato/.test(f.reason)),
        JSON.stringify(report.members?.failures)
      );
    }

    // --- not a zip at all ------------------------------------------------------
    {
      const junk = join(root, "junk.zip");
      fs.writeFileSync(junk, "this is not a zip");
      const report = await integrity.verifyArchiveFile(junk);
      r.check("a file that is not a zip fails, without throwing", !report.ok && /zip/.test(report.message), report.message);
    }

    // --- remote archives, by their stream -------------------------------------
    {
      const good = await integrity.verifyArchiveStream(fs.createReadStream(archive.absolutePath), archive.sha256);
      r.check("a streamed archive with the recorded sha256 passes", good.ok && good.archiveMatches === true, good.message);
      const bad = await integrity.verifyArchiveStream(fs.createReadStream(archive.absolutePath), "0".repeat(64));
      r.check("a streamed archive with another sha256 fails", !bad.ok && bad.archiveMatches === false);
      const none = await integrity.verifyArchiveStream(fs.createReadStream(archive.absolutePath), null);
      r.check("with no recorded sha256 it says so rather than pass silently", none.archiveMatches === null && /non è stato registrato/.test(none.message));
    }

    // --- checksums.txt parsing ------------------------------------------------
    {
      const map = integrity.parseChecksums(`${"a".repeat(64)}  x/y.gz\n${"B".repeat(64)} *z.bin\nnot a line\n\n`);
      r.check("both sha256sum formats are read", map.get("x/y.gz") === "a".repeat(64) && map.get("z.bin") === "b".repeat(64));
      r.check("anything else is ignored", map.size === 2);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return r.result();
}
