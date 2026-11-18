import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The metrics history without a host to measure: what the collector reads out
 * of `docker stats` and `/proc`, how samples are condensed and purged, what a
 * chart is handed, and when CPU or memory becomes an alarm.
 *
 * The roll-ups and the purge are the part worth a test rather than a read: a
 * purge that ran ahead of the roll-up would punch a hole in every chart, and
 * an average that counted a missing reading as zero would draw a dip at every
 * gap. The alarm is the other: a threshold without hysteresis alternates
 * warning and all-clear for as long as a machine sits on it.
 */
export const meta = { name: "metrics-unit", needsDocker: false, drivers: [], standalone: true };

const MIN = 60_000;
const HOUR = 60 * MIN;

export async function run({ repoRoot }) {
  const r = createReporter("metrics-unit");
  const m = await import(pathToFileURL(join(repoRoot, "lib", "metrics-math.ts")).href);

  const sample = (ts, values = {}, extra = {}) => ({
    scope: "host",
    subject_id: "host",
    ts,
    n: 1,
    ...m.emptyValues(),
    ...values,
    ...extra,
  });

  // --- buckets and roll-ups --------------------------------------------------------
  r.check("a bucket starts on its boundary", m.bucketStart(125_000, MIN) === 120_000);
  r.check("raw samples have no bucket", m.bucketStart(125_000, 0) === 125_000);

  {
    const rows = [sample(0, { cpu: 10 }), sample(30_000, { cpu: 30 }), sample(60_000, { cpu: 50 })];
    const out = m.rollup(rows, MIN);
    r.check("two minutes from three samples", out.length === 2, JSON.stringify(out.map((o) => o.ts)));
    r.check("a minute is the average of its samples", out[0].cpu === 20 && out[0].n === 2, JSON.stringify(out[0]));
    r.check("each minute keeps its own samples", out[1].cpu === 50 && out[1].n === 1);
  }
  {
    // A quarter built from a minute of two samples and a minute of one.
    const rows = [sample(0, { cpu: 10 }, { n: 2 }), sample(MIN, { cpu: 40 }, { n: 1 })];
    const [out] = m.rollup(rows, 15 * MIN);
    r.check("roll-ups weigh by the samples behind them", out.cpu === 20 && out.n === 3, JSON.stringify(out));
  }
  {
    const rows = [sample(0, { cpu: 10, net_rx: null }), sample(30_000, { cpu: 20, net_rx: 100 })];
    const [out] = m.rollup(rows, MIN);
    r.check("a missing value is not a zero", out.net_rx === 100, String(out.net_rx));
    r.check("a field nobody measured stays empty", out.disk === null);
  }
  {
    const rows = [sample(0, { cpu: 10 }), { ...sample(0, { cpu: 90 }), subject_id: "other" }];
    r.check("subjects are condensed apart", m.rollup(rows, MIN).length === 2);
  }

  // --- what may be rolled up, and what may go ---------------------------------------
  {
    const now = 10 * MIN + 30_000;
    const w = m.rollupWindow(5 * MIN, null, MIN, now);
    r.check("the window starts after the last bucket done", w?.from === 6 * MIN, JSON.stringify(w));
    r.check("the window ends at the last bucket closed", w?.to === 10 * MIN, JSON.stringify(w));
    r.check(
      "a bucket that just closed waits for the late samples",
      m.rollupWindow(9 * MIN, null, MIN, 10 * MIN + 5_000) === null
    );
    const empty = m.rollupWindow(null, 3 * MIN + 12_000, MIN, now);
    r.check("an empty tier starts from the oldest sample", empty?.from === 3 * MIN, JSON.stringify(empty));
    r.check("nothing to read, nothing to roll", m.rollupWindow(null, null, MIN, now) === null);
  }
  {
    const now = 100 * HOUR;
    r.check("raw samples go after about an hour", m.purgeCutoff(m.TIER_RAW, now, now) === now - m.KEEP_MS[m.TIER_RAW]);
    const behind = now - 3 * HOUR;
    r.check(
      "raw samples nobody rolled up stay",
      m.purgeCutoff(m.TIER_RAW, behind, now) === behind,
      String(now - m.purgeCutoff(m.TIER_RAW, behind, now))
    );
    r.check(
      "…but not for ever",
      m.purgeCutoff(m.TIER_RAW, now - 48 * HOUR, now) === now - m.HARD_KEEP_MS[m.TIER_RAW]
    );
    r.check("the coarsest tier goes after a month", m.purgeCutoff(m.TIER_QUARTER, null, now) === now - 31 * 24 * HOUR);
    r.check("each tier outlives the window it is read for", m.KEEP_MS[m.TIER_RAW] > HOUR && m.KEEP_MS[m.TIER_MINUTE] > 24 * HOUR);
  }

  // --- what a chart is handed ---------------------------------------------------------
  {
    r.check("ranges are known", m.isMetricRange("24h") && !m.isMetricRange("2h") && !m.isMetricRange(undefined));
    r.check("a day reads the minutes, then the raw tail", JSON.stringify(m.tiersFor("24h")) === JSON.stringify([m.TIER_MINUTE, m.TIER_RAW]));
    r.check("a week reads all three", m.tiersFor("7d").length === 3 && m.tiersFor("1h").length === 1);

    const now = 30 * 24 * HOUR;
    const rows = [];
    for (let ts = now - 25 * HOUR; ts <= now; ts += MIN) rows.push(sample(ts, { cpu: 5, mem: 100 }, { n: 2 }));
    const day = m.toSeries(rows, "24h", now, ["cpu", "mem", "disk"]);
    r.check("a day is a few hundred points", day.t.length >= 288 && day.t.length <= 290, String(day.t.length));
    r.check(
      "a day keeps its range, starting on the first bucket",
      day.from === m.bucketStart(now - 24 * HOUR, 5 * MIN) && day.t[0] >= day.from && day.to === now,
      JSON.stringify({ from: day.from, first: day.t[0] })
    );
    r.check("a field with nothing in it is left out", day.series.disk === undefined && day.series.cpu?.length === day.t.length);
    r.check("the step is the range's", day.step === 5 * MIN);

    const hour = m.toSeries(rows.slice(-61), "1h", now, ["cpu"]);
    r.check("an hour goes out as sampled", hour.step === m.SAMPLE_INTERVAL_MS && hour.t.length === 61, String(hour.t.length));
  }

  // --- rates and shares -------------------------------------------------------------
  r.check("bytes per second", m.ratePerSecond({ value: 1000, at: 0 }, { value: 4000, at: 30_000 }) === 100);
  r.check("no earlier reading, no rate", m.ratePerSecond(undefined, { value: 1, at: 1 }) === null);
  r.check("a restarted counter is not negative traffic", m.ratePerSecond({ value: 5000, at: 0 }, { value: 10, at: 30_000 }) === null);
  r.check("readings too far apart say nothing", m.ratePerSecond({ value: 0, at: 0 }, { value: 10, at: HOUR }) === null);
  r.check("a busy four-core host is not at 350%", m.shareOfHost(350, 4) === 87.5);
  r.check("no reading, no share", m.shareOfHost(undefined, 4) === null);
  r.check("a share never passes the host", m.shareOfHost(900, 4) === 100);
  r.check("percent of a whole", m.percentOf(25, 200) === 12.5 && m.percentOf(1, 0) === null);

  // --- what the host prints -----------------------------------------------------------
  {
    r.check("binary units", m.parseByteSize("1.5GiB") === 1.5 * 1024 ** 3);
    r.check("decimal units, lower-case k", m.parseByteSize("764kB") === 764_000);
    r.check("zero is a size", m.parseByteSize("0B") === 0);
    r.check("garbage is not a size", m.parseByteSize("--") === null && m.parseByteSize(undefined) === null);

    const stats = m.parseDockerStats(
      [
        JSON.stringify({ Name: "runpanel-shop", CPUPerc: "150.25%", MemUsage: "256MiB / 1GiB", MemPerc: "25.00%", NetIO: "1.2MB / 340kB" }),
        JSON.stringify({ Name: "--", CPUPerc: "0%", MemUsage: "0B / 0B", MemPerc: "0%", NetIO: "0B / 0B" }),
        "\u001b[2J",
        "not json",
        "",
      ].join("\n")
    );
    const shop = stats.get("runpanel-shop");
    r.check("one container read", stats.size === 1, String(stats.size));
    r.check("cpu as printed", shop?.cpu === 150.25);
    r.check("memory and its limit", shop?.mem === 256 * 1024 ** 2 && shop?.memLimit === 1024 ** 3);
    r.check("memory against the limit", shop?.memPct === 25);
    r.check("network both ways", shop?.netRx === 1_200_000 && shop?.netTx === 340_000);
  }
  {
    const route = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
      "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    ].join("\n");
    r.check("the default route's interface", JSON.stringify(m.defaultRouteInterfaces(route)) === '["eth0"]');

    const dev = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 999 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0",
      "  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0",
      "docker0: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0",
      "vethab12: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0",
    ].join("\n");
    const only = m.parseNetDev(dev, ["eth0"]);
    r.check("only the interfaces asked for", only?.rx === 1000 && only?.tx === 2000, JSON.stringify(only));
    const physical = m.parseNetDev(dev);
    r.check("bridges and veths are not counted twice", physical?.rx === 1000 && physical?.tx === 2000, JSON.stringify(physical));
    r.check("nothing readable, nothing returned", m.parseNetDev("garbage") === null);
  }

  // --- the alarm ------------------------------------------------------------------------
  {
    const step = m.SAMPLE_INTERVAL_MS;
    const feed = (values, start = 0, state = m.initialAlertState()) => {
      const events = [];
      values.forEach((value, i) => {
        const out = m.stepAlert(state, value, start + i * step);
        state = out.state;
        if (out.event) events.push({ ...out.event, at: start + i * step });
      });
      return { state, events };
    };

    const four = feed(Array(9).fill(95));
    r.check("four and a half minutes high is not an alarm", four.events.length === 0 && !four.state.firing);

    const five = feed(Array(11).fill(95));
    r.check("five minutes high is", five.events.length === 1 && five.events[0].kind === "fire", JSON.stringify(five.events));
    r.check("the alarm dates from the first high reading", five.events[0]?.since === 0);

    const dip = feed([...Array(8).fill(95), 85, ...Array(8).fill(95)]);
    r.check("one reading under the line restarts the count", dip.events.length === 0);

    const hover = feed(Array.from({ length: 200 }, (_, i) => (i < 11 ? 95 : i % 2 ? 91 : 85)));
    r.check(
      "a machine hovering on the line sends one alarm, not one a minute",
      hover.events.length === 1 && hover.state.firing,
      JSON.stringify(hover.events.map((e) => e.kind))
    );

    const recover = feed([...Array(11).fill(95), ...Array(11).fill(70)]);
    r.check(
      "back under 80% for five minutes is an all-clear",
      recover.events.map((e) => e.kind).join(",") === "fire,clear",
      JSON.stringify(recover.events)
    );
    r.check("the all-clear knows how high it went", recover.events[1]?.peak === 95);

    const gap = feed([95, 95, 95, 95, 95, null, 95, 95, 95, 95, 95, 95]);
    r.check("a reading that is missing breaks the streak", gap.events.length === 0, JSON.stringify(gap.events));

    let state = m.initialAlertState();
    state = m.stepAlert(state, 95, 0).state;
    state = m.stepAlert(state, 95, 10 * MIN).state;
    const late = m.stepAlert(state, 95, 10 * MIN + step);
    r.check("readings far apart are not a streak", late.event === null && !late.state.firing);

    const stopped = feed([...Array(11).fill(95), null, null, null]);
    r.check("a project that stopped is not back to normal", stopped.state.firing && stopped.events.length === 1);

    // Load in waves: five minutes high, five normal, over and over.
    let damper = { silent: false, quietUntil: 0 };
    const said = [];
    for (const [kind, at] of [["fire", 0], ["clear", 10], ["fire", 20], ["clear", 30], ["fire", 45], ["clear", 55]]) {
      const event = kind === "fire" ? { kind, since: at * MIN, value: 95 } : { kind, since: (at - 10) * MIN, value: 70, peak: 95 };
      const verdict = m.dampAlert(damper, event, at * MIN);
      damper = verdict.damper;
      if (verdict.announce) said.push(`${kind}@${at}`);
    }
    r.check(
      "waves of load are told in pairs, one per half hour",
      said.join(",") === "fire@0,clear@10,fire@45,clear@55",
      said.join(",")
    );
  }
  {
    const stats = m.parseDockerStats(`\u001b[H${JSON.stringify({ Name: "a", CPUPerc: "1%", MemUsage: "1MiB / 2MiB", MemPerc: "50%", NetIO: "0B / 0B" })}`);
    r.check("a cursor code in front of the first row does not lose it", stats.get("a")?.memPct === 50);
  }

  // --- scales -----------------------------------------------------------------------------
  {
    const pct = m.niceScale([3, 6], { ceiling: 100 });
    r.check("a percentage keeps its ceiling", pct.max === 100 && pct.ticks.at(-1) === 100 && pct.ticks[0] === 0);
    const auto = m.niceScale([0, 37, 12]);
    r.check("the top is the next round number", auto.max === 40, JSON.stringify(auto));
    r.check("an empty series still has an axis", m.niceScale([null, 0]).max === 1);
    const bytes = m.niceBytesScale([300 * 1024 ** 2, 412 * 1024 ** 2]);
    r.check(
      "byte ticks land on round binary units",
      bytes.ticks.every((t) => (t / 1024 ** 2) % 50 === 0) && bytes.max >= 412 * 1024 ** 2,
      JSON.stringify(bytes.ticks.map((t) => t / 1024 ** 2))
    );
  }
  {
    const from = Date.UTC(2026, 10, 18, 10, 7);
    const { ticks, step } = m.timeTicks(from, from + HOUR, 4, 0);
    r.check("an hour is labelled every quarter", step === 15 * MIN, String(step));
    r.check("labels land on round times", ticks.every((t) => t % (15 * MIN) === 0) && ticks.length >= 3, JSON.stringify(ticks));
    const rome = m.timeTicks(from, from + 24 * HOUR, 4, -60);
    r.check(
      "a day is labelled on round local hours",
      rome.ticks.every((t) => ((t + HOUR) / HOUR) % 6 === 0),
      JSON.stringify(rome.ticks.map((t) => new Date(t).toISOString()))
    );
  }
  {
    const rows = [
      { name: "beta", cpu: 5, memory: 100 },
      { name: "Alfa", cpu: 50, memory: 10 },
      { name: "gamma", cpu: undefined, memory: undefined },
      { name: "delta", cpu: 5, memory: 300 },
    ];
    const names = (sort) => m.sortByUsage(rows, sort).map((row) => row.name).join(",");
    r.check("by name, ignoring case", names("name") === "Alfa,beta,delta,gamma", names("name"));
    r.check("by CPU, ties by name, no reading last", names("cpu") === "Alfa,beta,delta,gamma", names("cpu"));
    r.check("by memory", names("memory") === "delta,beta,Alfa,gamma", names("memory"));
    r.check("sorting leaves the list alone", rows[0].name === "beta");

    const down = m.downsample([1, 3, null, null, 5, 7], 3);
    r.check("a sparkline averages its buckets and keeps the gaps", JSON.stringify(down) === "[2,null,6]", JSON.stringify(down));
    r.check("a short series is not stretched", m.downsample([1, 2], 30).length === 2);
  }
  {
    const s = m.summarize([null, 4, 10, undefined, 1]);
    r.check("min, max, average, last", s?.min === 1 && s?.max === 10 && s?.avg === 5 && s?.last === 1, JSON.stringify(s));
    r.check("nothing to summarise", m.summarize([null]) === null);

    const runs = m.chartRuns([0, 30, 60, 90, 400], [1, null, 3, 4, 5], { from: 0, to: 400, max: 10, width: 400, height: 100 }, 75);
    r.check("a missing value splits the line", runs.length === 3, JSON.stringify(runs));
    r.check("a long silence splits it too", runs[2]?.length === 1 && runs[2][0].i === 4);
    r.check("points sit on the scale", runs[0][0].y === 90 && runs[1][0].x === 60);
  }

  return r.result();
}
