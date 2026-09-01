import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  type CuBrowserSeams,
  type CuGateDeps,
  type CuTerminalSeams,
  closeSession,
  isCuActionKind,
  openSession,
  runAction,
} from "./cu-gate.ts";
import type { BrowserLane, ObservedNode, TerminalLane } from "./cu-types.ts";

interface Spy {
  approvals: number;
  actuations: number;
  /** Incremented every time a lane's `close()` is called (fix round 1, I-4). */
  closes: number;
}

interface LaneStubOptions {
  /** `lane.observe()` throws instead of returning a node (C-1: the classification stage). */
  throwOnObserve?: boolean;
  /** EVERY `lane.domSnapshot()` call throws (C-1: the pre-actuation observation stage). */
  throwOnDomSnapshot?: boolean;
  /** Only the SECOND `lane.domSnapshot()` call throws — the reviewer's headline scenario: the
   * actuation itself (e.g. a click) already happened on the host, and only the POST snapshot,
   * reading a CDP execution context the click's own navigation just destroyed, fails. */
  throwOnDomSnapshotAfter?: boolean;
  /** `click`/`type`/`navigate`/`screenshot` all throw instead of actuating (C-1: the actuation stage). */
  throwOnPerformActuation?: boolean;
  /** Drives `lane.isAlive()`. Defaults to "always alive". */
  alive?: () => boolean;
  /** Awaited inside `observe()`, so a test can interleave a close (or a second action) mid-flight. */
  observeGate?: () => Promise<void>;
  /** Called on entry to, and exit from, every actuation — records interleaving. */
  trace?: (event: string) => void;
}

/**
 * A `BrowserLane`-shaped stub. `click`/`type`/`navigate` each record an actuation; `observe`
 * always returns a node that IS a submit control (so `#submit` classifies as `actuating` in every
 * test that uses it) — `currentOrigin` matches the one origin every test approves.
 *
 * NOTE: this stub is written against the CURRENT `ObservedNode` contract (post Task 5+6 fix
 * round), which added `inForm`/`hrefScheme`/`hrefOrigin` as required fields after the plan's
 * original brief text was written (see the plan ledger's R21). The plan's own verbatim snippet
 * for this stub predates that fix round and would fail to typecheck against today's
 * `ObservedNode` — filled in here with safe, inert defaults for the three added fields.
 */
function laneStub(spy: Spy, opts: LaneStubOptions = {}): BrowserLane {
  const node: ObservedNode = {
    tagName: "BUTTON",
    type: null,
    inFormWithPassword: false,
    inForm: false,
    isSubmitControl: true,
    hrefScheme: null,
    hrefOrigin: null,
    accessibleName: "Submit",
  };
  let domSnapshotCalls = 0;
  return {
    observe: async () => {
      if (opts.throwOnObserve) throw new Error("driver: observe() failed");
      if (opts.observeGate !== undefined) await opts.observeGate();
      return node;
    },
    currentOrigin: () => "https://example.com",
    click: async () => {
      opts.trace?.("click:start");
      if (opts.throwOnPerformActuation) throw new Error("driver: click() failed");
      await Bun.sleep(1);
      spy.actuations += 1;
      opts.trace?.("click:end");
    },
    type: async () => {
      if (opts.throwOnPerformActuation) throw new Error("driver: type() failed");
      spy.actuations += 1;
    },
    navigate: async () => {
      if (opts.throwOnPerformActuation) throw new Error("driver: navigate() failed");
      spy.actuations += 1;
    },
    readText: async () => "page text",
    domSnapshot: async () => {
      domSnapshotCalls += 1;
      if (opts.throwOnDomSnapshot) {
        throw new Error("driver: domSnapshot() failed");
      }
      opts.trace?.(domSnapshotCalls % 2 === 1 ? "dom_before" : "dom_after");
      if (opts.throwOnDomSnapshotAfter && domSnapshotCalls === 2) {
        throw new Error(
          "driver: execution context was destroyed, most likely because of a navigation",
        );
      }
      return "<html></html>";
    },
    screenshot: async () => {
      if (opts.throwOnPerformActuation) throw new Error("driver: screenshot() failed");
      return new Uint8Array([1, 2, 3]);
    },
    isAlive: () => opts.alive?.() ?? true,
    close: async () => {
      spy.closes += 1;
    },
  };
}

function makeTestDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  return db;
}

/**
 * Overrides accepted by {@link deps}.
 *
 * The BROWSER seams are accepted FLAT (`assertLaunchable`, `openLane`, …) even though
 * `CuGateDeps` nests them under `lanes.browser`, and that is deliberate rather than lazy: every
 * one of this file's ~10 override sites predates the second lane and overrides exactly one seam.
 * Spreading them here keeps those sites reading as "this test differs in one thing", which is what
 * makes a fixture legible; requiring each to spell out a full nested `lanes` object would bury the
 * one differing line in boilerplate and would make the diff for adding a lane touch every test that
 * has nothing to do with it.
 */
type DepsOverride = Partial<Omit<CuGateDeps, "lanes">> &
  Partial<CuBrowserSeams> & { readonly lanes?: Partial<CuGateDeps["lanes"]> };

/**
 * A terminal lane that records what actually reached the shell.
 *
 * `writes` is the assertion surface for the whole lane: the buffering rules are only real if a
 * sequence of writes with no submit leaves this array EMPTY, and asserting a call count is what
 * catches a buffering path that silently became a write path.
 */
interface TerminalStub extends TerminalLane {
  writes: string[];
}

function terminalLaneStub(
  spy: Spy,
  opts: { alive?: () => boolean; throwOnWrite?: boolean } = {},
): TerminalStub {
  const writes: string[] = [];
  return {
    writes,
    write: async (bytes: string) => {
      spy.actuations += 1;
      if (opts.throwOnWrite === true) throw new Error("shell write failed");
      writes.push(bytes);
      return { output: `out:${bytes}`, settled: "quiet" as const, truncated: false };
    },
    isAlive: opts.alive ?? (() => true),
    close: async () => {
      spy.closes += 1;
    },
  };
}

function deps(
  over: DepsOverride = {},
  spy: Spy = { approvals: 0, actuations: 0, closes: 0 },
  laneOpts: LaneStubOptions = {},
): { deps: CuGateDeps; db: Database; spy: Spy } {
  const db = makeTestDb();
  const { buildLaunchPolicy, assertLaunchable, resolveBrowserPath, openLane, lanes, ...rest } =
    over;
  const browser: CuBrowserSeams = {
    buildLaunchPolicy: ({ profileDir }) => ({
      profileDir: profileDir === "" ? "/fake/profile" : profileDir,
      argv: ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=/fake/profile"],
    }),
    assertLaunchable: () => null,
    // Injected seams, so these tests run with no browser installed — and so `cu-gate.ts` never
    // imports the driver, which is what keeps it clear of D26(b).
    resolveBrowserPath: () => "/fake/chrome",
    openLane: async () => laneStub(spy, laneOpts),
    ...(buildLaunchPolicy === undefined ? {} : { buildLaunchPolicy }),
    ...(assertLaunchable === undefined ? {} : { assertLaunchable }),
    ...(resolveBrowserPath === undefined ? {} : { resolveBrowserPath }),
    ...(openLane === undefined ? {} : { openLane }),
    ...(lanes?.browser ?? {}),
  };
  const terminal: CuTerminalSeams = {
    defaultShellId: "sh",
    resolveShellPath: () => ({
      status: "ok",
      shellPath: "/fake/sh",
      argv: ["-s"],
      envOverlay: {},
    }),
    buildLaunchPolicy: ({ sessionId, shellId, shellPath, cwd }) => ({
      shellId,
      shellPath,
      argv: ["-s"],
      cwd,
      envOverlay: {},
      policy: {
        id: `cu-terminal-${sessionId}`,
        permissions: { network: [], filesystem: { read: [cwd], write: [cwd] } },
      },
    }),
    assertLaunchable: () => null,
    openLane: async () => terminalLaneStub(spy),
    ...(lanes?.terminal ?? {}),
  };
  const full: CuGateDeps = {
    config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: ["browser"] },
    enforced: { capabilitiesDisabled: new Set<string>() },
    requestApproval: async () => {
      spy.approvals += 1;
      return true;
    },
    lanes: { browser, terminal },
    db,
    now: () => 1000,
    newId: () => "id-1",
    ...rest,
  };
  return { deps: full, db, spy };
}

