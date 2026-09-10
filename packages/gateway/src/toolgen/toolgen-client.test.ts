import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ToolgenBroker } from "./toolgen-broker.ts";
import {
  buildToolSpawnSpec,
  type GeneratedToolHandle,
  ioFromSpawnedChild,
  type ToolChildIo,
  wireExitCallback,
  wireToolProtocol,
} from "./toolgen-client.ts";
import { ToolgenRegistry } from "./toolgen-registry.ts";
import { emitToolScript } from "./toolgen-stub.ts";
import { BROKERED_FETCH_METHOD, type ToolgenEnvelope } from "./toolgen-types.ts";

const envelope: ToolgenEnvelope = {
  sessionId: "s1",
  scriptPath: "/opt/nimbus/toolgen/tg_a/index.ts",
  approvedAt: 1,
  artifact: {
    toolId: "tg_a",
    toolName: "t",
    description: "d",
    body: "b",
    approvedHosts: [],
    credentialHosts: [],
    manifest: {
      id: "toolgen.tg_a",
      version: "0.0.0",
      permissions: { network: [], filesystem: { read: ["/opt/nimbus/toolgen/tg_a"], write: [] } },
      updateChannel: "stable",
    },
    inputSchema: { type: "object", properties: {} },
  },
};

describe("buildToolSpawnSpec", () => {
  const spec = buildToolSpawnSpec(envelope, "/opt/nimbus/toolgen/tg_a");

  test("the script is IMPORTED via -e, never named as the entry point", () => {
    // `bun run <file>` fails under the Windows AppContainer with CouldntReadCurrentDirectory
    // (measured; see exec/exec-runtimes.ts). import() of a granted file works.
    expect(spec.args.join(" ")).toContain("-e");
    expect(spec.args.join(" ")).toContain("import(");
    expect(spec.args).not.toContain("run");
  });

  test("the command line stays far below the Windows 32767 limit regardless of body size", () => {
    expect([spec.command, ...spec.args].join(" ").length).toBeLessThan(4096);
  });

  test("the spawn goes through wrapServerSpec, so the sandbox policy env is set", () => {
    expect(spec.env["NIMBUS_SANDBOX_POLICY_JSON"]).toBeDefined();
    expect(JSON.parse(spec.env["NIMBUS_SANDBOX_POLICY_JSON"] ?? "{}")).toMatchObject({
      permissions: { network: [] },
    });
  });

  test("the file:// URL is built correctly on THIS platform, backslashes included on Windows", () => {
    // `pathToFileURL` (not manual string surgery) is what makes this correct on Windows: a
    // `C:\...` path needs its separators normalised AND its reserved characters percent-encoded
    // before it is a valid URL, and hand-rolling that is exactly the kind of thing that looks
    // right on POSIX and silently breaks on the other platform.
    const href = pathToFileURL(envelope.scriptPath).href;
    expect(spec.args.join(" ")).toContain(JSON.stringify(href));
  });
});

describe("coverage", () => {
  test("the tool class is per-call now that a generated tool can make a request", () => {
    expect(THIS_BINARY_COVERAGE.tool).toBe("per-call");
  });
});

/** A broker that must never actually be called in a test whose script body makes no fetch. */
function unreachableBroker(): ToolgenBroker {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return new ToolgenBroker({
    db,
    now: () => 1,
    maxRequestsPerTool: 0,
    requestTimeoutMs: 1_000,
    resolveHost: async () => {
      throw new Error("unreachableBroker: resolveHost must not be called by this test");
    },
    readCredential: async () => null,
    approvedHostsFor: () => [],
    credentialHostsFor: () => [],
    doFetch: async () => {
      throw new Error("unreachableBroker: doFetch must not be called by this test");
    },
  });
}

