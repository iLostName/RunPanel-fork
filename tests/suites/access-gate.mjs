import net from "node:net";
import os from "node:os";
import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * The gate itself: does a source the allowlist does not cover actually get
 * turned away, on a real socket?
 *
 * `access-rules-unit` proves the decision; this proves the plumbing carries it
 * out. They are worth separating because the failure modes are different — a
 * correct rule set in front of a forwarder that pipes first and checks later
 * would pass every check in the other suite.
 *
 * Standalone, and no Docker: `services/access-gate.ts` imports nothing but
 * `node:net` precisely so this can drive it directly.
 */
export const meta = { name: "access-gate", needsDocker: false, drivers: [], standalone: true };

/** An upstream that answers, so a forwarded connection is visibly forwarded. */
function echoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.pipe(socket));
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Connect, say something, and report what came back.
 *
 * Resolves rather than rejects on error: "was it refused" is the assertion, so
 * the refusal is data, not an exception.
 */
function probe(port, { host = "127.0.0.1", localAddress, payload = "ping", timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let data = "";
    let error = null;
    const socket = net.connect({ host, port, ...(localAddress ? { localAddress } : {}) });
    const finish = () => {
      socket.destroy();
      clearTimeout(timer);
      resolve({ data, error });
    };
    const timer = setTimeout(() => {
      error = error ?? "TIMEOUT";
      finish();
    }, timeout);

    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length >= payload.length) finish();
    });
    socket.on("error", (err) => {
      error = err.code ?? err.message;
    });
    socket.on("close", finish);
  });
}

/**
 * A client that stays connected, the way a database pool or a WebSocket does.
 *
 * Resolves once a round trip through the gate has worked, so the connection is
 * known to be forwarding before the suite does anything to it.
 */
function hold(port, { localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port, ...(localAddress ? { localAddress } : {}) });
    const closed = new Promise((done) => socket.once("close", () => done(true)));
    socket.on("error", () => {});
    socket.once("connect", () => socket.write("hold"));
    socket.once("data", () => resolve({ socket, closed }));
    setTimeout(() => reject(new Error("no round trip through the gate")), 3000).unref();
  });
}

/** Whether a promise settles in time, without ever hanging the suite. */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(true); }
    );
  });
}

/** A non-loopback IPv4 this machine holds, to originate a connection from. */
function ownLanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      const isV4 = entry.family === "IPv4" || entry.family === 4;
      if (isV4 && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
    }
  }
  return null;
}

