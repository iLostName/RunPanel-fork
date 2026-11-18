import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The friendly schedule editor and the cron expression underneath.
 *
 * The property that matters most is checked against the real parser rather
 * than restated: whenever `cronToSchedule` recognises an expression, the
 * expression it would write back fires at exactly the same instants. A
 * recognition that rounded "twice a day" down to "every day" would drop a
 * backup every night and nothing would ever say so.
 */
export const meta = { name: "schedule-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("schedule-unit");
  const s = await import(pathToFileURL(join(repoRoot, "lib", "schedule.ts")).href);
  const cron = await import(pathToFileURL(join(repoRoot, "lib", "cron.ts")).href);

  const from = new Date("2026-01-05T10:17:00Z");
  const fires = (expression, zone = "UTC", count = 60) =>
    cron.nextOccurrences(expression, from, zone, count).map((d) => d.toISOString()).join(",");

  // --- writing ---------------------------------------------------------------
  r.check("manual is the empty expression", s.scheduleToCron({ kind: "manual" }) === "");
  r.check("daily", s.scheduleToCron({ kind: "daily", hour: 3, minute: 0 }) === "0 3 * * *");
  r.check("hourly, every hour", s.scheduleToCron({ kind: "hourly", every: 1, minute: 15 }) === "15 * * * *");
  r.check("hourly, every six hours", s.scheduleToCron({ kind: "hourly", every: 6, minute: 0 }) === "0 */6 * * *");
  r.check(
    "an interval that does not divide a day is not written",
    s.scheduleToCron({ kind: "hourly", every: 5, minute: 0 }) === "0 * * * *"
  );
  r.check(
    "weekly, days sorted and Sunday as 0",
    s.scheduleToCron({ kind: "weekly", weekdays: [5, 1, 7], hour: 2, minute: 30 }) === "30 2 * * 0,1,5"
  );
  r.check(
    "weekly with no day falls back to Monday rather than to every day",
    s.scheduleToCron({ kind: "weekly", weekdays: [], hour: 3, minute: 0 }) === "0 3 * * 1"
  );
  r.check("monthly", s.scheduleToCron({ kind: "monthly", day: 1, hour: 4, minute: 5 }) === "5 4 1 * *");
  r.check("out-of-range values are clamped", s.scheduleToCron({ kind: "daily", hour: 31, minute: -4 }) === "0 23 * * *");
  r.check("custom is kept as typed, trimmed", s.scheduleToCron({ kind: "custom", cron: " 0 3,15 * * * " }) === "0 3,15 * * *");

  for (const schedule of [
    { kind: "hourly", every: 1, minute: 0 },
    { kind: "hourly", every: 12, minute: 45 },
    { kind: "daily", hour: 0, minute: 0 },
    { kind: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 23, minute: 59 },
    { kind: "monthly", day: 31, hour: 3, minute: 0 },
  ]) {
    const expression = s.scheduleToCron(schedule);
    r.check(`what is written parses: ${expression}`, cron.parseCron(expression).ok, expression);
  }

  // --- reading back ----------------------------------------------------------
  const kindOf = (expression) => s.cronToSchedule(expression).kind;
  r.check("empty is manual", kindOf("") === "manual" && kindOf("   ") === "manual");
  r.check("0 3 * * * is daily at 03:00", JSON.stringify(s.cronToSchedule("0 3 * * *")) === JSON.stringify({ kind: "daily", hour: 3, minute: 0 }));
  r.check("leading zeros are fine", JSON.stringify(s.cronToSchedule("05 03 * * *")) === JSON.stringify({ kind: "daily", hour: 3, minute: 5 }));
  r.check("@daily is daily at midnight", JSON.stringify(s.cronToSchedule("@daily")) === JSON.stringify({ kind: "daily", hour: 0, minute: 0 }));
  r.check("@hourly", JSON.stringify(s.cronToSchedule("@hourly")) === JSON.stringify({ kind: "hourly", every: 1, minute: 0 }));
  r.check("@weekly is Sunday at midnight", JSON.stringify(s.cronToSchedule("@weekly")) === JSON.stringify({ kind: "weekly", weekdays: [0], hour: 0, minute: 0 }));
  r.check("@monthly", JSON.stringify(s.cronToSchedule("@monthly")) === JSON.stringify({ kind: "monthly", day: 1, hour: 0, minute: 0 }));
  r.check("names and ranges for weekdays", JSON.stringify(s.cronToSchedule("0 3 * * MON-FRI").weekdays) === "[1,2,3,4,5]");
  r.check("7 is Sunday too", JSON.stringify(s.cronToSchedule("0 3 * * 7").weekdays) === "[0]");
  r.check("every weekday listed is just daily", kindOf("0 3 * * 0-6") === "daily");
  r.check("*/6 and 0/6 are the same interval", s.cronToSchedule("0 */6 * * *").every === 6 && s.cronToSchedule("0 0/6 * * *").every === 6);

  for (const expression of [
    "0 3,15 * * *", // twice a day
    "*/15 * * * *", // every quarter of an hour
    "0 */5 * * *", // an interval that does not divide a day
    "0 3 1 1 *", // once a year
    "0 3 13 * 5", // cron ORs the two day fields
    "0 1-5 * * *", // a range of hours
    "0 */6 * * 1", // hourly on some days only
    "0 3 * * 1/2", // a weekday step
    "0 3 L * *", // unsupported syntax
    "@yearly",
    "@reboot",
    "not a schedule",
  ]) {
    r.check(`stays custom: ${expression}`, kindOf(expression) === "custom", kindOf(expression));
  }
  r.check("custom keeps the expression as typed", s.cronToSchedule("0 3,15 * * *").cron === "0 3,15 * * *");

  // The property that keeps the editor honest: recognised means equivalent.
  for (const expression of [
    "0 3 * * *",
    "30 2 * * 1,3,5",
    "0 4 * * sat,sun",
    "15 * * * *",
    "0 */3 * * *",
    "0 0-23/8 * * *",
    "0 3 1 * *",
    "0 3 30 * *",
    "@daily",
    "@weekly",
    "@monthly",
  ]) {
    const schedule = s.cronToSchedule(expression);
    const written = s.scheduleToCron(schedule);
    r.check(
      `recognised ${expression} fires exactly like ${written}`,
      schedule.kind !== "custom" && fires(expression) === fires(written) && fires(expression, "Europe/Rome") === fires(written, "Europe/Rome")
    );
  }

  // And the round trip from the editor's side.
  for (const schedule of [
    { kind: "daily", hour: 3, minute: 0 },
    { kind: "weekly", weekdays: [0, 6], hour: 9, minute: 30 },
    { kind: "monthly", day: 15, hour: 12, minute: 0 },
    { kind: "hourly", every: 2, minute: 10 },
  ]) {
    r.check(
      `${JSON.stringify(schedule)} round-trips`,
      JSON.stringify(s.cronToSchedule(s.scheduleToCron(schedule))) === JSON.stringify(schedule)
    );
  }

  // --- Italian ---------------------------------------------------------------
  const say = (expression) => s.describeCronFriendly(expression);
  r.check("manual", say("") === "Solo su richiesta");
  r.check("daily", say("0 3 * * *") === "Ogni giorno alle 03:00", say("0 3 * * *"));
  r.check("weekly, one day", say("0 3 * * 1") === "Ogni lunedì alle 03:00", say("0 3 * * 1"));
  r.check("weekly, two days", say("30 2 * * 4,1") === "Ogni lunedì e giovedì alle 02:30", say("30 2 * * 4,1"));
  r.check("Sunday is read last", say("0 3 * * 0,3") === "Ogni mercoledì e domenica alle 03:00", say("0 3 * * 0,3"));
  r.check("working days", say("0 3 * * 1-5") === "Dal lunedì al venerdì alle 03:00", say("0 3 * * 1-5"));
  r.check("weekend", say("0 3 * * 6,0") === "Il sabato e la domenica alle 03:00", say("0 3 * * 6,0"));
  r.check("monthly", say("0 3 1 * *") === "Ogni mese il giorno 1 alle 03:00", say("0 3 1 * *"));
  r.check("monthly past the 28th says it skips", say("0 3 31 * *").includes("salta"), say("0 3 31 * *"));
  r.check("every hour", say("0 * * * *") === "Ogni ora", say("0 * * * *"));
  r.check("every hour at a minute", say("15 * * * *") === "Ogni ora, al minuto 15", say("15 * * * *"));
  r.check("every six hours", say("0 */6 * * *") === "Ogni 6 ore, a partire dalle 00:00", say("0 */6 * * *"));
  r.check("custom uses the fallback", s.describeCronFriendly("0 3,15 * * *", "ogni giorno alle 03:00, 15:00") === "Ogni giorno alle 03:00, 15:00");
  r.check("custom without a fallback shows the expression", say("0 3,15 * * *") === "0 3,15 * * *");

  // --- time zones ------------------------------------------------------------
  const zones = s.timeZoneOptions(["Europe/Rome", "America/New_York", "UTC"], ["Europe/Kyiv", null, "Europe/Rome"]);
  r.check("UTC comes first, once", zones[0] === "UTC" && zones.filter((z) => z === "UTC").length === 1);
  r.check("a stored zone the runtime does not list is kept", zones.includes("Europe/Kyiv"));
  r.check("no duplicates", new Set(zones).size === zones.length);
  r.check("the runtime's list is there", s.supportedTimeZones().includes("Europe/Rome"));
  r.check("winter offset of Rome", s.zoneOffset("Europe/Rome", new Date("2026-01-15T12:00:00Z")) === "UTC+01:00", s.zoneOffset("Europe/Rome", new Date("2026-01-15T12:00:00Z")));
  r.check("summer offset of Rome", s.zoneOffset("Europe/Rome", new Date("2026-07-15T12:00:00Z")) === "UTC+02:00");
  r.check("UTC itself", s.zoneOffset("UTC") === "UTC+00:00", s.zoneOffset("UTC"));
  r.check("an unknown zone has no offset rather than throwing", s.zoneOffset("Mars/Olympus") === "");
  r.check("search text matches a city with a space", s.zoneSearchText("America/New_York").includes("New York"));

  // --- defaults --------------------------------------------------------------
  r.check("a new weekly keeps the chosen time", JSON.stringify(s.defaultSchedule("weekly", { kind: "daily", hour: 2, minute: 30 })) === JSON.stringify({ kind: "weekly", weekdays: [1], hour: 2, minute: 30 }));
  r.check("switching to custom starts from the current expression", s.defaultSchedule("custom", { kind: "daily", hour: 2, minute: 30 }).cron === "30 2 * * *");
  r.check("a fresh daily is the nightly 03:00", s.scheduleToCron(s.defaultSchedule("daily")) === "0 3 * * *");

  return r.result();
}