async function openDefault(d: CuGateDeps): Promise<string> {
  const sess = await openSession(
    { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
    d,
  );
  if (sess.status !== "open") throw new Error(`expected an open session, got ${sess.status}`);
  return sess.sessionId;
}

describe("openSession — refusals before consent", () => {
  test("config disabled refuses and NEVER prompts", async () => {
    const { deps: d, spy } = deps({
      config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: false },
    });
    const out = await openSession({ lane: "browser", navigateOrigins: [], scriptOrigins: [] }, d);
    expect(out.status).toBe("refused");
    expect(out.status === "refused" && out.code).toBe("ERR_CU_DISABLED");
    // The load-bearing half: a disabled capability must not advertise itself by prompting.
    expect(spy.approvals).toBe(0);
  });

  test("org policy disabled refuses and NEVER prompts", async () => {
    const { deps: d, spy } = deps({
      enforced: { capabilitiesDisabled: new Set(["computer_use"]) },
    });
    const out = await openSession({ lane: "browser", navigateOrigins: [], scriptOrigins: [] }, d);
    expect(out.status === "refused" && out.code).toBe("ERR_CU_POLICY_DISABLED");
    expect(spy.approvals).toBe(0);
  });

  test("a lane not in allowed_lanes refuses and NEVER prompts", async () => {
    const { deps: d, spy } = deps({
      config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: [] },
    });
    const out = await openSession({ lane: "browser", navigateOrigins: [], scriptOrigins: [] }, d);
    expect(out.status === "refused" && out.code).toBe("ERR_CU_LANE_NOT_ALLOWED");
    expect(spy.approvals).toBe(0);
  });

  test("an unsafe launch policy refuses and NEVER prompts", async () => {
    const { deps: d, spy } = deps({
      assertLaunchable: () => "launch argv carries --no-sandbox",
    });
    const out = await openSession({ lane: "browser", navigateOrigins: [], scriptOrigins: [] }, d);
    expect(out.status === "refused" && out.code).toBe("ERR_CU_UNSAFE_LAUNCH");
    expect(spy.approvals).toBe(0);
  });

  test("the policy asserted before consent is the SAME OBJECT handed to openLane", async () => {
    // Invariant I35's re-verify item 2. The pre-consent assertion is only worth anything if the
    // object it cleared is the object that launches; a rebuilt-but-equal policy would let the two
    // drift the moment either construction site changed.
    const seen: { asserted: unknown; launched: unknown } = { asserted: null, launched: null };
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d } = deps(
      {
        assertLaunchable: (p) => {
          seen.asserted = p;
          return null;
        },
        openLane: async (opts) => {
          seen.launched = opts.launch;
          return laneStub(spy);
        },
      },
      spy,
    );
    await openDefault(d);
    expect(seen.asserted).not.toBeNull();
    expect(seen.launched).toBe(seen.asserted as never);
  });

  test("an owner denial opens nothing", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d } = deps(
      {
        requestApproval: async () => {
          spy.approvals += 1;
          return false;
        },
      },
      spy,
    );
    const out = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(out.status).toBe("denied");
    expect(spy.actuations).toBe(0);
  });

  test("no browser installed refuses BEFORE consent", async () => {
    // The analogue of exec's `requireInstalled`: the owner is never asked to approve a session
    // that could not have started.
    const { deps: d, spy } = deps({ resolveBrowserPath: () => null });
    const out = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(out.status === "refused" && out.code).toBe("ERR_CU_NO_BROWSER");
    expect(spy.approvals).toBe(0);
  });

  test("an origin carrying a path is refused before consent, not silently widened", async () => {
    const { deps: d, spy } = deps();
    const out = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com/safe/subdir"], scriptOrigins: [] },
      d,
    );
    expect(out.status === "refused" && out.code).toBe("ERR_CU_BAD_ORIGIN");
    expect(spy.approvals).toBe(0);
  });

  test("a path-bearing scriptOrigins entry is refused before consent too (I-7)", async () => {
    const { deps: d, spy } = deps();
    const out = await openSession(
      {
        lane: "browser",
        navigateOrigins: ["https://example.com"],
        scriptOrigins: ["https://api.example.com/v1"],
      },
      d,
    );
    expect(out.status === "refused" && out.code).toBe("ERR_CU_BAD_ORIGIN");
    expect(spy.approvals).toBe(0);
  });

  test("the owner approves NORMALISED origins, not the raw strings", async () => {
    // Placement matters: normalising after approval would show the owner one string and enforce
    // another. Assert on what the prompt actually received.
    let seen: readonly string[] = [];
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d } = deps(
      {
        requestApproval: async (input: unknown) => {
          seen = (input as { navigateOrigins: readonly string[] }).navigateOrigins;
          spy.approvals += 1;
          return true;
        },
      },
      spy,
    );
    await openSession(
      { lane: "browser", navigateOrigins: ["https://Example.com/"], scriptOrigins: [] },
      d,
    );
    expect(seen).toEqual(["https://example.com"]);
  });

  test("a zero maxActions bound is refused BEFORE consent (I-2)", async () => {
    const { deps: d, spy } = deps();
    const out = await openSession(
      {
        lane: "browser",
        navigateOrigins: ["https://example.com"],
        scriptOrigins: [],
        maxActions: 0,
      },
      d,
    );
    expect(out.status === "refused" && out.code).toBe("ERR_CU_BAD_BOUNDS");
    expect(spy.approvals).toBe(0);
  });

  test("a NaN maxWallClockMs bound is refused BEFORE consent (I-2)", async () => {
    const { deps: d, spy } = deps();
    const out = await openSession(
      {
        lane: "browser",
        navigateOrigins: ["https://example.com"],
        scriptOrigins: [],
        maxWallClockMs: Number.NaN,
      },
      d,
    );
    expect(out.status === "refused" && out.code).toBe("ERR_CU_BAD_BOUNDS");
    expect(spy.approvals).toBe(0);
  });

  test("a launch failure AFTER approval records failed_after_approval, not refused_before_consent", async () => {
    // An auditor reading `refused_before_consent` concludes nothing was approved. Here the owner
    // approved and a browser very nearly started.
    const { deps: d, db } = deps({
      openLane: async () => {
        throw new Error("profile directory locked");
      },
    });
    const out = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(out.status).toBe("refused");
    const row = db
      .query<{ hitl_status: string; action_json: string }, []>(
        `SELECT hitl_status, action_json FROM audit_log WHERE action_type='computer.session' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.hitl_status).toBe("approved");
    expect(row?.action_json).toContain("failed_after_approval");
  });

  test("a registration failure AFTER a successful launch closes the leaked lane (I-4a)", async () => {
    // Same db, same deterministic `newId` ("id-1") across two `openSession` calls: the SECOND
    // call's `insertSession` collides on `cu_session`'s PRIMARY KEY. The second call's lane DID
    // start (its `openLane` succeeded) before that failure, so nothing else could ever close it
    // without this fix.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d } = deps({}, spy);
    const first = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(first.status).toBe("open");
    expect(spy.closes).toBe(0);

    const second = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(second.status).toBe("refused");
    expect(second.status === "refused" && second.code).toBe("ERR_CU_LAUNCH_FAILED");
    expect(spy.closes).toBe(1);
  });
});

describe("runAction — the envelope", () => {
  test("an out-of-envelope navigation is REFUSED, never prompted", async () => {
    // Spec § 4.2, the single most important anti-fatigue property.
    const { deps: d, spy } = deps();
    const sessionId = await openDefault(d);
    const before = spy.approvals;
    const out = await runAction({ sessionId, kind: "navigate", url: "https://evil.com" }, d);
    expect(out.outcome).toBe("refused_out_of_envelope");
    expect(spy.approvals).toBe(before); // ZERO additional prompts
    expect(spy.actuations).toBe(0);
  });

  test("a successful in-envelope navigate is admitted and actuates (I-7)", async () => {
    const { deps: d, spy } = deps();
    const sessionId = await openDefault(d);
    const out = await runAction({ sessionId, kind: "navigate", url: "https://example.com/" }, d);
    // Same-origin navigation classifies as `observing` (cu-classify.ts) -> no per-action prompt.
    expect(out.outcome).toBe("actuated");
    expect(spy.actuations).toBe(1);
    expect(spy.approvals).toBe(1); // only the envelope approval, none for this action
  });

  test("an actuating action prompts and a denial actuates nothing", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    let first = true;
    const { deps: d } = deps(
      {
        requestApproval: async () => {
          spy.approvals += 1;
          if (first) {
            first = false;
            return true;
          }
          return false;
        },
      },
      spy,
    );
    const sessionId = await openDefault(d);
    const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
    expect(out.outcome).toBe("denied_by_owner");
    expect(spy.actuations).toBe(0);
  });

  test("an approval is SINGLE-USE — an identical second action re-prompts", async () => {
    const { deps: d, spy } = deps();
    const sessionId = await openDefault(d);
    const after = spy.approvals;
    await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
    await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
    expect(spy.approvals).toBe(after + 2);
  });

  test("exhausting the budget TERMINATES rather than prompting to extend", async () => {
    const { deps: d } = deps({
      config: {
        ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
        enabled: true,
        allowedLanes: ["browser"],
        maxActions: 1,
      },
    });
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d);
    const out = await runAction({ sessionId, kind: "read" }, d);
    expect(out.outcome).toBe("terminated_budget");
  });

  test("a wall-clock termination fires once the clock has actually advanced past the budget (I-7)", async () => {
    // `now` pinned at a constant can never elapse — a mutable clock lets the test advance time
    // BETWEEN calls without relying on real wall-clock delay.
    let clock = 1000;
    const { deps: d } = deps({
      config: {
        ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
        enabled: true,
        allowedLanes: ["browser"],
        maxWallClockMs: 100,
      },
      now: () => clock,
    });
    const sessionId = await openDefault(d); // approvedAt = 1000
    clock = 1000 + 500; // well past the 100ms budget
    const out = await runAction({ sessionId, kind: "read" }, d);
    expect(out.outcome).toBe("terminated_wall_clock");
  });

  test("terminating a session for budget exhaustion closes the lane, evicts it, and persists closed_at/close_reason (I-4/NEW-3)", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps(
      {
        config: {
          ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
          enabled: true,
          allowedLanes: ["browser"],
          maxActions: 1,
        },
      },
      spy,
    );
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d);
    expect(spy.closes).toBe(0);
    await runAction({ sessionId, kind: "read" }, d); // terminates: budget exhausted
    expect(spy.closes).toBe(1);
    // The session is now GONE — a third call finds nothing to drive, rather than repeating the
    // termination outcome forever against a browser that no longer exists.
    await expect(runAction({ sessionId, kind: "read" }, d)).rejects.toThrow();
    // NEW-3: before this fix, NOTHING ever wrote closed_at/close_reason in production — the V57
    // replay table reported every terminated session as still open.
    const row = db
      .query<{ closed_at: number | null; close_reason: string | null }, [string]>(
        `SELECT closed_at, close_reason FROM cu_session WHERE id = ?`,
      )
      .get(sessionId);
    expect(row?.closed_at).not.toBeNull();
    expect(row?.close_reason).toBe("terminated_budget");
  });

  test("a budget termination records classification=null and the REAL reason, never a fabricated one (M-9/M-10)", async () => {
    const { deps: d, db } = deps({
      config: {
        ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
        enabled: true,
        allowedLanes: ["browser"],
        maxActions: 1,
      },
    });
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d);
    await runAction({ sessionId, kind: "read" }, d); // terminates
    const row = db
      .query<{ action_json: string }, []>(
        `SELECT action_json FROM audit_log WHERE action_type='computer.action' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    const payload = JSON.parse(row?.action_json ?? "{}") as {
      classification: unknown;
      terminationReason: unknown;
    };
    expect(payload.classification).toBeNull();
    expect(payload.terminationReason).toBe("budget");
  });

  test("a config/policy change mid-session TERMINATES a live session using the CURRENT deps (I-3.1), but writes to the session's OPEN-TIME deps (I-3.2)", async () => {
    const spyA: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsA, db: dbA } = deps({}, spyA);
    const sessionId = await openDefault(depsA);

    // A SEPARATE deps object — a different db, config now disabled — simulating Task 11
    // constructing a fresh `CuGateDeps` per request while the org policy tightened in between.
    const spyB: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsB, db: dbB } = deps(
      { config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: false } },
      spyB,
    );

    const out = await runAction({ sessionId, kind: "read" }, depsB);
    expect(out.outcome).toBe("terminated_policy");

    // The record follows the SESSION (dbA), never the caller (dbB).
    const rowsA = dbA
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
      )
      .get()?.n;
    const rowsB = dbB
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
      )
      .get()?.n;
    expect(rowsA).toBe(1);
    expect(rowsB ?? 0).toBe(0);

    // The lane that was ACTUALLY registered (A's) is the one that gets closed — never B's, since
    // B never opened anything.
    expect(spyA.closes).toBe(1);
    expect(spyB.closes).toBe(0);

    // The session is gone: a further action against it (from either deps) finds nothing live.
    await expect(runAction({ sessionId, kind: "read" }, depsA)).rejects.toThrow();
  });

  test("the owner removing this session's lane from allowed_lanes mid-session TERMINATES it too (review finding)", async () => {
    // Before this fix, step 0 re-checked ONLY `config.enabled`/`capabilitiesDisabled` on every
    // action — never `config.allowedLanes` — so a live `browser` session kept running to its full
    // budget even after the owner removed `browser` from `allowed_lanes`, even though `openSession`
    // already refuses a NEW session for that exact configuration. Mirrors the config/policy test
    // above, but narrows `allowedLanes` to empty instead of flipping `enabled`.
    const spyA: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsA, db: dbA } = deps({}, spyA);
    const sessionId = await openDefault(depsA); // opened with allowedLanes: ["browser"]

    const spyB: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsB } = deps(
      { config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: [] } },
      spyB,
    );

    const out = await runAction({ sessionId, kind: "read" }, depsB);
    expect(out.outcome).toBe("terminated_policy");
    expect(spyA.closes).toBe(1); // the live session's OWN lane was torn down

    const row = dbA
      .query<{ action_json: string }, []>(
        `SELECT action_json FROM audit_log WHERE action_type='computer.action' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.action_json).toContain("lane no longer allowed");

    // The session is gone: a further action against it finds nothing live.
    await expect(runAction({ sessionId, kind: "read" }, depsA)).rejects.toThrow();
  });

  test("an observing action inside the envelope does NOT prompt", async () => {
    const { deps: d, spy } = deps();
    const sessionId = await openDefault(d);
    const after = spy.approvals;
    await runAction({ sessionId, kind: "read" }, d);
    expect(spy.approvals).toBe(after);
  });

  test("every action appends exactly one audit row", async () => {
    const { deps: d, db } = deps();
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d);
    const n = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
      )
      .get()?.n;
    expect(n).toBe(1);
  });

  test("no row ever pairs hitl_status='not_required' with classification='actuating' (fix round 2)", async () => {
    // The coordinator's original rule -- NEVER write not_required on a computer.action row --
    // was right for an actuating action and wrong for an observing one: HITL genuinely was not
    // required there, and asserting `approved` would claim a consent that never happened. The
    // dangerous reading ("this actuated without needing approval") is only dangerous as the PAIR
    // not_required + actuating -- assert on the pair directly, which is an alarm that can
    // actually fire, rather than a blanket ban that could not distinguish the two classes.
    const { deps: d, db } = deps();
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d); // observing -> legitimately not_required
    await runAction({ sessionId, kind: "click", selector: "#s" }, d); // actuating -> approved
    const rows = db
      .query<{ hitl_status: string; action_json: string }, []>(
        `SELECT hitl_status, action_json FROM audit_log WHERE action_type='computer.action'`,
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const payload = JSON.parse(r.action_json) as { classification: unknown };
      const dangerousPair =
        r.hitl_status === "not_required" && payload.classification === "actuating";
      expect(dangerousPair).toBe(false);
    }
    // Proves the alarm is not vacuous: the observing row DOES legitimately read not_required.
    const readRow = rows.find(
      (r) => (JSON.parse(r.action_json) as { kind: string }).kind === "read",
    );
    expect(readRow?.hitl_status).toBe("not_required");
    const clickRow = rows.find(
      (r) => (JSON.parse(r.action_json) as { kind: string }).kind === "click",
    );
    expect(clickRow?.hitl_status).toBe("approved");
  });
  describe("C-1: a lane throw after a budget slot was granted never loses the audit row", () => {
    test("observe() throwing during classification still appends exactly one row", async () => {
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy, { throwOnObserve: true });
      const sessionId = await openDefault(d);
      const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
      expect(out.outcome).toBe("refused_before_consent"); // fix round 2: pre-consent stage
      expect(spy.actuations).toBe(0);
      const n = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
        )
        .get()?.n;
      expect(n).toBe(1);
    });

    test("the pre-actuation domSnapshot() throwing still appends exactly one row", async () => {
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy, { throwOnDomSnapshot: true });
      const sessionId = await openDefault(d);
      const out = await runAction({ sessionId, kind: "read" }, d);
      expect(out.outcome).toBe("refused_before_consent"); // fix round 2: pre-consent stage
      const n = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
        )
        .get()?.n;
      expect(n).toBe(1);
    });

    test("performActuation() throwing still appends exactly one row", async () => {
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy, { throwOnPerformActuation: true });
      const sessionId = await openDefault(d);
      const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
      expect(out.outcome).toBe("failed_after_approval");
      const n = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
        )
        .get()?.n;
      expect(n).toBe(1);
    });

    test("an approved 'download' fails closed instead of recording a phantom actuation", async () => {
      // CodeRabbit finding: `BrowserLane` has no download method, so `performActuation` used to
      // return null for it (no work done) while `cu-gate.ts` still recorded `outcome: 'actuated'`
      // / `hitl_status: 'approved'` — an owner-approved download that "succeeded" at nothing.
      // `download` classifies as `actuating`, so `requestApproval` (always true in this stub) is
      // consulted first; `performActuation` now throws for real, with no stubbed fault needed.
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy);
      const sessionId = await openDefault(d); // consumes one approval (the envelope itself)
      const approvalsBefore = spy.approvals;
      const out = await runAction({ sessionId, kind: "download" }, d);
      expect(out.outcome).toBe("failed_after_approval");
      expect(spy.approvals).toBe(approvalsBefore + 1); // consent WAS sought and granted for the action
      const row = db
        .query<{ hitl_status: string }, []>(
          `SELECT hitl_status FROM audit_log WHERE action_type='computer.action' ORDER BY id DESC LIMIT 1`,
        )
        .get();
      expect(row?.hitl_status).toBe("approved");
    });

    test("the reviewer's headline scenario: a click actuates, then the POST domSnapshot() throws — still exactly one row", async () => {
      // "Execution context was destroyed, most likely because of a navigation" — the single most
      // common post-click driver failure. The click DID happen on the host (spy.actuations===1);
      // only the observation taken AFTER it failed.
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy, { throwOnDomSnapshotAfter: true });
      const sessionId = await openDefault(d);
      const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
      expect(out.outcome).toBe("failed_after_approval");
      expect(spy.actuations).toBe(1); // the click DID happen
      const n = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
        )
        .get()?.n;
      expect(n).toBe(1);
    });

    test("a failed_after_approval row is hitl_status='approved', never 'rejected' or 'not_required'", async () => {
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy, { throwOnPerformActuation: true });
      const sessionId = await openDefault(d);
      await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
      const row = db
        .query<{ hitl_status: string }, []>(
          `SELECT hitl_status FROM audit_log WHERE action_type='computer.action' ORDER BY id DESC LIMIT 1`,
        )
        .get();
      expect(row?.hitl_status).toBe("approved");
    });
  });

  test("M-11: a capture that reads content and then fails to actuate still latches the taint (via cu_session.tainted_at)", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps({}, spy, { throwOnPerformActuation: true });
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "screenshot" }, d);
    const row = db
      .query<{ tainted_at: number | null }, [string]>(
        `SELECT tainted_at FROM cu_session WHERE id = ?`,
      )
      .get(sessionId);
    expect(row?.tainted_at).not.toBeNull();
  });
});

describe("isCuActionKind (M-14)", () => {
  test("accepts every real kind and rejects anything else", () => {
    for (const k of ["click", "type", "navigate", "read", "screenshot", "download"]) {
      expect(isCuActionKind(k)).toBe(true);
    }
    expect(isCuActionKind("delete_everything")).toBe(false);
    expect(isCuActionKind(42)).toBe(false);
    expect(isCuActionKind(null)).toBe(false);
    expect(isCuActionKind(undefined)).toBe(false);
  });
});

describe("fix round 2: NEW-1 through NEW-5 and the two disclosed gaps", () => {
  test("NEW-1: updateSessionState throwing does not take down the audit row", async () => {
    const { deps: d, db } = deps({ newId: () => "id-round3-new1" }); // unique id (fix round 3): leaving "id-1" broken would poison every LATER test's evictExistingSession call, since liveSessions is a shared module map
    const sessionId = await openDefault(d);
    // Simulate the class of production failure the reviewer named (SQLITE_BUSY, disk full, a
    // dropped table): the REPLAY-state sync throws, but the click already happened on the host.
    db.exec(`DROP TABLE cu_session`);
    const out = await runAction({ sessionId, kind: "read" }, d);
    expect(out.outcome).toBe("actuated"); // the read itself still succeeds
    const n = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
      )
      .get()?.n;
    expect(n).toBe(1);
  });

  test("NEW-2: a throwing consent broker is refused_before_consent, never failed_after_approval", async () => {
    let envelopeApproved = false;
    const { deps: d, db } = deps({
      requestApproval: async () => {
        if (!envelopeApproved) {
          envelopeApproved = true;
          return true;
        }
        throw new Error("broker exploded");
      },
    });
    const sessionId = await openDefault(d);
    const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
    expect(out.outcome).toBe("refused_before_consent");
    const row = db
      .query<{ hitl_status: string; action_json: string }, []>(
        `SELECT hitl_status, action_json FROM audit_log WHERE action_type='computer.action' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.hitl_status).toBe("rejected");
    const payload = JSON.parse(row?.action_json ?? "{}") as { classification: unknown };
    expect(payload.classification).toBe("actuating"); // it WAS classified before the broker threw
  });

  test("NEW-4a: a collision-caused registration failure never deletes an UNRELATED session's live entry", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d } = deps({}, spy);
    // Reuse the SAME db + deterministic newId ("id-1") across two opens: the second
    // `insertSession` collides on the PRIMARY KEY, exercising the registration-failure catch —
    // the exact path NEW-4 found could cascade into an escaping throw.
    const first = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(first.status).toBe("open");
    let second: Awaited<ReturnType<typeof openSession>> | undefined;
    await expect(
      (async () => {
        second = await openSession(
          { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
          d,
        );
      })(),
    ).resolves.toBeUndefined();
    expect(second?.status).toBe("refused");
    // No stale liveSessions entry for the failed second open: a runAction against ITS id (which
    // never reached the caller, since openSession never returned it) is moot, but the important
    // property is that the FIRST session is unaffected and still live.
    if (first.status === "open") {
      const out = await runAction({ sessionId: first.sessionId, kind: "read" }, d);
      expect(out.outcome).toBe("actuated");
    }
  });

  test("NEW-4b: the 'opened' audit append failing AFTER registration succeeded still closes the lane and returns refused", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps({ newId: () => "id-round3-new4b" }, spy); // unique id (fix round 3)
    // `insertSession` only touches `cu_session`, so dropping `audit_log` lets registration
    // proceed all the way to `liveSessions.set` — the "opened" append is the FIRST attempt to
    // touch `audit_log` on this path and is what throws.
    db.exec(`DROP TABLE audit_log`);
    const out = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(out.status).toBe("refused"); // never throws past the declared return type (NEW-4)
    // fix round 4: finalizeSession's teardown (sync/close-lane/evict) now runs inside a
    // `finally` wrapped around the audit write, so a broken audit_log no longer also leaks the
    // lane — restored to round 2's original guarantee.
    expect(spy.closes).toBe(1);
  });

  test("NEW-5: a colliding session id ACROSS TWO DIFFERENT DATABASES still closes and evicts the previous lane", async () => {
    // fix round 3: neutering evictExistingSession to a no-op left ALL 158 tests green, because
    // the only reachable "collision" the OLD test exercised was a same-db PRIMARY KEY conflict —
    // which insertSession's own constraint catches before evictExistingSession's code ever runs.
    // Two DIFFERENT databases never share that constraint, so a colliding id across them is the
    // ONLY scenario that actually reaches evictExistingSession's body in production (newId()
    // returns a random UUID per session, so the two calls would have to come from different
    // CuGateDeps entirely — exactly what Task 11 building a fresh one per request looks like).
    const spyA: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsA, db: dbA } = deps({}, spyA); // db A
    const first = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      depsA,
    );
    expect(first.status).toBe("open");
    expect(spyA.closes).toBe(0);

    const spyB: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsB } = deps({}, spyB); // a DIFFERENT db, SAME deterministic newId ("id-1")
    const second = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      depsB,
    );
    // insertSession succeeds for BOTH — db A and db B never collide with each other — so this
    // reaches the SUCCESS path, calling evictExistingSession("id-1") before liveSessions.set.
    expect(second.status).toBe("open");

    // NEW-5's fix: the FIRST lane (depsA's) must have been closed and evicted before the second
    // was registered under the same key, or it leaks forever with no way to reach it again.
    expect(spyA.closes).toBe(1);
    expect(spyB.closes).toBe(0);

    // NB-3 (fix round 3): before this, evictExistingSession wrote NOTHING — the evicted
    // session's own cu_session row (in db A) reported closed_at IS NULL forever.
    if (first.status === "open") {
      const evictedRow = dbA
        .query<{ closed_at: number | null; close_reason: string | null }, [string]>(
          `SELECT closed_at, close_reason FROM cu_session WHERE id = ?`,
        )
        .get(first.sessionId);
      expect(evictedRow?.closed_at).not.toBeNull();
      expect(evictedRow?.close_reason).toBe("evicted");
    }

    // The SECOND session is the one now live under "id-1" — driving it succeeds.
    if (second.status === "open") {
      const out = await runAction({ sessionId: second.sessionId, kind: "read" }, depsB);
      expect(out.outcome).toBe("actuated");
    }
  });

  test("I-3.2 (round 2): a SUCCESSFUL action still writes to the session's OPEN-TIME db, not the caller's", async () => {
    const spyA: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsA, db: dbA } = deps({}, spyA);
    const sessionId = await openDefault(depsA);

    const spyB: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsB, db: dbB } = deps({}, spyB); // healthy, DIFFERENT deps/db entirely

    const out = await runAction({ sessionId, kind: "read" }, depsB);
    expect(out.outcome).toBe("actuated");

    const rowsA = dbA
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
      )
      .get()?.n;
    const rowsB = dbB
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action_type='computer.action'`,
      )
      .get()?.n;
    expect(rowsA).toBe(1);
    expect(rowsB ?? 0).toBe(0);
    expect(spyB.approvals).toBe(0); // depsB's requestApproval never touched (observing action)
  });
});

describe("closeSession", () => {
  test("closes the lane, evicts the session, and persists closed_at/close_reason", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps({}, spy);
    const sessionId = await openDefault(d);
    const out = await closeSession(sessionId, d);
    expect(out.status).toBe("closed");
    expect(spy.closes).toBe(1);
    const row = db
      .query<{ closed_at: number | null; close_reason: string | null }, [string]>(
        `SELECT closed_at, close_reason FROM cu_session WHERE id = ?`,
      )
      .get(sessionId);
    expect(row?.closed_at).not.toBeNull();
    expect(row?.close_reason).toBe("owner");
    await expect(runAction({ sessionId, kind: "read" }, d)).rejects.toThrow();
  });

  test("closing an unknown/already-closed session returns not_found rather than throwing", async () => {
    const { deps: d } = deps();
    const out = await closeSession("nonexistent-session-id", d);
    expect(out.status).toBe("not_found");
  });

  test("closing an already-closed session a second time also returns not_found", async () => {
    const { deps: d } = deps();
    const sessionId = await openDefault(d);
    const first = await closeSession(sessionId, d);
    expect(first.status).toBe("closed");
    const second = await closeSession(sessionId, d);
    expect(second.status).toBe("not_found");
  });
});

describe("fix round 3: the restructure — booleans over stage-inference, one terminal helper", () => {
  test("NB-1: an APPROVED actuating action whose dom_before throws is failed_after_approval/approved, never refused_before_consent", async () => {
    // The coordinator's own round-2 instruction traded this away: `dom_before` runs AFTER
    // consent, so an actuating click the owner genuinely approved, whose pre-actuation
    // domSnapshot() throws, must still record that TWO real approvals were already granted (the
    // envelope, and this action) — not pretend nothing was ever offered for approval.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps({}, spy, { throwOnDomSnapshot: true });
    const sessionId = await openDefault(d);
    const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
    expect(out.outcome).toBe("failed_after_approval");
    expect(spy.approvals).toBe(2); // the envelope AND this action's per-action consent
    expect(spy.actuations).toBe(0); // performActuation was never reached
    const row = db
      .query<{ hitl_status: string }, []>(
        `SELECT hitl_status FROM audit_log WHERE action_type='computer.action' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(row?.hitl_status).toBe("approved");
  });

  test("teardown always runs (policy branch): a broken audit_log still closes the lane and evicts the session", async () => {
    // Replaces the deleted "order sensitivity" test, which pinned the LEAK as an expectation
    // ("audit_log is broken, therefore actions_used stayed 0 — syncSessionRow never got the
    // chance to run"). Probed on the pre-fix-round-4 code: with audit_log unavailable, runAction
    // THREW, spy.closes stayed 0, the map entry survived, and every subsequent call re-entered
    // the same throwing branch — a live headless browser with a reachable CDP endpoint leaked
    // PERMANENTLY. This test pins the property that actually matters instead.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps({ newId: () => "id-round4-teardown-policy" }, spy);
    const sessionId = await openDefault(d);
    db.exec(`DROP TABLE audit_log`);
    const disabledDeps: CuGateDeps = { ...d, config: { ...d.config, enabled: false } };
    await expect(runAction({ sessionId, kind: "read" }, disabledDeps)).rejects.toThrow();
    expect(spy.closes).toBe(1);
    // The session is genuinely gone — a follow-up call finds nothing live, rather than
    // re-entering the same throwing branch against a leaked browser forever.
    let caught: unknown;
    try {
      await runAction({ sessionId, kind: "read" }, d);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("ERR_CU_NO_SESSION");
  });

  test("teardown always runs (budget branch): a broken audit_log still closes the lane and evicts the session", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps(
      {
        newId: () => "id-round4-teardown-budget",
        config: {
          ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
          enabled: true,
          allowedLanes: ["browser"],
          maxActions: 1,
        },
      },
      spy,
    );
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d); // consumes the only slot
    db.exec(`DROP TABLE audit_log`);
    await expect(runAction({ sessionId, kind: "read" }, d)).rejects.toThrow(); // terminates: budget exhausted, audit write throws
    expect(spy.closes).toBe(1);
    let caught: unknown;
    try {
      await runAction({ sessionId, kind: "read" }, d);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("ERR_CU_NO_SESSION");
  });

  test("NB-4 (policy branch): cu_session unavailable still returns terminated_policy rather than throwing", async () => {
    const { deps: d, db } = deps({ newId: () => "id-round3-nb4-policy" });
    const sessionId = await openDefault(d);
    db.exec(`DROP TABLE cu_session`);
    // A tightened policy via a SEPARATE deps object (I-3.1), sharing the SAME (now broken) db —
    // exactly the shape Task 11 constructing a fresh CuGateDeps per request would produce.
    const disabledDeps: CuGateDeps = { ...d, config: { ...d.config, enabled: false } };
    const out = await runAction({ sessionId, kind: "read" }, disabledDeps);
    expect(out.outcome).toBe("terminated_policy");
  });

  test("NB-4 (budget branch): cu_session unavailable still returns terminated_budget rather than throwing", async () => {
    const { deps: d, db } = deps({
      newId: () => "id-round3-nb4-budget",
      config: {
        ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
        enabled: true,
        allowedLanes: ["browser"],
        maxActions: 1,
      },
    });
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d); // consumes the only slot
    db.exec(`DROP TABLE cu_session`);
    const out = await runAction({ sessionId, kind: "read" }, d); // terminates: budget exhausted
    expect(out.outcome).toBe("terminated_budget");
  });
  test("item 4: rowInserted (not registeredInMap) gates syncRow — our own inserted row gets closed_at even when evictExistingSession throws", async () => {
    // Leave a session LIVE and break ITS OWN db's audit_log, so evicting it later throws.
    const spyLeftover: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: leftoverDeps, db: leftoverDb } = deps(
      { newId: () => "id-round4-item4" },
      spyLeftover,
    );
    const leftover = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      leftoverDeps,
    );
    expect(leftover.status).toBe("open");
    leftoverDb.exec(`DROP TABLE audit_log`); // breaks the leftover's OWN eviction path

    // A SECOND open with the SAME id but a DIFFERENT, HEALTHY db: insertSession succeeds (no PK
    // collision — separate databases), but evictExistingSession then throws trying to evict the
    // LEFTOVER (its audit_log is gone), BEFORE liveSessions.set for THIS attempt ever runs. So
    // rowInserted is true (insertSession succeeded against dbB) while registeredInMap stays
    // false (liveSessions.set was never reached) — exactly the split item 4 introduces.
    const spyB: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: depsB, db: dbB } = deps({ newId: () => "id-round4-item4" }, spyB);
    const second = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      depsB,
    );
    expect(second.status).toBe("refused"); // never throws past the declared return type

    // Before this fix, syncRow was gated on registeredInMap — false here — so this row's
    // closed_at would have stayed NULL forever despite the row genuinely existing.
    const row = dbB
      .query<{ closed_at: number | null }, [string]>(
        `SELECT closed_at FROM cu_session WHERE id = ?`,
      )
      .get("id-round4-item4");
    expect(row?.closed_at).not.toBeNull();
  });
});

