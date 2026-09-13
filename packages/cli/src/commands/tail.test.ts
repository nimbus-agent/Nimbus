// packages/cli/src/commands/tail.test.ts
import { describe, expect, test } from "bun:test";
import type { IPCClient } from "../ipc-client/index.ts";
import { parseTailArgs, renderEvent, runTailCommand, type TailCommandDeps } from "./tail.ts";

describe("parseTailArgs", () => {
  test("defaults to every category and human output", () => {
    const a = parseTailArgs([]);
    expect(a.categories).toEqual(["connector", "watcher", "sync", "extension", "hitl"]);
    expect(a.json).toBe(false);
  });

  test("accepts a COMMA-SEPARATED list", () => {
    expect(parseTailArgs(["--filter", "connector,sync"]).categories).toEqual(["connector", "sync"]);
  });

  test("is REPEATABLE and unions the results", () => {
    expect(parseTailArgs(["--filter", "watcher", "--filter", "hitl"]).categories).toEqual([
      "watcher",
      "hitl",
    ]);
  });

  test("an unknown category FAILS FAST naming the valid set", () => {
    // A filter that silently matches nothing is indistinguishable from a quiet system — the exact
    // failure this command exists to prevent.
    expect(() => parseTailArgs(["--filter", "foobar"])).toThrow(/connector, watcher, sync/);
  });

  test("a --filter that resolves to ZERO categories FAILS FAST naming the valid set", () => {
    // The same failure class as the unknown-category check above, arrived at from the other
    // side: nothing was rejected by name, but nothing was selected either. Before this, both
    // `,` and `" , "` split into all-blank parts, `picked` stayed empty, and empty `picked` fell
    // back to ALL_CATEGORIES — a script assembling the flag value programmatically and landing on
    // an empty/comma-only string got an unfiltered firehose with no signal anything went wrong.
    expect(() => parseTailArgs(["--filter", ","])).toThrow(/connector, watcher, sync/);
    expect(() => parseTailArgs(["--filter", " , "])).toThrow(/connector, watcher, sync/);
  });

  test("a --filter with no value at all still fails as before (unchanged by the zero-category check)", () => {
    // `flagValue` already rejects a missing/blank value before the zero-category check is ever
    // reached, on a DIFFERENT message — pinning that this fix didn't change what a bare `--filter`
    // or `--filter ""` does.
    expect(() => parseTailArgs(["--filter"])).toThrow(/requires a value/);
    expect(() => parseTailArgs(["--filter", ""])).toThrow(/requires a value/);
  });

  test("--help throws the usage text, which states follow-only", () => {
    expect(() => parseTailArgs(["--help"])).toThrow(/follow-only/);
  });
});

