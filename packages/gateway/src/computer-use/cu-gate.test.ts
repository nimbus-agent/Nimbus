import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type CuGateDeps, isCuActionKind, openSession, runAction } from "./cu-gate.ts";
import type { BrowserLane, ObservedNode } from "./cu-types.ts";

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
      return node;
    },
    currentOrigin: () => "https://example.com",
    click: async () => {
      if (opts.throwOnPerformActuation) throw new Error("driver: click() failed");
      spy.actuations += 1;
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

function deps(
  over: Partial<CuGateDeps> = {},
  spy: Spy = { approvals: 0, actuations: 0, closes: 0 },
  laneOpts: LaneStubOptions = {},
): { deps: CuGateDeps; db: Database; spy: Spy } {
  const db = makeTestDb();
  const full: CuGateDeps = {
    config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: ["browser"] },
    enforced: { capabilitiesDisabled: new Set<string>() },
    runner: { canConfine: () => null },
    requestApproval: async () => {
      spy.approvals += 1;
      return true;
    },
    // Injected seams, so these tests run with no browser installed — and so `cu-gate.ts` never
    // imports the driver, which is what keeps it clear of D26(b).
    resolveBrowserPath: () => "/fake/chrome",
    openLane: async () => laneStub(spy, laneOpts),
    db,
    now: () => 1000,
    newId: () => "id-1",
    ...over,
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

  test("a degraded sandbox refuses and NEVER prompts", async () => {
    const { deps: d, spy } = deps({
      runner: { canConfine: () => "bubblewrap missing" },
    });
    const out = await openSession({ lane: "browser", navigateOrigins: [], scriptOrigins: [] }, d);
    expect(out.status === "refused" && out.code).toBe("ERR_CU_SANDBOX_DEGRADED");
    expect(spy.approvals).toBe(0);
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

  test("terminating a session for budget exhaustion closes the lane and evicts it (I-4)", async () => {
    const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
    const { deps: d } = deps(
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

  test("no action row ever records hitl_status='not_required'", async () => {
    // Spec § 8.2: on this action type it would read as "this actuated without needing approval".
    const { deps: d, db } = deps();
    const sessionId = await openDefault(d);
    await runAction({ sessionId, kind: "read" }, d);
    await runAction({ sessionId, kind: "click", selector: "#s" }, d);
    const rows = db
      .query<{ hitl_status: string }, []>(
        `SELECT hitl_status FROM audit_log WHERE action_type='computer.action'`,
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.hitl_status).not.toBe("not_required");
  });

  describe("C-1: a lane throw after a budget slot was granted never loses the audit row", () => {
    test("observe() throwing during classification still appends exactly one row", async () => {
      const spy: Spy = { approvals: 0, actuations: 0, closes: 0 };
      const { deps: d, db } = deps({}, spy, { throwOnObserve: true });
      const sessionId = await openDefault(d);
      const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
      expect(out.outcome).toBe("failed_after_approval");
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
      expect(out.outcome).toBe("failed_after_approval");
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
