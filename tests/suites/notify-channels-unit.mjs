import { createReporter } from "../harness.mjs";
import { registerHooks } from "node:module";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The channels' pure parts: formats, signature, brakes, selection, schemas.
 *
 * Everything that decides what leaves the panel and in what shape is a pure
 * function, and is held here against the cases that matter: a commit subject
 * full of markup reaching an email or a Discord embed as text and never as
 * markup, a webhook signature a receiver can verify with nothing but the
 * documented recipe, a flapping project producing one message rather than
 * thirty, an event added after a channel was saved taking its default instead
 * of starting silenced, and a secret URL never shown back.
 *
 * Nothing here opens a socket. `lib/notify-schema.ts` imports its neighbours
 * without an extension, so the same resolve hook as `validation-unit` is used.
 */
export const meta = { name: "notify-channels-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("notify-channels-unit");

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const extensionless = specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier);
      const fromTs = context.parentURL?.endsWith(".ts");
      return nextResolve(extensionless && fromTs ? `${specifier}.ts` : specifier, context);
    },
  });
  const load = (...parts) => import(pathToFileURL(join(repoRoot, ...parts)).href);

  const events = await load("lib", "notify-events.ts");
  const format = await load("lib", "notify-format.ts");
  const sign = await load("lib", "notify-sign.ts");
  const throttle = await load("lib", "notify-throttle.ts");
  const channels = await load("lib", "notify-channels.ts");
  const schema = await load("lib", "notify-schema.ts");
  const messages = await load("services", "notify", "messages.ts");

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- What a channel receives ------------------------------------------------
  {
    const { selectedEvents, choicesFor, parseEventChoices, DEFAULT_NOTIFY_EVENTS, NOTIFY_EVENTS } = events;
    r.check("a channel never asked receives the defaults", same(selectedEvents({}), DEFAULT_NOTIFY_EVENTS));
    r.check("and so does a channel with no stored choices", same(selectedEvents(null), DEFAULT_NOTIFY_EVENTS));

    const saved = choicesFor(["deploy.finished"]);
    r.check("a save answers for every key there is", Object.keys(saved).length === NOTIFY_EVENTS.length);
    r.check("and keeps exactly what was chosen", same(selectedEvents(saved), ["deploy.finished"]));

    // The case the map exists for: a key added after the channel was saved.
    const before = { ...saved };
    delete before["disk.low"];
    r.check(
      "an event added later takes its default instead of starting silenced",
      selectedEvents(before).includes("disk.low") === DEFAULT_NOTIFY_EVENTS.includes("disk.low")
    );
    r.check("a key switched off stays off", !selectedEvents(saved).includes("project.crashed"));
    r.check("turning everything off is possible", selectedEvents(choicesFor([])).length === 0);
    r.check("stored garbage reads as never asked", same(parseEventChoices("{nope"), {}) && same(parseEventChoices("[1,2]"), {}));
    r.check("non-boolean choices are dropped", same(parseEventChoices('{"deploy.finished":"yes","disk.low":false}'), { "disk.low": false }));
    r.check("a key that no longer exists is ignored", !selectedEvents({ "gone.event": true }).includes("gone.event"));
  }

  {
    const { passesFilter, channelWants, choicesFor } = events;
    r.check("everything passes «all»", passesFilter("all", "info", false) && passesFilter("all", "ok", false));
    r.check("a failure passes «problems»", passesFilter("problems", "danger", false) && passesFilter("problems", "warn", false));
    r.check("a success does not", !passesFilter("problems", "ok", false) && !passesFilter("problems", "info", false));
    r.check("a recovery does: it closes the problem it follows", passesFilter("problems", "ok", true));

    const telegram = { events: choicesFor(["deploy.finished"]), filter: "problems" };
    r.check("«tell me on Telegram when a deploy fails»: a failure arrives", channelWants(telegram, { key: "deploy.finished" }, "danger"));
    r.check("and a success does not", !channelWants(telegram, { key: "deploy.finished" }, "ok"));
    r.check("nor anything it did not ask for", !channelWants(telegram, { key: "backup.finished" }, "danger"));
    const docker = { events: choicesFor(["docker.down"]), filter: "problems" };
    r.check("Docker coming back reaches a problems-only channel", channelWants(docker, { key: "docker.down", up: true }, "ok"));
  }

  {
    const { eventMeta, eventLabel, eventGroupOf, NOTIFY_EVENTS, DEFAULT_NOTIFY_AUDIENCE } = events;
    r.check("an unknown event goes to the cautious audience", eventMeta("x.y").permission === DEFAULT_NOTIFY_AUDIENCE);
    r.check("a backup goes to whoever may see backups", eventMeta("backup.finished").permission === "backup");
    r.check("an update to whoever may apply one", eventMeta("panel.update").permission === "updates");
    for (const key of NOTIFY_EVENTS) {
      r.check(`${key} has a label and a group`, eventLabel(key) !== key && eventGroupOf(key) !== null);
    }
  }

  // --- The dialect, read back --------------------------------------------------
  const HOSTILE = '<i>&"\'<script>alert(1)</script> **bold** @everyone <@123> `tick` |pipe| [x](javascript:1)';
  const hostileHtml = messages.escapeHtml(HOSTILE);
  {
    const { parseNotifyHtml, toPlainText, toEmailHtml, toDiscordMarkdown, toSlackMrkdwn } = format;
    const tree = parseNotifyHtml('<b>a &amp; b</b> <code>x &lt; y</code> <a href="https://p.example/x">vai</a>');
    r.check(
      "the three tags come back as a tree",
      tree.length === 5 && tree[0].tag === "b" && tree[2].tag === "code" && tree[4].tag === "a",
      JSON.stringify(tree)
    );
    r.check("entities are decoded once", tree[0].children[0] === "a & b" && tree[2].children[0] === "x < y");
    r.check("an unclosed tag ends with the text", parseNotifyHtml("<b>open").length === 1 && parseNotifyHtml("<b>open")[0].tag === "b");
    r.check("a stray closer is dropped", same(parseNotifyHtml("text</b>"), ["text"]));
    r.check(
      "a link that is not http(s) keeps its label and loses the link",
      same(parseNotifyHtml('<a href="javascript:alert(1)">x</a>'), ["x"])
    );
    r.check("escaped markup stays text", same(parseNotifyHtml(hostileHtml), [HOSTILE]));

    r.check("plain text has no tags", toPlainText("<b>a</b> <code>b</code>") === "a b");
    r.check(
      "plain text spells a link out",
      toPlainText('<a href="https://p.example/x">Apri</a>') === "Apri (https://p.example/x)"
    );

    const email = toEmailHtml(hostileHtml);
    r.check("an email never carries injected markup", !/<script|<i>/.test(email), email.slice(0, 160));
    r.check("quotes are escaped for a real HTML parser", email.includes("&quot;") && email.includes("&#39;"));
    r.check("newlines become line breaks", toEmailHtml("a\nb").includes("<br>"));

    const discord = toDiscordMarkdown(hostileHtml);
    r.check("Discord: markdown in text is escaped", discord.includes("\\*\\*bold\\*\\*") && discord.includes("\\`tick\\`"), discord);
    r.check("Discord: a link in text is not a link", discord.includes("\\[x\\]\\(javascript:1\\)"), discord);
    r.check(
      "Discord: our own markup is kept",
      toDiscordMarkdown("<b>x</b> <code>y`z</code>") === "**x** `yˋz`",
      toDiscordMarkdown("<b>x</b> <code>y`z</code>")
    );

    const slack = toSlackMrkdwn(hostileHtml);
    r.check("Slack: angle brackets are entities, so no mention or link is formed", !/<[@!#]|<script/.test(slack), slack);
    r.check(
      "Slack: our own link is a Slack link",
      toSlackMrkdwn('<a href="https://p.example/a|b">Apri</a>') === "<https://p.example/a%7Cb|Apri>",
      toSlackMrkdwn('<a href="https://p.example/a|b">Apri</a>')
    );
  }

  // --- Messages as they leave ----------------------------------------------------
  {
    const { discordPayload, slackPayload, ntfyPayload, webhookBody, emailContent, cut, worstLevel } = format;
    const message = {
      id: "n1",
      event: "deploy.finished",
      level: "danger",
      title: "srv · Deploy fallito — api",
      body: `${hostileHtml}\n<b>Errore</b>: <code>exit 1</code>`,
      link: "https://panel.example/projects/abc",
      server: "srv",
      at: "2026-11-18T10:00:00.000Z",
      data: { slug: "api", ok: false },
    };

    const discord = discordPayload(message);
    r.check("Discord: no mention can ping anyone", same(discord.allowed_mentions, { parse: [] }));
    r.check("Discord: the embed is red for a failure", discord.embeds[0].color === 0xef4444);
    r.check("Discord: the title fits the embed limit", discord.embeds[0].title.length <= 256);
    const longBody = messages.escapeHtml("x".repeat(9000));
    r.check("Discord: a long body is cut to the limit", discordPayload({ ...message, body: longBody }).embeds[0].description.length <= 4000);

    const slack = slackPayload(message);
    r.check("Slack: a fallback text for the phone preview", typeof slack.text === "string" && slack.text.includes("Deploy fallito"));
    r.check("Slack: the link back is in the footer", JSON.stringify(slack.blocks).includes("Apri in RunPanel"));

    const ntfy = ntfyPayload(message, "runpanel-alerts");
    r.check("ntfy: topic, title and plain message", ntfy.topic === "runpanel-alerts" && !/<b>|<code>/.test(ntfy.message));
    r.check("ntfy: a failure is high priority, never max", ntfy.priority === 4);
    r.check("ntfy: tapping opens the panel", ntfy.click === message.link);

    const body = webhookBody(message);
    const parsed = JSON.parse(body);
    r.check("webhook: the documented fields", ["id", "event", "level", "title", "text", "url", "server", "at", "data"].every((k) => k in parsed));
    r.check("webhook: text is plain", !/<code>/.test(parsed.text));

    const email = emailContent(message);
    r.check("email: the subject says where it is from", email.subject.startsWith("[RunPanel] "));
    r.check("email: the text part has the link", email.text.includes(message.link));
    r.check("email: the HTML part has no injected markup", !/<script|<i>/.test(email.html));

    r.check("cut never splits a surrogate pair", !/[\uD800-\uDBFF]…$/.test(cut("ab😀cd", 4)), cut("ab😀cd", 4));
    r.check("cut leaves a short text alone", cut("abc", 10) === "abc");
    r.check("a digest takes the worst colour", worstLevel(["ok", "danger", "info"]) === "danger" && worstLevel([]) === "info");
  }

  // --- Digest and repeats, from the catalogue's side ------------------------------
  {
    const { digest, withRepeats, render } = messages;
    const joined = digest(
      [
        { level: "danger", title: HOSTILE },
        { level: "ok", title: "Docker risponde di nuovo" },
      ],
      3
    );
    r.check("a digest counts what it joined and what it dropped", joined.title === "5 avvisi da RunPanel", joined.title);
    r.check("a digest is as bad as its worst item", joined.level === "danger");
    const out = render(joined);
    r.check("a digest escapes the titles it lists", !/<script|<i>/.test(out) && out.includes("&lt;script&gt;"), out.slice(0, 200));
    r.check("and says how many more", out.includes("altri 3"), out);

    const base = { level: "danger", title: "Progetto fermo", body: messages.escapeHtml("x") };
    r.check("no repeats, no note", withRepeats(base, 0) === base);
    r.check("one repeat reads as one", withRepeats(base, 1).body.includes("un'altra volta"));
    r.check("several are counted", withRepeats(base, 4).body.includes("altre 4 volte"));
  }

  // --- The webhook signature, as a receiver checks it -------------------------------
  {
    const { signWebhook, verifyWebhook, signedContent, REPLAY_WINDOW_SECONDS } = sign;
    const secret = "s3cr3t-s3cr3t-s3cr3t";
    const body = '{"id":"n1","event":"deploy.finished","title":"Déploy — ✅"}';
    const ts = 1_800_000_000;
    const signature = signWebhook(secret, ts, body);

    // The documented recipe, written out independently of the panel's code.
    const recipe = `v1=${createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex")}`;
    r.check("the signature is HMAC-SHA256 over «timestamp.body»", signature === recipe, signature);
    r.check("what is signed is spelled the documented way", signedContent(ts, body) === `${ts}.${body}`);

    const ok = (headers, b = body, now = ts) => verifyWebhook(secret, headers, b, now);
    r.check("a fresh, untouched request verifies", ok({ timestamp: String(ts), signature }).ok === true);
    r.check("a changed body does not", ok({ timestamp: String(ts), signature }, body.replace("n1", "n2")).reason === "mismatch");
    r.check("a changed timestamp does not", ok({ timestamp: String(ts + 1), signature }, body, ts).reason === "mismatch");
    r.check("another secret does not", verifyWebhook("other-secret-xxxxxx", { timestamp: String(ts), signature }, body, ts).reason === "mismatch");
    r.check(
      "an old request is refused even with a valid signature",
      ok({ timestamp: String(ts), signature }, body, ts + REPLAY_WINDOW_SECONDS + 1).reason === "stale"
    );
    r.check("so is one from the future", ok({ timestamp: String(ts), signature }, body, ts - REPLAY_WINDOW_SECONDS - 1).reason === "stale");
    r.check("inside the window it passes", ok({ timestamp: String(ts), signature }, body, ts + REPLAY_WINDOW_SECONDS).ok === true);
    r.check("missing headers are reported as such", ok({ timestamp: null, signature }).reason === "missing");
    r.check("a non-numeric timestamp is malformed", ok({ timestamp: "soon", signature }).reason === "malformed");
    r.check("an unversioned signature is malformed", ok({ timestamp: String(ts), signature: signature.slice(3) }).reason === "malformed");
    r.check("any one of several signatures may match", ok({ timestamp: String(ts), signature: `v1=deadbeef, ${signature}` }).ok === true);
  }

  // --- The brakes ----------------------------------------------------------------------
  {
    const { Cooldown, newBurst, offerBurst, drainBurst, newRate, allowRate } = throttle;
    const WINDOW = 15 * 60_000;
    const cooldown = new Cooldown(WINDOW, 3);
    const first = cooldown.admit("project.crashed:api", 0);
    r.check("the first occurrence goes out", first.send === true && first.repeats === 0 && first.previousAt === null);
    let held = 0;
    for (let t = 30_000; t < WINDOW; t += 30_000) if (!cooldown.admit("project.crashed:api", t).send) held++;
    r.check("a crash-loop inside the window is held back", held === 29, String(held));
    const again = cooldown.admit("project.crashed:api", WINDOW);
    r.check("the next one after the window goes out", again.send === true);
    r.check("and says how many were held back", again.repeats === 29 && again.previousAt === 0, JSON.stringify(again));
    r.check("another project is not silenced by the first", cooldown.admit("project.crashed:web", 1000).send === true);
    r.check("an empty key is never held back", cooldown.admit("", 1).send && cooldown.admit("", 2).send);
    cooldown.admit("a", 0);
    cooldown.admit("b", 0);
    cooldown.admit("c", 10 * WINDOW);
    r.check("old keys are pruned past the cap", cooldown.size() <= 3, String(cooldown.size()));

    const MIN = 60_000;
    const burst = newBurst();
    const one = offerBurst(burst, "docker.down", 0, MIN);
    r.check("the first message of a burst goes out at once", one.send === "docker.down" && one.scheduleAt === null);
    const two = offerBurst(burst, "svc-1", 1_000, MIN);
    r.check("the next one is held, and one timer is asked for", two.send === null && two.scheduleAt === MIN, JSON.stringify(two));
    let timers = 0;
    for (let i = 2; i <= 25; i++) if (offerBurst(burst, `svc-${i}`, 1_000 + i, MIN, 20).scheduleAt !== null) timers++;
    r.check("the rest wait for the same timer", timers === 0);
    const drained = drainBurst(burst, MIN);
    r.check("the held messages come out together", drained.items.length === 20 && drained.dropped === 5, JSON.stringify({ n: drained.items.length, d: drained.dropped }));
    r.check("a message right after a digest waits again", offerBurst(burst, "late", MIN + 1, MIN).send === null);
    const quiet = newBurst();
    offerBurst(quiet, "a", 0, MIN);
    r.check("after a quiet window, a message goes out at once", offerBurst(quiet, "b", MIN, MIN).send === "b");
    r.check("draining nothing is harmless", drainBurst(newBurst(), 5).items.length === 0);

    const rate = newRate(0);
    let allowed = 0;
    for (let i = 0; i < 40; i++) if (allowRate(rate, i, 30, 600_000).allowed) allowed++;
    r.check("a webhook is capped inside its window", allowed === 30, String(allowed));
    const next = allowRate(rate, 600_000, 30, 600_000);
    r.check("the next window opens and reports what was refused", next.allowed && next.refusedBefore === 10, JSON.stringify(next));
  }

  // --- Fields and secrets ----------------------------------------------------------------
  {
    const c = channels;
    r.check("a BotFather token passes", c.TELEGRAM_TOKEN_PATTERN.test("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
    r.check("a token without its secret does not", !c.TELEGRAM_TOKEN_PATTERN.test("123456789:short"));
    r.check("a group id passes", c.TELEGRAM_CHAT_PATTERN.test("-1001234567890") && c.TELEGRAM_CHAT_PATTERN.test("@miocanale"));
    r.check("a username with a space does not", !c.TELEGRAM_CHAT_PATTERN.test("mio canale"));

    const discordUrl = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
    r.check("a Discord webhook passes", c.DISCORD_WEBHOOK_PATTERN.test(discordUrl));
    r.check("a look-alike host does not", !c.DISCORD_WEBHOOK_PATTERN.test(discordUrl.replace("discord.com", "discord.com.evil.example")));
    r.check("plain http does not", !c.DISCORD_WEBHOOK_PATTERN.test(discordUrl.replace("https", "http")));
    const slackUrl = "https://hooks.slack.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX";
    r.check("a Slack webhook passes", c.SLACK_WEBHOOK_PATTERN.test(slackUrl));
    r.check("another host does not", !c.SLACK_WEBHOOK_PATTERN.test(slackUrl.replace("hooks.slack.com", "hooks.example.com")));

    const discordHint = c.urlHint("discord", discordUrl);
    r.check("a Discord hint names the webhook", discordHint.includes("123456789012345678"), discordHint);
    r.check("and never its token", !discordHint.includes("AbCdEfGh"), discordHint);
    const slackHint = c.urlHint("slack", slackUrl);
    r.check("a Slack hint never shows its secret part", !slackHint.includes("XXXXXXXX"), slackHint);
    r.check("a webhook hint is the origin alone", c.urlHint("webhook", "https://u:p@hooks.example:8443/a?token=x") === "https://hooks.example:8443");

    r.check("reserved headers are refused", c.isReservedHeader("Content-Type") && c.isReservedHeader("X-RunPanel-Signature"));
    r.check("others are not", !c.isReservedHeader("Authorization") && !c.isReservedHeader("X-Api-Key"));

    const merged = c.mergeHeaders({ Authorization: "Bearer old", "X-Old": "1" }, [
      { name: "authorization", value: "" },
      { name: "X-New", value: "2" },
    ]);
    r.check("a blank header value keeps the stored one", merged.headers.authorization === "Bearer old", JSON.stringify(merged));
    r.check("a name left out is removed", !("X-Old" in merged.headers));
    r.check("a new one is added", merged.headers["X-New"] === "2");
    r.check("a blank value with nothing stored is reported", same(c.mergeHeaders({}, [{ name: "X-Key" }]).missing, ["X-Key"]));

    r.check("recipients split on commas, spaces and lines", same(c.parseRecipients("A@x.it, b@y.it\nA@x.it;c@z.it"), ["a@x.it", "b@y.it", "c@z.it"]));

    const health = c.channelHealth;
    r.check("a disabled channel is off", health({ enabled: false, lastOkAt: "2", lastErrorAt: null }) === "off");
    r.check("one never used says so", health({ enabled: true, lastOkAt: null, lastErrorAt: null }) === "never");
    r.check("a failure after the last success is failing", health({ enabled: true, lastOkAt: "2026-01-01", lastErrorAt: "2026-01-02" }) === "failing");
    r.check("a success after a failure is fine again", health({ enabled: true, lastOkAt: "2026-01-03", lastErrorAt: "2026-01-02" }) === "ok");

    for (const kind of c.CHANNEL_KINDS) {
      const info = c.CHANNEL_KIND_INFO[kind];
      r.check(`${kind} has a label, an icon and a window`, Boolean(info.label) && info.icon.startsWith("solar:") && (info.coalesce ? info.burstWindowMs > 0 : true));
    }
  }

  // --- The request bodies ------------------------------------------------------------------
  {
    const { createChannelSchema, updateChannelSchema, outboundUrlProblem, smtpSettingsSchema, readNotificationsSchema } = schema;
    r.check("https anywhere is fine", outboundUrlProblem("https://hooks.example.com/x") === null);
    r.check("http to the internet is not", outboundUrlProblem("http://hooks.example.com/x") !== null);
    r.check("http inside the network is", outboundUrlProblem("http://192.168.1.10:8080/ntfy") === null && outboundUrlProblem("http://localhost:5678/webhook") === null);
    r.check("cloud metadata is refused", outboundUrlProblem("http://169.254.169.254/latest") !== null && outboundUrlProblem("https://169.254.169.254/") !== null);
    r.check("another scheme is refused", outboundUrlProblem("javascript:alert(1)") !== null && outboundUrlProblem("file:///etc/passwd") !== null);

    const base = { name: "Allarmi", events: ["deploy.finished"] };
    const ok = (body) => createChannelSchema.safeParse(body).success;
    r.check("an email channel with recipients", ok({ ...base, kind: "email", config: { to: ["ops@esempio.it"] } }));
    r.check("but not without", !ok({ ...base, kind: "email", config: { to: [] } }));
    r.check("nor with a broken address", !ok({ ...base, kind: "email", config: { to: ["not-an-address"] } }));
    r.check(
      "a Telegram channel needs token and chat",
      ok({ ...base, kind: "telegram", config: { chatId: "-100123" }, secrets: { botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw" } }) &&
        !ok({ ...base, kind: "telegram", config: { chatId: "-100123" }, secrets: { botToken: "nope" } })
    );
    r.check(
      "a webhook needs a long enough secret",
      ok({ ...base, kind: "webhook", secrets: { url: "https://hooks.example.com/rp", signingSecret: "x".repeat(16) } }) &&
        !ok({ ...base, kind: "webhook", secrets: { url: "https://hooks.example.com/rp", signingSecret: "short" } })
    );
    r.check(
      "a webhook may not set the panel's own headers",
      !ok({
        ...base,
        kind: "webhook",
        secrets: { url: "https://hooks.example.com/rp", signingSecret: "x".repeat(16), headers: [{ name: "X-RunPanel-Signature", value: "v1=forged" }] },
      })
    );
    r.check(
      "nor carry a newline in a header value",
      !ok({ ...base, kind: "webhook", secrets: { url: "https://hooks.example.com/rp", signingSecret: "x".repeat(16), headers: [{ name: "X-Key", value: "a\r\nInjected: 1" }] } })
    );
    r.check("ntfy falls back to ntfy.sh", createChannelSchema.parse({ ...base, kind: "ntfy", config: { topic: "rp-alerts" } }).config.server === "https://ntfy.sh");
    r.check("an unknown event is refused", !ok({ ...base, events: ["no.such.event"], kind: "email", config: { to: ["a@b.it"] } }));
    r.check("an unknown field is refused", !ok({ ...base, kind: "email", config: { to: ["a@b.it"] }, extra: 1 }));
    r.check("a kind that does not exist is refused", !ok({ ...base, kind: "pigeon" }));

    const edit = updateChannelSchema("telegram").safeParse({ secrets: { botToken: "" }, name: "Nuovo nome" });
    r.check("a blank secret on edit means keep", edit.success && edit.data.secrets.botToken === undefined, JSON.stringify(edit));
    r.check("a malformed one is still refused", !updateChannelSchema("telegram").safeParse({ secrets: { botToken: "nope" } }).success);
    r.check("the kind cannot be changed", !updateChannelSchema("email").safeParse({ kind: "webhook" }).success);
    r.check("ntfy's token can be removed with null", updateChannelSchema("ntfy").safeParse({ secrets: { token: null } }).success);

    const smtp = (patch) => smtpSettingsSchema.safeParse({ host: "smtp.esempio.it", port: 587, security: "starttls", username: "", from: "RunPanel <panel@esempio.it>", ...patch });
    r.check("an SMTP server with a named sender", smtp({}).success);
    r.check("a host with a scheme is refused", !smtp({ host: "smtp://smtp.esempio.it" }).success);
    r.check("a host with a port is refused", !smtp({ host: "smtp.esempio.it:587" }).success);
    r.check("a bare sender address is fine", smtp({ from: "panel@esempio.it" }).success);
    r.check("a broken sender is not", !smtp({ from: "RunPanel" }).success);
    r.check("a port out of range is not", !smtp({ port: 70000 }).success);

    r.check("marking read takes ids or all", readNotificationsSchema.safeParse({ ids: ["a"] }).success && readNotificationsSchema.safeParse({ all: true }).success);
    r.check("but not nothing", !readNotificationsSchema.safeParse({}).success && !readNotificationsSchema.safeParse({ ids: [] }).success);
  }

  return r.result();
}