describe("runAction — the lane is re-checked after every await (TOCTOU)", () => {
  test("a close arriving while an action AWAITS approval actuates nothing", async () => {
    // The gap this closes: `runAction` used to check liveness ONCE, then await an approval prompt
    // a human answers — an unbounded window — and actuate on whatever came back. A
    // `computer.sessionClose` landing in that window closed and EVICTED the session, and the
    // actuation still went through against the lane it had just torn down.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    let sessionId = "";
    let d: CuGateDeps;
    const built = deps(
      {
        requestApproval: async (input) => {
          spy.approvals += 1;
          // Only the per-ACTION prompt closes the session; the envelope prompt must still open it.
          if (input.promptKind === "action") await closeSession(sessionId, d);
          return true;
        },
      },
      spy,
    );
    d = built.deps;
    sessionId = await openDefault(d);
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, d);
    expect(out.outcome).toBe("terminated_target_lost");
    expect(spy.actuations).toBe(0);
  });

  test("a lane that DIES before actuation terminates the session, and actuates nothing", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    let alive = true;
    const { deps: d } = deps({ openLane: async () => laneStub(spy, { alive: () => alive }) }, spy);
    const sessionId = await openDefault(d);
    // Dies while the owner is looking at the prompt.
    const d2: CuGateDeps = {
      ...d,
      requestApproval: async () => {
        alive = false;
        return true;
      },
    };
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, d2);
    expect(out.outcome).toBe("terminated_target_lost");
    expect(spy.actuations).toBe(0);
    // TERMINATED, not merely refused: the session is evicted, so a follow-up finds no session at
    // all rather than re-discovering the same corpse and spending another budget slot on it.
    await expect(runAction({ sessionId, kind: "read" }, d)).rejects.toThrow(/no live session/);
  });

  test("terminated_target_lost is RECORDED, with its own termination reason", async () => {
    // Item 10: the outcome was declared and handled but nothing ever assigned it.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    let alive = true;
    const { deps: d, db } = deps(
      { openLane: async () => laneStub(spy, { alive: () => alive }) },
      spy,
    );
    const sessionId = await openDefault(d);
    const d2: CuGateDeps = {
      ...d,
      requestApproval: async () => {
        alive = false;
        return true;
      },
    };
    await runAction({ sessionId, kind: "click", selector: "#go" }, d2);
    const row = db
      .query<{ action_json: string; hitl_status: string }, []>(
        `SELECT action_json, hitl_status FROM audit_log WHERE action_type = 'computer.action' ORDER BY id DESC LIMIT 1`,
      )
      .get();
    const payload = JSON.parse(row?.action_json as string) as Record<string, unknown>;
    expect(payload["outcome"]).toBe("terminated_target_lost");
    expect(String(payload["terminationReason"])).toContain("browser target");
    expect(row?.hitl_status).toBe("rejected");
    // And the durable session row is closed too, not just the map entry.
    const sess = db
      .query<{ closed_at: number | null; close_reason: string | null }, [string]>(
        `SELECT closed_at, close_reason FROM cu_session WHERE id = ?`,
      )
      .get(sessionId);
    expect(sess?.close_reason).toBe("terminated_target_lost");
    expect(sess?.closed_at).not.toBeNull();
  });

  test("a lane that dies DURING actuation still records failed_after_approval", async () => {
    // The owner approved and an actuation WAS attempted, so the record must say so — downgrading it
    // to a `terminated_*` outcome would resolve `hitl_status` to `rejected` and understate what
    // happened. The SESSION still terminates; the outcome and the teardown are separate questions.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    let alive = true;
    const { deps: d } = deps(
      {
        openLane: async () =>
          laneStub(spy, {
            alive: () => alive,
            // The lane dies AS the actuation runs, not before it: `throwOnPerformActuation` makes
            // `click()` throw, and flipping `alive` inside `trace` puts the death strictly after
            // the pre-actuation re-check that would otherwise claim it first.
            trace: (event) => {
              if (event === "click:start") alive = false;
            },
            throwOnPerformActuation: true,
          }),
      },
      spy,
    );
    const sessionId = await openDefault(d);
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, d);
    expect(out.outcome).toBe("failed_after_approval");
  });
});

