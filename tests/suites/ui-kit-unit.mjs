import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The arithmetic behind the kit: gauge colours, sparkline points, expert mode.
 *
 * A gauge at 98% used to look like one at 10%; `meterTone` is what decides now,
 * and a sparkline that drew a gap as a drop to zero would lie about an outage.
 * Standalone: `lib/meter.ts` and `lib/expert-mode.ts` have no imports.
 */
export const meta = { name: "ui-kit-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("ui-kit-unit");
  const load = (file) => import(pathToFileURL(join(repoRoot, "lib", file)).href);
  const { meterTone, sparkPath } = await load("meter.ts");
  const { resolveExpertMode, expertCookie, EXPERT_COOKIE } = await load("expert-mode.ts");

  // --- gauges ------------------------------------------------------------------
  r.check("low usage is fine", meterTone(10) === "success" && meterTone(74.9) === "success");
  r.check("three quarters is a warning", meterTone(75) === "warning" && meterTone(89) === "warning");
  r.check("ninety is danger", meterTone(90) === "danger" && meterTone(100) === "danger");
  r.check("thresholds can be moved", meterTone(60, 50, 80) === "warning" && meterTone(85, 50, 80) === "danger");
  r.check("garbage is not an alarm", meterTone(Number.NaN) === "success");

  // --- sparklines ----------------------------------------------------------------
  const empty = sparkPath([], 100, 40);
  r.check("no data draws nothing", empty.line === "" && empty.last === null);

  const flat = sparkPath([5, 5, 5], 100, 40);
  r.check("a flat series is a line, not a division by zero", flat.line.split(" ").length === 3 && !flat.line.includes("NaN"));

  const low = sparkPath([4, 6], 100, 40);
  r.check("the scale starts at zero", low.min === 0);
  const percent = sparkPath([4, 6], 100, 40, 2, 100);
  r.check("with a ceiling, a small percentage stays near the bottom", percent.max === 100 && percent.last.y > 30, String(percent.last.y));

  const negative = sparkPath([-5, 5], 100, 40);
  r.check("a series that goes negative uses its own minimum", negative.min === -5);

  const gaps = sparkPath([1, null, 3], 100, 40, 0);
  const xs = gaps.line.split(" ").map((p) => Number(p.split(",")[0]));
  r.check("a gap is skipped, not drawn as zero", xs.length === 2 && xs[1] === 100, gaps.line);

  const one = sparkPath([7], 100, 40);
  r.check("a single value sits in the middle", one.last.x === 50);

  const bounded = sparkPath([0, 100, 50], 120, 36, 2);
  const inside = bounded.line.split(" ").every((p) => {
    const [x, y] = p.split(",").map(Number);
    return x >= 0 && x <= 120 && y >= 0 && y <= 36;
  });
  r.check("every point stays inside the box", inside, bounded.line);
  r.check("the area closes along the bottom", bounded.area.startsWith("2,36") && bounded.area.endsWith("118,36"), bounded.area);

  // --- expert mode -----------------------------------------------------------------
  r.check("expert mode is off unless asked for", resolveExpertMode(undefined) === false && resolveExpertMode("0") === false && resolveExpertMode("true") === false);
  r.check("an explicit 1 turns it on", resolveExpertMode("1") === true);
  r.check("the cookie remembers both choices", expertCookie(true).startsWith(`${EXPERT_COOKIE}=1;`) && expertCookie(false).startsWith(`${EXPERT_COOKIE}=0;`));
  r.check("the cookie is site-wide and lax", /path=\//.test(expertCookie(true)) && /samesite=lax/.test(expertCookie(true)));

  return r.result();
}