describe("runtime round trip", () => {
  // An earlier review noted the emitted protocol's newline framing (emitToolScript writes a "\n"
  // terminator, wireToolProtocol's reader splits on one) was proven only by inspection — if the two
  // ever disagreed, the protocol would deadlock at runtime with no unit test noticing. This test
  // closes that gap by spawning a REAL generated script and driving a REAL describe/call round trip
  // through the production client code (`wireToolProtocol` + the exported `ioFromSpawnedChild`
  // adapter — the exact same functions `spawnGeneratedTool` itself calls).
  //
  // The child here is spawned directly with a raw `Bun.spawn([bunExe, "-e", "import(...)"])` —
  // deliberately NOT through `buildToolSpawnSpec` — because `buildToolSpawnSpec`'s output re-launches
  // this binary in the `__nimbus-sandbox` role, which WOULD invoke real OS-level sandbox confinement
  // (bwrap / sandbox-exec / AppContainer) the moment it's spawned, now that `spawnGeneratedTool`
  // spawns that wrapped spec plainly with no separate opt-out layer. Driving that from a unit test
  // is impractical and is not this test's job: Task 18 covers confinement. The point here is the
  // WIRE PROTOCOL, not the sandbox — so this test exercises everything downstream of the spawn
  // (`ioFromSpawnedChild` + `wireToolProtocol`) without exercising the spawn's OWN confinement.
  test("a real spawned child answers a real describe and a real call over the wire protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-roundtrip-"));
    try {
      const scriptPath = join(dir, "index.ts");
      writeFileSync(
        scriptPath,
        emitToolScript({
          toolId: "rt1",
          toolName: "Round Trip Tool",
          description: "adds two numbers",
          body: "return { ok: true, sum: (args.a ?? 0) + (args.b ?? 0) };",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        }),
      );

      const href = pathToFileURL(scriptPath).href;
      const child = Bun.spawn<"pipe", "pipe", "inherit">({
        cmd: [process.execPath, "-e", `await import(${JSON.stringify(href)});`],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      const handle = wireToolProtocol(
        ioFromSpawnedChild(child),
        { ...envelope, scriptPath },
        unreachableBroker(),
      );
      try {
        const described = await handle.describe();
        expect(described).toEqual({
          name: "Round Trip Tool",
          description: "adds two numbers",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
          },
        });

        const called = await handle.call({ a: 2, b: 3 });
        expect(called).toEqual({ ok: true, sum: 5 });
      } finally {
        // Belt and suspenders: handle.close() already kills+waits, but a failing assertion above
        // must not leave a child running either.
        await handle.close();
        child.kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("wireToolProtocol — a wedged child does not hang a call forever (minor: bounded request timeout)", () => {
  test("call() rejects once the given timeout elapses, when the child never replies", async () => {
    const io: ToolChildIo = {
      writeLine: () => {
        /* the "child" never writes a reply back */
      },
      onStdoutData: () => {},
      kill: () => {},
      waitExit: () => new Promise(() => {}), // never exits either, for this test's purposes
    };
    // A tiny override so the test doesn't wait out the real (60s) default.
    const handle = wireToolProtocol(io, envelope, unreachableBroker(), 25);
    await expect(handle.call({})).rejects.toThrow(/did not respond/);
  });

  test("a reply that DOES arrive before the timeout still resolves normally", async () => {
    let onData: ((chunk: Uint8Array) => void) | undefined;
    const io: ToolChildIo = {
      writeLine: (line) => {
        const msg = JSON.parse(line) as { id: string };
        // Reply immediately, well inside the timeout window.
        onData?.(
          new TextEncoder().encode(`${JSON.stringify({ id: msg.id, result: { ok: true } })}\n`),
        );
      },
      onStdoutData: (cb) => {
        onData = cb;
      },
      kill: () => {},
      waitExit: () => new Promise(() => {}),
    };
    const handle = wireToolProtocol(io, envelope, unreachableBroker(), 25);
    await expect(handle.call({})).resolves.toEqual({ ok: true });
  });
});

describe("wireExitCallback", () => {
  test("fires once, only once waitExit resolves — not before, not synchronously", async () => {
    let calls = 0;
    let resolveExit: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const io: ToolChildIo = {
      writeLine: () => {},
      onStdoutData: () => {},
      kill: () => {},
      waitExit: () => exited,
    };
    wireExitCallback(io, () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    resolveExit();
    await exited;
    // Flush the microtask queue so the `.then()` chained onto `exited` inside `wireExitCallback`
    // has had a turn to run.
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});

describe("a generated tool's exit is observed and marks it terminated (load-bearing #3)", () => {
  // Deliberately NOT through `buildToolSpawnSpec` -- same reasoning as the "runtime round trip"
  // test above: sandbox confinement is `buildToolSpawnSpec`/Task 18's concern (covered by
  // `test/integration/toolgen/toolgen-network-denied.test.ts`), not this test's. This exercises
  // the REAL exit-detection code (`wireExitCallback`, over the REAL `ioFromSpawnedChild` adapter)
  // against a REAL, unsandboxed child that exits on its own -- proving the wiring a previous
  // review found had no production caller now actually observes a dead tool and updates a REAL
  // `ToolgenRegistry`, which is what makes `forSession`'s "live tools only" claim true.
  test("a child that exits on its own marks the tool terminated and it drops out of forSession", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-exit-"));
    try {
      const scriptPath = join(dir, "index.mjs");
      // Exits immediately and on its own -- standing in for a crash, distinct from an
      // owner-initiated `close()`/`revoke()`, which this test does not call at all.
      writeFileSync(scriptPath, "process.exit(3);\n");

      const child = Bun.spawn<"pipe", "pipe", "inherit">({
        cmd: [
          process.execPath,
          "-e",
          `await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      const io = ioFromSpawnedChild(child);

      const registry = new ToolgenRegistry();
      const toolEnvelope: ToolgenEnvelope = { ...envelope, scriptPath, sessionId: "s1" };
      registry.register(toolEnvelope, async () => {
        child.kill();
      });
      wireExitCallback(io, () => registry.markTerminated(toolEnvelope.artifact.toolId));
      // wireToolProtocol is not needed for this test's assertions, but wiring it mirrors what
      // `spawnGeneratedTool` actually does (broker requests would otherwise never be served).
      wireToolProtocol(io, toolEnvelope, unreachableBroker());

      expect(registry.forSession("s1")).toHaveLength(1);
      expect(registry.isTerminated(toolEnvelope.artifact.toolId)).toBe(false);

      await child.exited;
      // Flush the microtask queue for the `.then()` `wireExitCallback` chained onto `waitExit()`.
      await Promise.resolve();
      await Promise.resolve();

      expect(registry.isTerminated(toolEnvelope.artifact.toolId)).toBe(true);
      expect(registry.forSession("s1")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
// ---------------------------------------------------------------------------------------------
// Wire-protocol narrowing. Every line a generated tool writes is untrusted input (non-negotiable
// 7): the child is model-authored code the owner approved once, not a trusted peer. These drive
// `wireToolProtocol` through a fully controllable `ToolChildIo` so each malformed shape is fed in
// deliberately, rather than hoping a real child happens to produce one.
// ---------------------------------------------------------------------------------------------
interface ControllableIo {
  readonly io: ToolChildIo;
  /** Feed raw bytes to the protocol reader, exactly as a child's stdout would. */
  readonly feed: (s: string) => void;
  /** Every line the gateway wrote back to the child, parsed. */
  /** Feed raw bytes, for split multi-byte sequences a string cannot express. */
  readonly feedBytes: (b: Uint8Array) => void;
  readonly writes: Array<Record<string, unknown>>;
  readonly kills: () => number;
  readonly signals: () => Array<NodeJS.Signals | number | undefined>;
}

function controllableIo(opts: { neverExits?: boolean } = {}): ControllableIo {
  const writes: Array<Record<string, unknown>> = [];
  let onData: ((chunk: Uint8Array) => void) | undefined;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let killCount = 0;
  const exited =
    opts.neverExits === true ? new Promise<void>(() => {}) : Promise.resolve<void>(undefined);
  return {
    io: {
      writeLine: (line) => writes.push(JSON.parse(line) as Record<string, unknown>),
      onStdoutData: (cb) => {
        onData = cb;
      },
      kill: (signal) => {
        killCount += 1;
        signals.push(signal);
      },
      waitExit: () => exited,
    },
    feed: (s) => onData?.(new TextEncoder().encode(s)),
    feedBytes: (b) => onData?.(b),
    writes,
    kills: () => killCount,
    signals: () => signals,
  };
}

describe("wireToolProtocol -- an unparseable or unrecognised line is DROPPED, never guessed at", () => {
  // The failure mode this guards is worse than a crash: a line that half-parses into something
  // with a plausible `id` could spuriously resolve a pending `describe`/`call` with garbage, and
  // the caller would have no way to tell that from a real reply.
  test.each([
    ["a line that is not JSON at all", "}{"],
    ["a JSON null", "null"],
    ["a JSON array", "[1,2]"],
    ["a JSON scalar", "42"],
    ["an object with no id", '{"result":{"ok":true}}'],
    ["an object whose id is not a string", '{"id":7,"result":{"ok":true}}'],
    ["a reply whose id matches no pending request", '{"id":"nobody","result":{"ok":true}}'],
    ["an inbound request naming a method we do not serve", '{"id":"g1","method":"sudo"}'],
  ])("%s does not settle a pending call", async (_label, line) => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 40);
    const pending = handle.call({});
    c.feed(`${line}\n`);
    // The call is still outstanding, so it can only end at the timeout.
    await expect(pending).rejects.toThrow(/did not respond/);
  });

  test("blank lines between real messages are skipped without disturbing framing", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    const pending = handle.call({});
    const id = c.writes[0]?.["id"] as string;
    const reply = JSON.stringify({ id, result: { ok: 1 } });
    // Two blank lines, then a SPLIT message -- the reader has to reassemble across chunk
    // boundaries as well as tolerate the empties.
    c.feed("\n\n");
    c.feed(reply.slice(0, 8));
    c.feed(`${reply.slice(8)}\n`);
    await expect(pending).resolves.toEqual({ ok: 1 });
  });

  test("an inbound request with an unknown method cannot resolve a pending call SHARING its id", async () => {
    // The specific trap: the child picks an id equal to one of ours. A request (it carries a
    // `method`) must never be treated as a reply, whatever its id.
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 40);
    const pending = handle.call({});
    const id = c.writes[0]?.["id"] as string;
    c.feed(`${JSON.stringify({ id, method: "whatever", result: { ok: true } })}\n`);
    await expect(pending).rejects.toThrow(/did not respond/);
  });
});

describe("wireToolProtocol -- an error reply rejects the caller, whatever shape it carries", () => {
  test("a string error becomes the rejection message verbatim", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    const pending = handle.call({});
    const id = c.writes[0]?.["id"] as string;
    c.feed(`${JSON.stringify({ id, error: "the tool body threw" })}\n`);
    await expect(pending).rejects.toThrow("the tool body threw");
  });

  test("a structured (non-string) error is serialised rather than becoming '[object Object]'", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    const pending = handle.call({});
    const id = c.writes[0]?.["id"] as string;
    c.feed(`${JSON.stringify({ id, error: { code: "E_TOOL", detail: "bad" } })}\n`);
    await expect(pending).rejects.toThrow(/E_TOOL/);
  });
});

describe("wireToolProtocol -- a brokered fetch is the tool's ONLY route out (invariant I39)", () => {
  /** A broker that answers one approved host, so the happy fetch path is real rather than stubbed. */
  function workingBroker(): ToolgenBroker {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    return new ToolgenBroker({
      db,
      now: () => 1,
      maxRequestsPerTool: 5,
      requestTimeoutMs: 1_000,
      resolveHost: async () => ["93.184.216.34"],
      readCredential: async () => null,
      approvedHostsFor: () => ["api.example.com"],
      credentialHostsFor: () => [],
      doFetch: async () => new Response("payload", { status: 200 }),
    });
  }

  async function firstWrite(c: ControllableIo): Promise<Record<string, unknown>> {
    for (let i = 0; i < 400 && c.writes.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const w = c.writes[0];
    if (w === undefined) throw new Error("the gateway never answered the brokered fetch");
    return w;
  }

  test("a brokered fetch request is served and its result returned to the child on the same id", async () => {
    const c = controllableIo();
    wireToolProtocol(c.io, envelope, workingBroker(), 5_000);
    c.feed(
      `${JSON.stringify({
        id: "f1",
        method: BROKERED_FETCH_METHOD,
        params: { url: "https://api.example.com/v1" },
      })}\n`,
    );
    const reply = await firstWrite(c);
    expect(reply["id"]).toBe("f1");
    expect(reply["result"]).toMatchObject({ status: 200, body: "payload" });
    expect(reply["error"]).toBeUndefined();
  });

  test("a broker REFUSAL comes back as an error on the same id -- never as a silent success", async () => {
    // `unreachableBroker` has a zero-request budget, so this exercises the real refusal path
    // (`ERR_TOOLGEN_BUDGET_EXHAUSTED`) rather than a thrown fake.
    const c = controllableIo();
    wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    c.feed(
      `${JSON.stringify({
        id: "f2",
        method: BROKERED_FETCH_METHOD,
        params: { url: "https://api.example.com/v1" },
      })}\n`,
    );
    const reply = await firstWrite(c);
    expect(reply["id"]).toBe("f2");
    expect(reply["result"]).toBeUndefined();
    expect(String(reply["error"])).toContain("budget");
  });
});

describe("GeneratedToolHandle -- describe() tolerates a child that answers badly", () => {
  function answering(result: unknown): GeneratedToolHandle {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    // Answer whatever the handle asks, on the next turn, with the given result.
    queueMicrotask(() => {
      const id = c.writes[0]?.["id"] as string | undefined;
      if (id !== undefined) c.feed(`${JSON.stringify({ id, result })}\n`);
    });
    return handle;
  }

  test("a non-object describe result falls back to the APPROVED tool name, not an empty one", async () => {
    // The name shown to the model has to come from the artifact the owner approved when the child
    // declines to supply one -- never from nothing.
    await expect(answering("not an object").describe()).resolves.toEqual({
      name: envelope.artifact.toolName,
      description: "",
      inputSchema: undefined,
    });
  });

  test("a describe result with non-string fields falls back field by field", async () => {
    await expect(answering({ name: 42, description: null }).describe()).resolves.toEqual({
      name: envelope.artifact.toolName,
      description: "",
      inputSchema: undefined,
    });
  });

  test("a well-formed describe result is used as-is", async () => {
    await expect(
      answering({ name: "real-name", description: "real-desc" }).describe(),
    ).resolves.toEqual({ name: "real-name", description: "real-desc", inputSchema: undefined });
  });

  test("a describe result carrying an inputSchema is passed through UNVALIDATED — the registry's artifact remains the source of truth", async () => {
    const schema = { type: "object", properties: { owner: { type: "string" } } };
    await expect(
      answering({ name: "real-name", description: "real-desc", inputSchema: schema }).describe(),
    ).resolves.toEqual({ name: "real-name", description: "real-desc", inputSchema: schema });
  });
});

describe("GeneratedToolHandle.close()", () => {
  test("a call made AFTER close is rejected outright, never written to a dead child", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    await handle.close();
    const writesBefore = c.writes.length;
    await expect(handle.call({})).rejects.toThrow(/closed/);
    expect(c.writes).toHaveLength(writesBefore);
  });

  test("close() is idempotent -- a second call neither re-kills the child nor hangs", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    await handle.close();
    expect(c.kills()).toBe(1);
    await handle.close();
    expect(c.kills()).toBe(1);
  });

  test("close() fails every in-flight call rather than leaving it to time out", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 30_000);
    const pending = handle.call({});
    await handle.close();
    // The request timeout is 30s, so anything but an immediate rejection here hangs this test.
    await expect(pending).rejects.toThrow(/closed/);
  });

  test("a child that never exits is ESCALATED to SIGKILL, not merely waited out", async () => {
    // `waitExit()` here never resolves, the way a wedged child's would not. Resolving `close()`
    // without escalating would report a clean shutdown drain while the process survived the
    // gateway -- `ToolgenRegistry.revokeAll` awaits these calls and treats resolution as success.
    const c = controllableIo({ neverExits: true });
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    const started = Date.now();
    await handle.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    // Two kills: the graceful SIGTERM first, then the escalation once the window expired.
    expect(c.kills()).toBe(2);
    expect(c.signals()).toEqual([undefined, "SIGKILL"]);
  }, 15_000);

  test("a child that exits promptly is NOT escalated -- SIGKILL is the exception, not the path", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    await handle.close();
    expect(c.kills()).toBe(1);
    expect(c.signals()).toEqual([undefined]);
  });
});

describe("wireToolProtocol -- a multi-byte character split across pipe chunks survives", () => {
  // The corruption this guards is silent, which is what makes it worth a test: decoding each
  // chunk independently turns the two halves of one UTF-8 sequence into U+FFFD on both sides, the
  // surrounding JSON still parses, and the caller receives a result that is subtly wrong rather
  // than an error. An ASCII-only split-chunk test cannot see it -- every ASCII byte is its own
  // complete sequence -- so this one splits INSIDE a character.
  test("a 4-byte emoji cut in half across two chunks is reassembled, not replaced", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    const pending = handle.call({});
    const id = c.writes[0]?.["id"] as string;

    const payload = `${JSON.stringify({ id, result: { text: "café 🚀 naïve" } })}\n`;
    const bytes = new TextEncoder().encode(payload);
    // Find a split point that lands strictly INSIDE the emoji's 4-byte sequence: a continuation
    // byte is 0b10xxxxxx, so cutting before one guarantees a torn character.
    const cut = bytes.findIndex((b) => (b & 0xc0) === 0x80 && b !== bytes[0]);
    expect(cut).toBeGreaterThan(0);

    c.feedBytes(bytes.slice(0, cut));
    c.feedBytes(bytes.slice(cut));

    await expect(pending).resolves.toEqual({ text: "café 🚀 naïve" });
  });

  test("a character split across THREE chunks (one byte at a time) still survives", async () => {
    const c = controllableIo();
    const handle = wireToolProtocol(c.io, envelope, unreachableBroker(), 5_000);
    const pending = handle.call({});
    const id = c.writes[0]?.["id"] as string;
    const bytes = new TextEncoder().encode(`${JSON.stringify({ id, result: "日本語" })}\n`);
    for (const b of bytes) c.feedBytes(new Uint8Array([b]));
    await expect(pending).resolves.toBe("日本語");
  });
});

describe("end-to-end: non-ASCII survives a REAL spawned child in both directions", () => {
  // The two decoding fixes sit on opposite ends of one pipe -- `wireToolProtocol` reads the
  // child's stdout, `emitToolScript` reads the gateway's stdin -- and each was tested in
  // isolation against a fake. This drives a real child so a mismatch between the two ends cannot
  // hide behind agreeing fakes. The argument is large enough to make a chunk split likely, and
  // the body echoes it back so a corruption on EITHER leg shows up in the assertion.
  test("a large non-ASCII argument round-trips through a real child unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-toolgen-utf8-"));
    try {
      const scriptPath = join(dir, "index.ts");
      writeFileSync(
        scriptPath,
        emitToolScript({
          toolId: "u1",
          toolName: "Unicode Tool",
          description: "échoes ünicode 🚀",
          body: "return { echoed: args.text, len: args.text.length };",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        }),
      );
      const child = Bun.spawn<"pipe", "pipe", "inherit">({
        cmd: [
          process.execPath,
          "-e",
          `await import(${JSON.stringify(pathToFileURL(scriptPath).href)});`,
        ],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      const handle = wireToolProtocol(
        ioFromSpawnedChild(child),
        { ...envelope, scriptPath },
        unreachableBroker(),
      );
      try {
        // Long enough that the runtime is very likely to split it across pipe chunks, and mixed
        // 2-, 3- and 4-byte sequences so any tear lands inside a character rather than between.
        const text = "café 🚀 naïve 日本語 Ωμέγα ".repeat(400);
        const described = await handle.describe();
        expect(described.description).toBe("échoes ünicode 🚀");
        const called = (await handle.call({ text })) as { echoed: string; len: number };
        expect(called.echoed).toBe(text);
        expect(called.len).toBe(text.length);
        expect(called.echoed).not.toContain("�");
      } finally {
        await handle.close();
        child.kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
