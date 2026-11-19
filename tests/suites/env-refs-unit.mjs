import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Shared variables and references, as data: the syntax, the precedence and the
 * resolution — cycles, names that do not exist, the escape.
 *
 * The rule that matters most is the one a deploy depends on: a reference that
 * cannot be resolved is a problem with a sentence, never a value. An empty
 * string or the reference's own text reaching an app would be a wrong secret
 * delivered without a word, which is the thing this feature must not do.
 * Standalone: lib/env-refs.ts has no imports.
 */
export const meta = { name: "env-refs-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("env-refs-unit");
  const refs = await import(pathToFileURL(join(repoRoot, "lib", "env-refs.ts")).href);
  const { parseValue, parseRef, refText, mergeLayers, applyInjected, resolveEffective, groupConflict, findCycle, sharedClosure, mentionsReference, dependsOnOrigin } = refs;

  // --- parsing ------------------------------------------------------------
  const simple = parseValue("${{ shared.smtp.HOST }}");
  r.check("a shared reference parses", simple.error === null && simple.refs[0]?.kind === "shared" && simple.refs[0].group === "smtp" && simple.refs[0].key === "HOST", JSON.stringify(simple));
  r.check("spaces inside the braces are optional", parseValue("${{shared.smtp.HOST}}").refs.length === 1);
  const mixed = parseValue("postgres://${{ db.main.user }}:${{ db.main.password }}@x/y");
  r.check("text and references mix", mixed.segments.length === 5 && mixed.refs.length === 2, JSON.stringify(mixed.segments));
  r.check("a database with no project has three parts", JSON.stringify(parseRef("db.cache.url").ref) === JSON.stringify({ kind: "db", project: null, service: "cache", field: "url" }));
  r.check("a linked database names its project", JSON.stringify(parseRef("db.blog.main.password").ref) === JSON.stringify({ kind: "db", project: "blog", service: "main", field: "password" }));
  r.check("a project reference", JSON.stringify(parseRef("project.api.url").ref) === JSON.stringify({ kind: "project", slug: "api", field: "url" }));
  r.check("an unknown namespace is refused, by name", /"env" non è un tipo di riferimento/.test(parseRef("env.FOO.BAR").error ?? ""));
  r.check("an unknown field is refused, with the list", /"pass" non è un campo di un database, usa url/.test(parseRef("db.main.pass").error ?? ""));
  r.check("a wrong number of parts is refused", /shared\.GRUPPO\.VARIABILE/.test(parseRef("shared.smtp").error ?? ""));
  r.check("a name a reference cannot spell is refused", /non è un nome valido/.test(parseRef("shared.Smtp Live.HOST").error ?? ""));
  r.check("an empty reference is refused", parseValue("a ${{ }} b").error !== null);
  r.check("an unclosed one is refused and points at the escape", /\$\$\{\{/.test(parseValue("x ${{ shared.a.B").error ?? ""));

  // --- escaping -----------------------------------------------------------
  const escaped = parseValue("$${{ shared.a.B }}");
  r.check("$${{ is a literal ${{", escaped.error === null && escaped.refs.length === 0 && escaped.segments[0]?.text === "${{ shared.a.B }}", JSON.stringify(escaped));
  r.check("a lone $$ is just two dollars", parseValue("pa$$word").segments[0]?.text === "pa$$word");
  r.check("${VAR} for a shell or Compose is left alone", parseValue("${HOME}/x and $PATH").refs.length === 0 && parseValue("${HOME}/x").error === null);
  r.check("mentionsReference ignores the escaped form", !mentionsReference("$${{ x }}") && mentionsReference("a ${{ shared.a.B }}"));
  r.check("refText spells a reference the documented way", refText({ kind: "db", project: "blog", service: "main", field: "url" }) === "${{ db.blog.main.url }}");
  r.check("host and url depend on where the app runs, the password does not", dependsOnOrigin({ kind: "db", project: null, service: "x", field: "host" }) && !dependsOnOrigin({ kind: "db", project: null, service: "x", field: "password" }) && !dependsOnOrigin({ kind: "project", slug: "x", field: "port" }));

  // --- precedence ---------------------------------------------------------
  const base = { id: "g1", name: "base", vars: [{ key: "A", value: "base-a" }, { key: "B", value: "base-b" }, { key: "C", value: "base-c" }] };
  const live = { id: "g2", name: "live", vars: [{ key: "B", value: "live-b" }, { key: "C", value: "live-c" }] };
  const merged = mergeLayers([base, live], [{ key: "C", value: "own-c" }, { key: "D", value: "own-d" }]);
  const at = (list, key) => list.find((v) => v.key === key);
  r.check("a group fills a name nobody else sets", at(merged, "A")?.source.name === "base" && at(merged, "A")?.raw === "base-a");
  r.check("a later group wins over an earlier one", at(merged, "B")?.source.name === "live" && at(merged, "B")?.raw === "live-b");
  r.check("and says whom it beat", at(merged, "B")?.overridden.map((s) => s.name).join() === "base");
  r.check("the project's own value wins over every group", at(merged, "C")?.source.kind === "own" && at(merged, "C")?.raw === "own-c");
  r.check("with the losers listed closest first", at(merged, "C")?.overridden.map((s) => s.name).join() === "live,base");
  r.check("two groups on a name is a conflict worth showing", JSON.stringify(groupConflict(at(merged, "B"))) === JSON.stringify(["base"]));
  r.check("an own value over groups is an override, not a conflict", groupConflict(at(merged, "C")) === null);

  const injected = applyInjected(merged, [{ key: "C", source: { kind: "database", id: "s1", name: "main" }, value: "postgresql://x" }]);
  r.check("an enabled database link wins over everything", at(injected, "C")?.source.kind === "database" && at(injected, "C")?.value === "postgresql://x");
  r.check("and the project's value is listed as replaced", at(injected, "C")?.overridden[0]?.kind === "own");

  // --- resolution ---------------------------------------------------------
  const groups = {
    smtp: { HOST: "mail.example.com", PORT: "587", URL: "smtp://${{ shared.smtp.HOST }}:${{ shared.smtp.PORT }}", EMPTY: "" },
    loop: { A: "${{ shared.loop.B }}", B: "x-${{ shared.loop.C }}", C: "${{ shared.loop.A }}", SELF: "${{ shared.loop.SELF }}" },
    bad: { BROKEN: "${{ shared.nope" },
  };
  const lookup = {
    shared(group, key) {
      const g = groups[group];
      if (!g) return { problem: `il gruppo «${group}» non esiste su questo server` };
      if (!(key in g)) return { problem: `il gruppo «${group}» non ha la variabile ${key}` };
      return { value: g[key] };
    },
    resource(ref) {
      if (ref.kind === "db" && ref.service === "main") return { value: ref.field === "host" ? "runpanel-svc-main" : "secret" };
      if (ref.kind === "project" && ref.slug === "api") return { value: ref.field === "port" ? "4000" : "localhost" };
      return { problem: ref.kind === "db" ? `non c'è un database senza progetto chiamato «${ref.service}» su questo server` : `non c'è un progetto «${ref.slug}» su questo server` };
    },
  };
  const own = (pairs) => mergeLayers([], pairs);
  const resolved = (pairs, opts) => resolveEffective(own(pairs), lookup, opts);

  let res = resolved([{ key: "MAIL", value: "${{ shared.smtp.HOST }}" }]);
  r.check("a shared reference resolves", res.env.MAIL === "mail.example.com" && res.problems.length === 0, JSON.stringify(res));
  res = resolved([{ key: "MAIL_URL", value: "${{ shared.smtp.URL }}" }]);
  r.check("references nest", res.env.MAIL_URL === "smtp://mail.example.com:587", JSON.stringify(res));
  r.check("and every reference read is recorded", res.vars[0].refs.length === 3, JSON.stringify(res.vars[0].refs));
  res = resolved([{ key: "DSN", value: "pg://${{ db.main.host }}:5432 for ${{ project.api.url }}" }]);
  r.check("database and project references go to the lookup", res.env.DSN === "pg://runpanel-svc-main:5432 for localhost", JSON.stringify(res));
  res = resolved([{ key: "T", value: "keep $${{ shared.smtp.HOST }}" }]);
  r.check("an escaped reference reaches the app as text", res.env.T === "keep ${{ shared.smtp.HOST }}", JSON.stringify(res));

  // A referenced value is inserted, never read again as a template.
  const literalGroups = { lit: { X: "$${{ shared.smtp.HOST }}" } };
  res = resolveEffective(own([{ key: "Y", value: "${{ shared.lit.X }}" }]), { ...lookup, shared: (g, k) => (literalGroups[g]?.[k] !== undefined ? { value: literalGroups[g][k] } : lookup.shared(g, k)) });
  r.check("a resolved value is not expanded a second time", res.env.Y === "${{ shared.smtp.HOST }}", JSON.stringify(res));

  // --- what does not resolve ---------------------------------------------
  res = resolved([{ key: "MISSING_GROUP", value: "${{ shared.nothere.X }}" }]);
  r.check("a missing group stops it, with no value", res.env.MISSING_GROUP === undefined && res.vars[0].value === null, JSON.stringify(res));
  r.check("and the sentence names the variable and the group", /La variabile MISSING_GROUP usa \$\{\{ shared\.nothere\.X \}\}, ma il gruppo «nothere» non esiste/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "MISSING_KEY", value: "${{ shared.smtp.USER }}" }]);
  r.check("a missing name in a group is named", /non ha la variabile USER/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "MISSING_DB", value: "${{ db.other.url }}" }]);
  r.check("a missing database is named", /La variabile MISSING_DB .*«other»/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "E", value: "x${{ shared.smtp.EMPTY }}" }]);
  r.check("a reference to an empty value is refused, not inserted empty", res.env.E === undefined && /EMPTY del gruppo «smtp» è vuota/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "WRONG", value: "${{ shared.smtp" }]);
  r.check("a value written wrong is a problem on its own variable", /La variabile WRONG ha un riferimento scritto male/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "NESTED_WRONG", value: "${{ shared.bad.BROKEN }}" }]);
  r.check("one written wrong further down names where", /BROKEN del gruppo «bad» ha un riferimento scritto male/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);

  // --- cycles -------------------------------------------------------------
  res = resolved([{ key: "LOOP", value: "${{ shared.loop.A }}" }]);
  r.check("a cycle stops it, with no value", res.env.LOOP === undefined && res.problems.length === 1, JSON.stringify(res));
  r.check("and says it is circular, with the path", /usa \$\{\{ shared\.loop\.A \}\}, che usa \$\{\{ shared\.loop\.B \}\}, che usa \$\{\{ shared\.loop\.C \}\}, che usa \$\{\{ shared\.loop\.A \}\}: è un riferimento circolare/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "S", value: "${{ shared.loop.SELF }}" }]);
  r.check("a variable that reads itself is a cycle too", /circolare/.test(res.problems[0]?.message ?? ""), res.problems[0]?.message);
  res = resolved([{ key: "FIRST", value: "${{ shared.loop.B }}" }, { key: "SECOND", value: "${{ shared.loop.A }}" }]);
  r.check("every variable that reaches a cycle is stopped", res.problems.length === 2 && res.env.FIRST === undefined && res.env.SECOND === undefined, JSON.stringify(res.problems));
  r.check("each told the loop as it meets it", /FIRST usa \$\{\{ shared\.loop\.B \}\}/.test(res.problems.find((p) => p.key === "FIRST")?.message ?? "") && /SECOND usa \$\{\{ shared\.loop\.A \}\}/.test(res.problems.find((p) => p.key === "SECOND")?.message ?? ""), JSON.stringify(res.problems));

  // An attached group whose own variable loops is caught from inside the group.
  const loopLayer = { id: "gl", name: "loop", vars: Object.entries(groups.loop).map(([key, value]) => ({ key, value })) };
  res = resolveEffective(mergeLayers([loopLayer], []), lookup);
  r.check("an attached group's loop is reported on each of its variables", res.problems.length === 4 && res.problems.every((p) => p.source.kind === "group"), JSON.stringify(res.problems.map((p) => p.key)));
  r.check("naming the group", /La variabile A del gruppo «loop»/.test(res.problems.find((p) => p.key === "A")?.message ?? ""));

  // A name a database link replaces never reaches the app, so it cannot stop the deploy.
  res = resolved([{ key: "DATABASE_URL", value: "${{ shared.nothere.X }}" }], { skip: new Set(["DATABASE_URL"]) });
  r.check("a value replaced by a database link is not resolved", res.problems.length === 0, JSON.stringify(res.problems));

  // --- the shared graph ---------------------------------------------------
  const cycle = findCycle([{ name: "loop", vars: loopLayer.vars }]);
  r.check("findCycle returns the loop, first node repeated", Array.isArray(cycle) && cycle[0] === cycle[cycle.length - 1] && cycle.length >= 2, JSON.stringify(cycle));
  r.check("findCycle is null when there is none", findCycle([{ name: "smtp", vars: Object.entries(groups.smtp).map(([key, value]) => ({ key, value })) }]) === null);
  const closure = sharedClosure(["${{ shared.smtp.URL }}"], (g, k) => groups[g]?.[k] ?? null);
  r.check("the closure follows nested references", closure.has("smtp.URL") && closure.has("smtp.HOST") && closure.has("smtp.PORT"), JSON.stringify([...closure]));
  r.check("and terminates on a cycle", sharedClosure(["${{ shared.loop.A }}"], (g, k) => groups[g]?.[k] ?? null).size === 3);

  return r.result();
}
