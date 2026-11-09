import { createReporter } from "../harness.mjs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Lifting the single folder a zip unpacks into.
 *
 * Standalone: `services/flatten-root.ts` imports only `node:` modules. Failures
 * are forced by wrapping `fs.promises`, which the module reads at call time.
 */
export const meta = { name: "flatten-root-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("flatten-root-unit");
  const { flattenSingleRoot } = await import(pathToFileURL(join(repoRoot, "services", "flatten-root.ts")).href);

  const base = fs.mkdtempSync(join(tmpdir(), "rp-flatten-"));
  let counter = 0;
  const tree = (files) => {
    const dir = join(base, `case-${counter++}`, "staging");
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(join(dir, name, ".."), { recursive: true });
      fs.writeFileSync(join(dir, name), content);
    }
    return dir;
  };
  const list = (dir, prefix = "") =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? list(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
    );
  const siblings = (dir) => fs.readdirSync(join(dir, ".."));

  try {
    const django = tree({ "mysite/manage.py": "m", "mysite/mysite/settings.py": "s", "mysite/app/views.py": "v" });
    await flattenSingleRoot(django);
    r.check(
      "a root holding a child with its own name is lifted",
      list(django).sort().join() === "app/views.py,manage.py,mysite/settings.py",
      list(django).join()
    );
    r.check("the contents survive", fs.readFileSync(join(django, "mysite", "settings.py"), "utf8") === "s");
    r.check("nothing is left beside it", siblings(django).join() === "staging", siblings(django).join());

    const plain = tree({ "project-main/package.json": "{}", "project-main/src/index.js": "x" });
    await flattenSingleRoot(plain);
    r.check("an ordinary root is lifted", list(plain).sort().join() === "package.json,src/index.js", list(plain).join());

    const several = tree({ "a/x": "1", "b/y": "2" });
    await flattenSingleRoot(several);
    r.check("two folders stay where they are", list(several).sort().join() === "a/x,b/y");

    const single = tree({ "index.html": "x" });
    await flattenSingleRoot(single);
    r.check("a single file stays where it is", list(single).join() === "index.html");

    const hollow = join(base, "hollow", "staging");
    fs.mkdirSync(join(hollow, "only"), { recursive: true });
    await flattenSingleRoot(hollow);
    r.check("an empty root is lifted to an empty folder", fs.readdirSync(hollow).length === 0);

    // --- a failure leaves the tree as it found it -------------------------------
    const failing = async (name, nth, files) => {
      const dir = tree(files);
      const original = fs.promises[name];
      let calls = 0;
      fs.promises[name] = async (...args) => {
        if (++calls === nth) throw new Error(`forced ${name}`);
        return original(...args);
      };
      let error = null;
      try {
        await flattenSingleRoot(dir);
      } catch (err) {
        error = err;
      } finally {
        fs.promises[name] = original;
      }
      return { dir, error };
    };
    const files = { "mysite/manage.py": "m", "mysite/mysite/settings.py": "s" };
    const intact = "mysite/manage.py,mysite/mysite/settings.py";

    for (const [what, name, nth] of [
      ["the first move", "rename", 1],
      ["emptying the staging folder", "rmdir", 1],
      ["the final move", "rename", 2],
    ]) {
      const { dir, error } = await failing(name, nth, files);
      r.check(`a failure at ${what} is reported`, error?.message === `forced ${name}`, String(error));
      r.check(`a failure at ${what} leaves the tree whole`, list(dir).sort().join() === intact, list(dir).join());
      r.check(`a failure at ${what} leaves nothing beside it`, siblings(dir).join() === "staging", siblings(dir).join());
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  return r.result();
}