describe("renderEvent", () => {
  test("renders a health change in the desktop's field names", () => {
    const line = renderEvent("connector.healthChanged", {
      name: "github",
      health: "degraded",
      fromState: "healthy",
      reason: "rate limited",
      occurredAt: 1_789_300_000_000,
    });
    expect(line).toContain("[connector]");
    expect(line).toContain("github");
    expect(line).toContain("healthy -> degraded");
    expect(line).toContain("rate limited");
  });

  test("renders a sync completion with item deltas", () => {
    const line = renderEvent("gateway.event", {
      kind: "sync.completed",
      ts: 1_789_300_000_000,
      payload: {
        serviceId: "slack",
        itemsUpserted: 14,
        itemsDeleted: 0,
        durationMs: 182,
        hasMore: false,
      },
    });
    expect(line).toContain("[sync]");
    expect(line).toContain("slack");
    expect(line).toContain("+14");
  });

  test("renders a watcher firing with its name and summary", () => {
    const line = renderEvent("gateway.event", {
      kind: "watcher.fired",
      ts: 1_789_300_000_000,
      payload: {
        watcherId: "w-42",
        name: "release branch watcher",
        summary: "3 new commits on release/7.22",
        firedAt: 1_789_300_000_000,
      },
    });
    expect(line).toContain("[watcher]");
    expect(line).toContain("release branch watcher");
    expect(line).toContain("3 new commits on release/7.22");
  });

  test("renders a failed extension action WITH its error", () => {
    // The reason this field exists at all: `extension.update` has ten non-applied outcomes
    // (signature check failed, downgrade refused, an update already in flight, ...) that read as
    // one indistinguishable `ok:false` without it.
    const line = renderEvent("gateway.event", {
      kind: "extension.stateChanged",
      ts: 1_789_300_000_000,
      payload: {
        extensionId: "nimbus-web-clipper",
        action: "update",
        ok: false,
        error: "signature_failed",
      },
    });
    expect(line).toContain("[extension]");
    expect(line).toContain("nimbus-web-clipper");
    expect(line).toContain("update");
    expect(line).toContain("failed: signature_failed");
  });

  test("renders a failed extension action with NO error cleanly", () => {
    const line = renderEvent("gateway.event", {
      kind: "extension.stateChanged",
      ts: 1_789_300_000_000,
      payload: { extensionId: "nimbus-web-clipper", action: "install", ok: false },
    });
    expect(line).toContain("(failed)");
    expect(line).not.toContain("(failed:");
  });

  test("renders a successful extension action with no failure suffix at all", () => {
    const line = renderEvent("gateway.event", {
      kind: "extension.stateChanged",
      ts: 1_789_300_000_000,
      payload: { extensionId: "nimbus-web-clipper", action: "enable", ok: true },
    });
    expect(line).not.toContain("failed");
  });

  test("renders a hitl request with its prompt", () => {
    const line = renderEvent("gateway.event", {
      kind: "hitl.requested",
      ts: 1_789_300_000_000,
      payload: { requestId: "req-9", prompt: "Approve deleting 3 stale branches?" },
    });
    expect(line).toContain("[hitl]");
    expect(line).toContain("req-9");
    expect(line).toContain("requested");
    expect(line).toContain("Approve deleting 3 stale branches?");
  });

  test("renders a rejected hitl resolution WITH its reason", () => {
    const line = renderEvent("gateway.event", {
      kind: "hitl.resolved",
      ts: 1_789_300_000_000,
      payload: { requestId: "req-9", approved: false, reason: "owner denied" },
    });
    expect(line).toContain("[hitl]");
    expect(line).toContain("req-9");
    expect(line).toContain("rejected");
    expect(line).toContain("owner denied");
  });

  test("renders an approved hitl resolution with NO reason cleanly", () => {
    const line = renderEvent("gateway.event", {
      kind: "hitl.resolved",
      ts: 1_789_300_000_000,
      payload: { requestId: "req-9", approved: true },
    });
    expect(line).toContain("approved");
    expect(line).not.toContain(" — ");
  });

  test("an UNKNOWN future kind still prints rather than being dropped", () => {
    // A stream that silently discards what it does not recognise is the same failure class as a
    // brief rendering a missing section as empty.
    const line = renderEvent("gateway.event", {
      kind: "some.future.kind",
      ts: 1_789_300_000_000,
      payload: { a: 1 },
    });
    expect(line).toContain("unknown: some.future.kind");
  });

  test("a malformed notification returns null instead of throwing", () => {
    expect(renderEvent("gateway.event", null)).toBeNull();
    expect(renderEvent("gateway.event", { kind: 7 })).toBeNull();
  });
});