describe("runAction — concurrent actions on ONE lane are serialised", () => {
  test("two concurrent actions never interleave dom_before / actuate / dom_after", async () => {
    // The damage is not a race on the budget counter (`consumeAction` was always atomic) — it is
    // that each action captures a DOM snapshot either side of its actuation, so an interleaved pair
    // records action A's `dom_after` from a page action B had already changed. Every `cu_action`
    // replay body on that session then describes a state that never existed.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const trace: string[] = [];
    const { deps: d } = deps(
      { openLane: async () => laneStub(spy, { trace: (e) => trace.push(e) }) },
      spy,
    );
    const sessionId = await openDefault(d);
    await Promise.all([
      runAction({ sessionId, kind: "click", selector: "#a" }, d),
      runAction({ sessionId, kind: "click", selector: "#b" }, d),
    ]);
    expect(trace).toEqual([
      "dom_before",
      "click:start",
      "click:end",
      "dom_after",
      "dom_before",
      "click:start",
      "click:end",
      "dom_after",
    ]);
    expect(spy.actuations).toBe(2);
  });

  test("an action that THROWS still releases the lane for the next one", async () => {
    // The outer `finally` in `runAction` is the property. Getting a test to depend on it took two
    // tries, and the first two both passed against a deliberately broken gate:
    //
    //   1. A healthy lane whose first `click` succeeded — proved only the success path.
    //   2. A lane whose `performActuation` threw — but `runActionExclusive` CATCHES that and
    //      RETURNS `failed_after_approval`, so it still resolves normally and a success-only
    //      release is still enough. Red-proved: moving `releaseLane()` out of the `finally` left
    //      that version green.
    //
    // `runAction` only REJECTS when the audit append itself fails (I35 is fail-closed about losing
    // a decision record), so that is what this drives: drop `audit_log`, run an action, and it
    // throws out of `runActionExclusive` — past every `catch` inside it. If the release is not in a
    // `finally`, the queue slot is never handed back and the NEXT action waits on a promise that
    // never settles, so the second call below times out instead of returning.
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d, db } = deps({}, spy);
    const sessionId = await openDefault(d);

    const auditDdl = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'",
      )
      .get()?.sql;
    db.run("DROP TABLE audit_log");
    await expect(runAction({ sessionId, kind: "read" }, d)).rejects.toThrow();

    // Audit surface healthy again: the session is still live, and the slot must have been released.
    db.run(auditDdl as string);
    const second = await runAction({ sessionId, kind: "read" }, d);
    expect(second.outcome).toBe("actuated");
  });
});
describe("terminal lane — the gate", () => {
  function terminalDeps(
    over: {
      approve?: boolean;
      assertLaunchable?: () => string | null;
      resolveShellPath?: CuTerminalSeams["resolveShellPath"];
    } = {},
  ) {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const prompts: unknown[] = [];
    const lane = terminalLaneStub(spy);
    const { deps: d, db } = deps(
      {
        config: {
          ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
          enabled: true,
          allowedLanes: ["browser", "terminal"],
        },
        requestApproval: async (input) => {
          prompts.push(input);
          spy.approvals += 1;
          return over.approve ?? true;
        },
        lanes: {
          terminal: {
            defaultShellId: "sh",
            resolveShellPath:
              over.resolveShellPath ??
              (() => ({ status: "ok", shellPath: "/fake/sh", argv: ["-s"], envOverlay: {} })),
            buildLaunchPolicy: ({ sessionId, shellId, shellPath, cwd }) => ({
              shellId,
              shellPath,
              argv: ["-s"],
              cwd,
              envOverlay: {},
              policy: {
                id: `cu-terminal-${sessionId}`,
                permissions: { network: [], filesystem: { read: [cwd], write: [cwd] } },
              },
            }),
            assertLaunchable: over.assertLaunchable ?? (() => null),
            openLane: async () => lane,
          },
        },
      },
      spy,
    );
    return { deps: d, db, spy, lane, prompts };
  }

  async function openTerminal(d: CuGateDeps): Promise<string> {
    const r = await openSession({ lane: "terminal", cwd: "/tmp/work" }, d);
    if (r.status !== "open") throw new Error(`expected open, got ${JSON.stringify(r)}`);
    return r.sessionId;
  }

  function actionPrompt(prompts: readonly unknown[]) {
    return prompts.find(
      (
        p,
      ): p is {
        promptKind: "action";
        observedTarget: string;
        classification: string;
        modelDescription: string | null;
      } => (p as { promptKind?: string }).promptKind === "action",
    );
  }

  test("a write with no submit reaches the shell ZERO times and prompts ZERO times", async () => {
    const { deps: d, spy, lane } = terminalDeps();
    const sessionId = await openTerminal(d);
    spy.approvals = 0; // the envelope prompt already happened; count only per-action prompts
    for (const t of ["ls", " -l", " /tmp"]) {
      const out = await runAction({ sessionId, kind: "terminal_write", text: t }, d);
      expect(out.outcome).toBe("buffered");
    }
    // Call counts, not absence-of-error. This is what catches a buffering path that silently
    // became a write path.
    expect(lane.writes).toEqual([]);
    expect(spy.approvals).toBe(0);
  });

  test("a buffered write returns the PENDING text so the caller can see what it composed", async () => {
    const { deps: d } = terminalDeps();
    const sessionId = await openTerminal(d);
    await runAction({ sessionId, kind: "terminal_write", text: "rm -rf" }, d);
    const out = await runAction({ sessionId, kind: "terminal_write", text: " /tmp" }, d);
    expect(out.result).toBe("rm -rf /tmp");
  });

  test("a submit promotes the WHOLE line, prompts once, and writes exactly it", async () => {
    const { deps: d, spy, lane } = terminalDeps();
    const sessionId = await openTerminal(d);
    spy.approvals = 0;
    await runAction({ sessionId, kind: "terminal_write", text: "ls -l" }, d);
    const out = await runAction({ sessionId, kind: "terminal_write", text: " /tmp\n" }, d);
    expect(out.outcome).toBe("actuated");
    expect(spy.approvals).toBe(1);
    expect(lane.writes).toEqual(["ls -l /tmp"]);
  });

  test("the owner is prompted with the COMPLETE line, not the fragment just written", async () => {
    const { deps: d, prompts } = terminalDeps();
    const sessionId = await openTerminal(d);
    await runAction({ sessionId, kind: "terminal_write", text: "rm -rf" }, d);
    await runAction({ sessionId, kind: "terminal_write", text: " /important\n" }, d);
    const action = actionPrompt(prompts);
    expect(action?.observedTarget).toBe("rm -rf /important");
    expect(action?.classification).toBe("actuating");
  });

  test("a control character is REFUSED, never prompted, and writes nothing", async () => {
    const { deps: d, spy, lane } = terminalDeps();
    const sessionId = await openTerminal(d);
    spy.approvals = 0;
    const out = await runAction(
      { sessionId, kind: "terminal_write", text: String.fromCodePoint(0x03) },
      d,
    );
    expect(out.outcome).toBe("refused_out_of_envelope");
    expect(spy.approvals).toBe(0);
    expect(lane.writes).toEqual([]);
    // The reason travels back, so the caller can tell four distinct refusals apart.
    expect(String(out.result)).toContain("refused");
  });

  test("a denied ACTION approval writes nothing", async () => {
    const { deps: d, lane, prompts } = terminalDeps();
    const sessionId = await openTerminal(d);
    // Deny only the per-action prompt, so the session is genuinely live when the write is refused.
    const denying: CuGateDeps = {
      ...d,
      requestApproval: async (input) => {
        prompts.push(input);
        return input.promptKind !== "action";
      },
    };
    const out = await runAction({ sessionId, kind: "terminal_write", text: "rm -rf /\n" }, denying);
    expect(out.outcome).toBe("denied_by_owner");
    expect(lane.writes).toEqual([]);
  });

  test("a browser kind on a terminal session is refused before a budget slot is spent", async () => {
    const { deps: d, spy, lane, db } = terminalDeps();
    const sessionId = await openTerminal(d);
    spy.approvals = 0;
    const out = await runAction({ sessionId, kind: "click", selector: "#pay" }, d);
    expect(out.outcome).toBe("refused_out_of_envelope");
    expect(spy.approvals).toBe(0);
    expect(lane.writes).toEqual([]);
    const row = db.query("SELECT actions_used FROM cu_session WHERE id = ?").get(sessionId) as {
      actions_used: number;
    };
    expect(row.actions_used).toBe(0);
  });

  test("refuses before consent when the runner cannot confine the policy", async () => {
    const { deps: d, spy } = terminalDeps({ assertLaunchable: () => "bwrap not found" });
    const r = await openSession({ lane: "terminal", cwd: "/tmp/w" }, d);
    expect(r).toEqual({ status: "refused", code: "ERR_CU_SANDBOX_DEGRADED" });
    // The owner was never asked to approve a session that could not have started.
    expect(spy.approvals).toBe(0);
  });

  test("refuses before consent when the shell is not installed", async () => {
    const { deps: d, spy } = terminalDeps({
      resolveShellPath: () => ({ status: "not_installed" }),
    });
    const r = await openSession({ lane: "terminal", cwd: "/tmp/w" }, d);
    expect(r).toEqual({ status: "refused", code: "ERR_CU_NO_SHELL" });
    expect(spy.approvals).toBe(0);
  });

  test("an unknown shell id is a DIFFERENT refusal from a missing shell", async () => {
    // Different remedies — fix the argument, versus install something — so collapsing them tells
    // the user to do the wrong one.
    const { deps: d } = terminalDeps({ resolveShellPath: () => ({ status: "unknown_shell" }) });
    const r = await openSession({ lane: "terminal", cwd: "/tmp/w", shellId: "bahs" }, d);
    expect(r).toEqual({ status: "refused", code: "ERR_CU_UNKNOWN_SHELL" });
  });

  test("a seam refusal keeps ITS code rather than flattening to ERR_CU_FAILED", async () => {
    const { deps: d } = terminalDeps();
    const withThrowingBuild: CuGateDeps = {
      ...d,
      lanes: {
        ...d.lanes,
        terminal: {
          ...d.lanes.terminal,
          buildLaunchPolicy: () => {
            const e = new Error("relative cwd") as Error & { code: string };
            e.code = "ERR_CU_TERMINAL_RELATIVE_CWD";
            throw e;
          },
        },
      },
    };
    const r = await openSession({ lane: "terminal", cwd: "/tmp/w" }, withThrowingBuild);
    expect(r).toEqual({ status: "refused", code: "ERR_CU_TERMINAL_RELATIVE_CWD" });
  });

  test("the audit row records the approved line, and the output rides dom_after", async () => {
    const { deps: d, db } = terminalDeps();
    const sessionId = await openTerminal(d);
    await runAction({ sessionId, kind: "terminal_write", text: "ls\n" }, d);
    const row = db
      .query(
        `SELECT kind, classification, observed_target, hitl_status, outcome, dom_before, dom_after
         FROM cu_action WHERE session_id = ?`,
      )
      .get(sessionId) as Record<string, unknown>;
    expect(row["kind"]).toBe("terminal_write");
    expect(row["classification"]).toBe("actuating");
    expect(row["observed_target"]).toBe("ls");
    expect(row["hitl_status"]).toBe("approved");
    expect(row["outcome"]).toBe("actuated");
    // No "before" state exists on this lane; the replay body IS the command's output.
    expect(row["dom_before"]).toBeNull();
    expect(String(row["dom_after"])).toContain("out:ls");
  });

  test("a buffered action records not_required with a null classification, never approved", async () => {
    const { deps: d, db } = terminalDeps();
    const sessionId = await openTerminal(d);
    await runAction({ sessionId, kind: "terminal_write", text: "ls" }, d);
    const rows = db
      .query("SELECT action_json, hitl_status FROM audit_log WHERE action_type = 'computer.action'")
      .all() as { action_json: string; hitl_status: string }[];
    const last = rows[rows.length - 1];
    expect(last?.hitl_status).toBe("not_required");
    expect(JSON.parse(last?.action_json ?? "{}").classification).toBeNull();
  });

  test("no terminal action ever classifies observing", async () => {
    const { deps: d, db } = terminalDeps();
    const sessionId = await openTerminal(d);
    for (const t of ["a", "b", "c\n", String.fromCodePoint(0x03), "d\n"]) {
      await runAction({ sessionId, kind: "terminal_write", text: t }, d);
    }
    const rows = db
      .query("SELECT classification FROM cu_action WHERE session_id = ?")
      .all(sessionId) as { classification: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.classification === "actuating")).toBe(true);
  });

  test("the model's description reaches the prompt but never the classification", async () => {
    const { deps: d, prompts } = terminalDeps();
    const sessionId = await openTerminal(d);
    await runAction(
      {
        sessionId,
        kind: "terminal_write",
        text: "rm -rf /\n",
        modelDescription: "just listing files, read-only",
      },
      d,
    );
    const action = actionPrompt(prompts);
    expect(action?.classification).toBe("actuating");
    expect(action?.observedTarget).toBe("rm -rf /");
    expect(action?.modelDescription).toContain("read-only");
  });

  test("the envelope prompt shows the shell and directory, not origin lists", async () => {
    const { deps: d, prompts } = terminalDeps();
    await openTerminal(d);
    const env = prompts.find(
      (p): p is { promptKind: "envelope"; lane: string; shellId: string; cwd: string } =>
        (p as { promptKind?: string }).promptKind === "envelope",
    );
    expect(env?.lane).toBe("terminal");
    expect(env?.shellId).toBe("sh");
    expect(env?.cwd).toBe("/tmp/work");
  });
});