export async function run({ repoRoot }) {
  const r = createReporter("access-gate");
  const { openGate, closeGate, closeAllGates, gateStatus, recentRejections, allocateLoopbackPort, GateError } =
    await import(pathToFileURL(join(repoRoot, "services", "access-gate.ts")).href);

  const upstream = await echoServer();
  const publicPort = await allocateLoopbackPort();

  const spec = (matches, extra = {}) => ({
    kind: "service",
    id: "suite",
    label: "suite",
    publicPort,
    targetPort: upstream.port,
    allow: [],
    matches,
    ...extra,
  });

  // A gate of its own on a port of its own, for the checks that keep a client
  // connected through it.
  const heldPort = { value: 0 };
  async function openHeld(makeSpec, id) {
    const port = await allocateLoopbackPort();
    heldPort.value = port;
    const open = (matches) => openGate(makeSpec(matches, { id, label: id, publicPort: port }));
    await open(() => true);
    return { port, open };
  }

  try {
    // --- an allowed source is forwarded ------------------------------------
    {
      await openGate(spec(() => true));
      const { data, error } = await probe(publicPort);
      r.check("an allowed source reaches the upstream", data === "ping", `${JSON.stringify(data)} ${error ?? ""}`);
    }

    // --- a refused source gets nothing --------------------------------------
    {
      // Same ports, different rules: this exercises the in-place swap, which is
      // what keeps editing the list from dropping the connections it still admits.
      await openGate(spec(() => false));
      const { data } = await probe(publicPort);
      r.check("a refused source receives no bytes", data === "", JSON.stringify(data));

      // Nothing is written before the check, so a refused caller cannot even
      // tell what is behind the port.
      const rejections = recentRejections("service", "suite");
      r.check("the refusal is remembered", rejections.length === 1, JSON.stringify(rejections));

      await probe(publicPort);
      const [again] = recentRejections("service", "suite");
      r.check("a second attempt counts against the same address", again.attempts === 2, String(again?.attempts));
      r.check("with a timestamp", typeof again.lastAt === "string" && again.lastAt.includes("T"));

      // Allowing the address that was knocking has to clear the notice about
      // it, or the page says "still blocked" right after unblocking it.
      await openGate(spec(() => true));
      r.check("allowing it clears the notice", recentRejections("service", "suite").length === 0,
        JSON.stringify(recentRejections("service", "suite")));
    }

    // --- the gate reports what is in force ----------------------------------
    {
      await openGate(spec(() => true, { allow: ["192.168.1.0/24"] }));
      const status = gateStatus("service", "suite");
      r.check("status names both ports", status.publicPort === publicPort && status.targetPort === upstream.port);
      r.check("and the rules in force", status.allow[0] === "192.168.1.0/24");
      r.check("an unknown target has no gate", gateStatus("service", "nope") === null);
    }

    // --- a source from the LAN, which is the case that matters --------------
    {
      const lan = ownLanAddress();
      if (!lan) {
        r.note("no non-loopback IPv4 on this machine: the LAN cases were not run");
      } else {
        // Loopback is admitted unconditionally by the real policy, so the
        // predicate here stands in for "the allowlist covers nobody else".
        await openGate(spec((address) => address.includes("127.0.0.1")));
        const refused = await probe(publicPort, { host: lan, localAddress: lan });
        r.check("a LAN source outside the list is refused", refused.data === "", JSON.stringify(refused.data));

        await openGate(spec((address) => address.includes(lan)));
        const allowed = await probe(publicPort, { host: lan, localAddress: lan });
        r.check("and passes once it is in", allowed.data === "ping", `${JSON.stringify(allowed.data)} ${allowed.error ?? ""}`);
      }
    }

    // --- an upstream that is not there --------------------------------------
    {
      const dead = await allocateLoopbackPort();
      await openGate(spec(() => true, { kind: "project", id: "dead", targetPort: dead, publicPort: await allocateLoopbackPort() }));
      const port = gateStatus("project", "dead").publicPort;
      const { data } = await probe(port);
      // The client is dropped rather than left hanging on a connection the gate
      // accepted and could not fulfil.
      r.check("a stopped upstream closes the client", data === "", JSON.stringify(data));
      await closeGate("project", "dead");
    }

    // --- the port is already taken ------------------------------------------
    {
      // What happens if a gate is opened before the container has released the
      // public port. It has to be an error the route can report, not a gate
      // that silently is not there.
      let caught = null;
      try {
        await openGate(spec(() => true, { id: "second" }));
      } catch (err) {
        caught = err;
      }
      r.check("a busy port throws", caught !== null);
      r.check("as a GateError", caught instanceof GateError, String(caught?.name));
      r.check("naming the port", caught?.port === publicPort, String(caught?.port));
      r.check("with the OS code", caught?.code === "EADDRINUSE", String(caught?.code));
    }

    // --- closing --------------------------------------------------------------
    {
      await closeGate("service", "suite");
      r.check("a closed gate has no status", gateStatus("service", "suite") === null);
      const { data, error } = await probe(publicPort, { timeout: 1500 });
      r.check("and the port is no longer answering", data === "" && error !== null, String(error));
    }

    // --- closing with a client still connected ---------------------------------
    {
      // A pooled database connection or a WebSocket never hangs up by itself,
      // and a restart or an access change waits on this call.
      const held = await hold((await openHeld(spec, "held")).port);
      const closing = closeGate("service", "held");
      r.check("closeGate returns with a client still connected", await settlesWithin(closing, 1500));
      r.check("and that client is disconnected", await settlesWithin(held.closed, 1500));
      held.socket.destroy();

      const { data, error } = await probe(heldPort.value, { timeout: 1500 });
      r.check("and the port is released", data === "" && error !== null, String(error));
    }

    // --- a listener that never reports closing ---------------------------------
    {
      const { port } = await openHeld(spec, "stuck");
      const held = await hold(port);
      const { server } = globalThis.__runpanelGates.get("service:stuck");
      const realClose = server.close.bind(server);
      // The handle goes, the callback never comes.
      server.close = () => { realClose(); return server; };

      const closing = closeGate("service", "stuck");
      r.check("closeGate has a deadline of its own", await settlesWithin(closing, 4000));
      r.check("and forgets the gate either way", gateStatus("service", "stuck") === null);
      held.socket.destroy();
    }

    // --- editing the rules with connections open --------------------------------
    {
      const revoked = "127.0.0.2";
      const { port, open } = await openHeld(spec, "edit");
      const staying = await hold(port);
      const leaving = await hold(port, { localAddress: revoked });

      await open(() => true);
      r.check(
        "rules that still admit everyone drop nobody",
        !(await settlesWithin(Promise.race([staying.closed, leaving.closed]), 300))
      );

      await open((address) => !address.endsWith(revoked));
      r.check("removing an address disconnects it", await settlesWithin(leaving.closed, 1500));
      r.check("and leaves the others connected", !(await settlesWithin(staying.closed, 300)));

      const reply = new Promise((done) => staying.socket.once("data", (chunk) => done(chunk.toString())));
      staying.socket.write("still");
      r.check("and they keep forwarding", (await Promise.race([reply, new Promise((done) => setTimeout(done, 1500))])) === "still");
      r.check("without counting the revoked one as refused", recentRejections("service", "edit").length === 0);

      staying.socket.destroy();
      await closeGate("service", "edit");
    }
  } finally {
    await closeAllGates();
    await upstream.close();
  }

  return r.result();
}