describe("runTailCommand lifecycle", () => {
  function harness(over: Partial<TailCommandDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exits: number[] = [];
    const handlers: Record<string, (p: unknown) => void> = {};
    const client = {
      onNotification: (m: string, h: (p: unknown) => void) => {
        handlers[m] = h;
      },
      onClose: (_h: () => void) => {},
      disconnect: async () => {},
    } as unknown as IPCClient;
    const deps: TailCommandDeps = {
      connect: async () => client,
      readState: async () => ({ socketPath: "/tmp/fake.sock" }),
      writeOut: (l) => out.push(l),
      writeErr: (l) => err.push(l),
      onExit: (c) => exits.push(c),
      ...over,
    };
    return { deps, out, err, exits, handlers };
  }

  test("a gateway that is not running writes the standard line and exits 1", async () => {
    const h = harness({ readState: async () => undefined });
    await runTailCommand([], h.deps);
    expect(h.err.join("")).toContain("Gateway is not running");
    expect(h.exits).toEqual([1]);
  });

  /**
   * `runTailCommand` genuinely awaits `readState()` then `connect()` before it registers any
   * handler — real production behavior against a real Gateway socket. A caller that calls it and
   * inspects side effects on the very next synchronous line (no `await` in between) is checking
   * before that registration has had a chance to run: an `await`/`.then()` continuation, even on
   * an already-settled promise, is never visible to code still running in the same tick. A single
   * macrotask yield (`setImmediate`, not `Promise.resolve()` — a microtask-only yield is coupled
   * to exactly how many `await`s the implementation happens to have today) drains whatever is
   * pending regardless, so it stays correct if that chain grows a third `await` later.
   */
  function nextMacrotask(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }

  test("binds EXACTLY the two handlers, never a third", async () => {
    // The count is the design's central claim: a future operational event must arrive with no CLI
    // change. A third handler here means someone reintroduced a per-method list.
    const h = harness();
    const done = runTailCommand([], h.deps);
    await nextMacrotask();
    expect(Object.keys(h.handlers).sort()).toEqual(["connector.healthChanged", "gateway.event"]);
    process.emit("SIGINT");
    await done;
  });

  test("--filter excludes a known category it did not name", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    await nextMacrotask();
    h.handlers["connector.healthChanged"]?.({
      name: "github",
      health: "error",
      fromState: "healthy",
      reason: null,
      occurredAt: 1,
    });
    // POSITIVE CONTROL, in the same test and deliberately so. Asserting only that the excluded
    // event produced no output proves nothing: that assertion passes identically if the handler
    // was never registered at all, so on its own it cannot tell "the filter excluded it" from
    // "nothing was listening". Driving an INCLUDED event through the same handler map makes a live
    // registration a precondition of the pass, which is what gives the negative its meaning.
    h.handlers["gateway.event"]?.({
      kind: "sync.completed",
      ts: 1_789_300_000_000,
      payload: {
        serviceId: "slack",
        itemsUpserted: 14,
        itemsDeleted: 0,
        durationMs: 182,
        hasMore: false,
      },
    });
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[sync]");
    expect(h.out[0]).toContain("slack");
    expect(h.out.join("")).not.toContain("[connector]");
    process.emit("SIGINT");
    await done;
  });

  test("an UNKNOWN kind is shown even under a filter", async () => {
    // Deliberate: a stream that silently discards what it does not recognise is the failure this
    // design rejects. The plan review read this as "filtered out" — it is not.
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({ kind: "some.future.kind", ts: 1, payload: {} });
    expect(h.out.join("")).toContain("unknown: some.future.kind");
    process.emit("SIGINT");
    await done;
  });

  /**
   * `categoryOf`'s prefix checks (`"watcher."`, `"extension."`, `"hitl."`) were entirely untested
   * for both rendering AND filtering before this — a mutation that broke all three at once left
   * the suite green, and note the DIRECTION of that failure: `categoryOf` returns `null` for
   * anything unrecognised, and a `null` category is always shown regardless of filter (that's the
   * forward-compat guarantee for a truly future `kind`). So a regressed prefix check does not hide
   * these events — it makes them LEAK THROUGH any filter, e.g. `--filter sync` would start
   * printing watcher lines. Each test below proves BOTH directions through the SAME handler map,
   * following the positive-control shape above: an inclusion assertion (this kind's own filter
   * shows it) beside an exclusion assertion (a filter naming something else does not show a
   * DIFFERENT, known category) — either alone is satisfiable by a broken filter; together they are
   * not.
   */
  const syncControlEvent = {
    kind: "sync.completed",
    ts: 1,
    payload: {
      serviceId: "slack",
      itemsUpserted: 1,
      itemsDeleted: 0,
      durationMs: 1,
      hasMore: false,
    },
  };

  test("watcher.fired: included by a filter naming it, excluded from one that does not", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "watcher"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "watcher.fired",
      ts: 1,
      payload: {
        watcherId: "w1",
        name: "release watcher",
        summary: "3 commits landed",
        firedAt: 1,
      },
    });
    h.handlers["connector.healthChanged"]?.({
      name: "github",
      health: "error",
      fromState: "healthy",
      reason: null,
      occurredAt: 1,
    });
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[watcher]");
    expect(h.out[0]).toContain("release watcher");
    expect(h.out[0]).toContain("3 commits landed");
    expect(h.out.join("")).not.toContain("[connector]");
    process.emit("SIGINT");
    await done;
  });

  // The critical direction: a filter that does NOT name `watcher` must exclude a `watcher.fired`
  // event specifically (not just fail to include it — `categoryOf` returning `null` for a broken
  // prefix check would ALSO leave this event showing, since an uncategorised event is always
  // shown. Only a correctly-derived "watcher" category gets it excluded here). Paired with the
  // `sync.completed` positive control so the run is proven live.
  test("watcher.fired IS excluded (not merely uncategorised) by a filter that does not name it", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "watcher.fired",
      ts: 1,
      payload: {
        watcherId: "w1",
        name: "release watcher",
        summary: "3 commits landed",
        firedAt: 1,
      },
    });
    h.handlers["gateway.event"]?.(syncControlEvent);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[sync]");
    expect(h.out.join("")).not.toContain("watcher");
    process.emit("SIGINT");
    await done;
  });

  test("extension.stateChanged: included by a filter naming it, excluded from one that does not", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "extension"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "extension.stateChanged",
      ts: 1,
      payload: {
        extensionId: "nimbus-web-clipper",
        action: "update",
        ok: false,
        error: "signature_failed",
      },
    });
    h.handlers["connector.healthChanged"]?.({
      name: "github",
      health: "error",
      fromState: "healthy",
      reason: null,
      occurredAt: 1,
    });
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[extension]");
    expect(h.out[0]).toContain("nimbus-web-clipper");
    expect(h.out[0]).toContain("failed: signature_failed");
    expect(h.out.join("")).not.toContain("[connector]");
    process.emit("SIGINT");
    await done;
  });

  test("extension.stateChanged IS excluded (not merely uncategorised) by a filter that does not name it", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "extension.stateChanged",
      ts: 1,
      payload: {
        extensionId: "nimbus-web-clipper",
        action: "update",
        ok: false,
        error: "signature_failed",
      },
    });
    h.handlers["gateway.event"]?.(syncControlEvent);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[sync]");
    expect(h.out.join("")).not.toContain("extension");
    process.emit("SIGINT");
    await done;
  });

  test("hitl.requested: included by a filter naming it, excluded from one that does not", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "hitl"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "hitl.requested",
      ts: 1,
      payload: { requestId: "req-9", prompt: "Approve deleting 3 stale branches?" },
    });
    h.handlers["connector.healthChanged"]?.({
      name: "github",
      health: "error",
      fromState: "healthy",
      reason: null,
      occurredAt: 1,
    });
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[hitl]");
    expect(h.out[0]).toContain("req-9");
    expect(h.out[0]).toContain("Approve deleting 3 stale branches?");
    expect(h.out.join("")).not.toContain("[connector]");
    process.emit("SIGINT");
    await done;
  });

  test("hitl.requested IS excluded (not merely uncategorised) by a filter that does not name it", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "hitl.requested",
      ts: 1,
      payload: { requestId: "req-9", prompt: "Approve deleting 3 stale branches?" },
    });
    h.handlers["gateway.event"]?.(syncControlEvent);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[sync]");
    expect(h.out.join("")).not.toContain("req-9");
    process.emit("SIGINT");
    await done;
  });

  test("hitl.resolved: included by a filter naming it, excluded from one that does not", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "hitl"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "hitl.resolved",
      ts: 1,
      payload: { requestId: "req-9", approved: false, reason: "owner denied" },
    });
    h.handlers["connector.healthChanged"]?.({
      name: "github",
      health: "error",
      fromState: "healthy",
      reason: null,
      occurredAt: 1,
    });
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[hitl]");
    expect(h.out[0]).toContain("req-9");
    expect(h.out[0]).toContain("rejected");
    expect(h.out[0]).toContain("owner denied");
    expect(h.out.join("")).not.toContain("[connector]");
    process.emit("SIGINT");
    await done;
  });

  test("hitl.resolved IS excluded (not merely uncategorised) by a filter that does not name it", async () => {
    const h = harness();
    const done = runTailCommand(["--filter", "sync"], h.deps);
    await nextMacrotask();
    h.handlers["gateway.event"]?.({
      kind: "hitl.resolved",
      ts: 1,
      payload: { requestId: "req-9", approved: false, reason: "owner denied" },
    });
    h.handlers["gateway.event"]?.(syncControlEvent);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).toContain("[sync]");
    expect(h.out.join("")).not.toContain("req-9");
    process.emit("SIGINT");
    await done;
  });

  test("SIGINT removes its own listeners", async () => {
    // `process` outlives the promise; a leaked handler per invocation is invisible until a caller
    // runs the command twice in one process.
    const before = process.listenerCount("SIGINT");
    const h = harness();
    const done = runTailCommand([], h.deps);
    await nextMacrotask();
    process.emit("SIGINT");
    await done;
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
