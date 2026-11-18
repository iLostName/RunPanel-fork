import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The uptime check without an app to ask: what counts as an answer, when a run
 * of failed requests becomes an incident and when it ends, and how the result
 * is said on the project page.
 *
 * The incident rule is the one that has to be right: an app that answers one
 * request in three must not send a "down" and an "up" every other minute, and
 * an incident's length has to be what its users saw, not what the hysteresis
 * added to it.
 */
export const meta = { name: "uptime-unit", needsDocker: false, drivers: [], standalone: true };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export async function run({ repoRoot }) {
  const r = createReporter("uptime-unit");
  const u = await import(pathToFileURL(join(repoRoot, "lib", "uptime-math.ts")).href);

  // --- one answer ---------------------------------------------------------------------
  r.check("a 200 is up", u.judgeStatus(200, []).ok);
  r.check("a login wall is an app answering", u.judgeStatus(401, []).ok && u.judgeStatus(404, []).ok);
  r.check("a redirect is an app answering", u.judgeStatus(302, []).ok);
  r.check("a 502 is down, and says so", !u.judgeStatus(502, []).ok && u.judgeStatus(502, []).cause === "status:502");
  r.check("an expected status is exactly that", u.judgeStatus(204, [204]).ok && !u.judgeStatus(200, [204]).ok);

  r.check("an abort is a timeout", u.causeOfError({ name: "AbortError" }) === "timeout");
  r.check("a refused connection", u.causeOfError({ name: "TypeError", cause: { code: "ECONNREFUSED" } }) === "refused");
  r.check("a reset connection", u.causeOfError({ cause: { code: "ECONNRESET" } }) === "reset");
  r.check("anything else is an error", u.causeOfError(new Error("boom")) === "error" && u.causeOfError(null) === "error");

  r.check("the timeout in words", u.causeLabel("timeout", 5000).includes("5 secondi"));
  r.check("a server error in words", u.causeLabel("status:503").includes("HTTP 503") && u.causeLabel("status:503").includes("errore"));
  r.check("an unexpected status in words", u.causeLabel("status:404").includes("attesa"));
  r.check("no cause is still a sentence", u.causeLabel(null).length > 0 && u.causeLabel("whatever").length > 0);

  // --- from checks to incidents ------------------------------------------------------
  {
    const feed = (results, state = u.initialUptimeState()) => {
      const events = [];
      results.forEach((ok, i) => {
        const out = u.stepUptime(state, { ok, at: i * MIN, cause: ok ? null : "timeout" });
        state = out.state;
        if (out.event) events.push(out.event);
      });
      return { state, events };
    };

    r.check("one failed request is not an incident", feed([true, false, true, true]).events.length === 0);

    const down = feed([true, false, false]);
    r.check("two in a row are", down.events.length === 1 && down.events[0].kind === "down" && down.state.down);
    r.check("the incident starts at the first failure", down.events[0].startedAt === 1 * MIN);
    r.check("the incident keeps its cause", down.events[0].cause === "timeout");

    const back = feed([false, false, true, true]);
    r.check(
      "and ends after two answers",
      back.events.map((e) => e.kind).join(",") === "down,up" && !back.state.down,
      JSON.stringify(back.events)
    );
    r.check("at the first of them", back.events[1]?.endedAt === 2 * MIN);

    const flaky = feed(Array.from({ length: 30 }, (_, i) => i < 2 ? false : i % 3 === 0));
    r.check(
      "an app answering one request in three stays down, it does not flap",
      flaky.events.length === 1 && flaky.state.down,
      JSON.stringify(flaky.events)
    );

    const resumed = feed([true, true], u.initialUptimeState(true));
    r.check("an incident left open by a restart closes on the next answers", resumed.events[0]?.kind === "up");
  }

  // --- saying it --------------------------------------------------------------------------
  r.check("nothing checked has no ratio", u.uptimeRatio(0, 0) === null);
  r.check("ratio", u.uptimeRatio(1439, 1440) === 1439 / 1440);
  r.check("four minutes down in a day is not 100%", u.formatUptimePercent(1436 / 1440) === "99,72%", u.formatUptimePercent(1436 / 1440));
  r.check("99.996 is not rounded up to 100", u.formatUptimePercent(0.99996) === "99,99%", u.formatUptimePercent(0.99996));
  r.check("everything answered is 100%", u.formatUptimePercent(1) === "100%");
  r.check("no ratio is a dash", u.formatUptimePercent(null) === "—");

  r.check("days", u.durationWords(12 * DAY + 3600_000) === "12 giorni");
  r.check("one day", u.durationWords(DAY) === "1 giorno");
  r.check("hours", u.durationWords(3 * 3600_000) === "3 ore" && u.durationWords(3600_000) === "1 ora");
  r.check("minutes", u.durationWords(5 * MIN) === "5 minuti" && u.durationWords(30_000) === "meno di un minuto");
  r.check("an incident's length", u.shortDuration(72 * MIN) === "1 h 12 min" && u.shortDuration(4 * MIN) === "4 min");
  r.check("a long one", u.shortDuration(2 * DAY + 3 * 3600_000) === "2 g 3 h");

  // --- since when -----------------------------------------------------------------------
  {
    const now = 100 * DAY;
    const minute = (ts, up = 1) => ({ ts, size: MIN, up });
    const quarter = (ts, up = 1) => ({ ts, size: 15 * MIN, up });

    const steady = [];
    for (let ts = now - 60 * MIN; ts < now; ts += MIN) steady.push(minute(ts));
    const s = u.upSince(steady, now);
    r.check("answering for as long as remembered", s?.atLeast === true && s.at === now - 60 * MIN, JSON.stringify(s));

    const withFailure = steady.map((b) => (b.ts === now - 20 * MIN ? { ...b, up: 0 } : b));
    const f = u.upSince(withFailure, now);
    r.check("since the end of the last failure", f?.atLeast === false && f.at === now - 19 * MIN, JSON.stringify(f));

    const gap = [...steady.filter((b) => b.ts >= now - 10 * MIN), ...[quarter(now - 5 * 60 * MIN)]];
    const g = u.upSince(gap, now);
    r.check("since the end of a silence", g?.at === now - 10 * MIN && !g.atLeast, JSON.stringify(g));

    r.check("an app failing right now is not up", u.upSince([minute(now - MIN, 0)], now) === null);
    r.check("no data, no claim", u.upSince([], now) === null);
    r.check("old data is not a claim about now", u.upSince([minute(now - 3 * 60 * MIN)], now) === null);
  }
  {
    const now = Date.UTC(2026, 10, 18, 12, 0);
    const days = u.dailyRatios(
      [
        { ts: now - 60 * MIN, up: 1, n: 30 },
        { ts: now - 30 * MIN, up: 0.5, n: 30 },
        { ts: now - 2 * DAY, up: 1, n: 15 },
      ],
      30,
      now,
      0
    );
    r.check("thirty days", days.length === 30);
    r.check("today mixes its buckets by weight", days[29].ratio === 0.75, String(days[29].ratio));
    r.check("a day without checks is unknown, not down", days[28].ratio === null && days[27].ratio === 1);
  }

  return r.result();
}
