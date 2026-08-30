import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type CuGateDeps, openSession, runAction } from "./cu-gate.ts";
import type { BrowserLane, ObservedNode } from "./cu-types.ts";

interface Spy {
  approvals: number;
  actuations: number;
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
function laneStub(spy: Spy): BrowserLane {
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
  return {
    observe: async () => node,
    currentOrigin: () => "https://example.com",
    click: async () => {
      spy.actuations += 1;
    },
    type: async () => {
      spy.actuations += 1;
    },
    navigate: async () => {
      spy.actuations += 1;
    },
    readText: async () => "page text",
    domSnapshot: async () => "<html></html>",
    screenshot: async () => new Uint8Array([1, 2, 3]),
    close: async () => {},
  };
}

function makeTestDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  return db;
}

function deps(
  over: Partial<CuGateDeps> = {},
  spy: Spy = { approvals: 0, actuations: 0 },
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
    openLane: async () => laneStub(spy),
    db,
    now: () => 1000,
    newId: () => "id-1",
    ...over,
  };
  return { deps: full, db, spy };
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
    const spy: Spy = { approvals: 0, actuations: 0 };
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

  test("the owner approves NORMALISED origins, not the raw strings", async () => {
    // Placement matters: normalising after approval would show the owner one string and enforce
    // another. Assert on what the prompt actually received.
    let seen: readonly string[] = [];
    const spy: Spy = { approvals: 0, actuations: 0 };
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
});

describe("runAction — the envelope", () => {
  test("an out-of-envelope navigation is REFUSED, never prompted", async () => {
    // Spec § 4.2, the single most important anti-fatigue property.
    const { deps: d, spy } = deps();
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    expect(sess.status).toBe("open");
    const sessionId = sess.status === "open" ? sess.sessionId : "";
    const before = spy.approvals;
    const out = await runAction({ sessionId, kind: "navigate", url: "https://evil.com" }, d);
    expect(out.outcome).toBe("refused_out_of_envelope");
    expect(spy.approvals).toBe(before); // ZERO additional prompts
    expect(spy.actuations).toBe(0);
  });

  test("an actuating action prompts and a denial actuates nothing", async () => {
    const spy: Spy = { approvals: 0, actuations: 0 };
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
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    const sessionId = sess.status === "open" ? sess.sessionId : "";
    const out = await runAction({ sessionId, kind: "click", selector: "#submit" }, d);
    expect(out.outcome).toBe("denied_by_owner");
    expect(spy.actuations).toBe(0);
  });

  test("an approval is SINGLE-USE — an identical second action re-prompts", async () => {
    const { deps: d, spy } = deps();
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    const sessionId = sess.status === "open" ? sess.sessionId : "";
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
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    const sessionId = sess.status === "open" ? sess.sessionId : "";
    await runAction({ sessionId, kind: "read" }, d);
    const out = await runAction({ sessionId, kind: "read" }, d);
    expect(out.outcome).toBe("terminated_budget");
  });

  test("an observing action inside the envelope does NOT prompt", async () => {
    const { deps: d, spy } = deps();
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    const sessionId = sess.status === "open" ? sess.sessionId : "";
    const after = spy.approvals;
    await runAction({ sessionId, kind: "read" }, d);
    expect(spy.approvals).toBe(after);
  });

  test("every action appends exactly one audit row", async () => {
    const { deps: d, db } = deps();
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    const sessionId = sess.status === "open" ? sess.sessionId : "";
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
    const sess = await openSession(
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      d,
    );
    const sessionId = sess.status === "open" ? sess.sessionId : "";
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
});
