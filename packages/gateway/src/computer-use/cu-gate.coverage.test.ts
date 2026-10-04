/**
 * Edge paths of `cu-gate.ts` (invariant I35) that `cu-gate.test.ts` does not reach: how a seam's
 * refusal code survives the gate's outer catch, the post-`await` liveness re-checks on BOTH lanes,
 * an action queued behind one whose session ended meanwhile, and the record a non-`Error` throw
 * leaves behind.
 *
 * Every session id here is unique to this file. The gate's live-session map is module-private and
 * shared by every test file in the same `bun test` process, so a fixed id like `cu-gate.test.ts`'s
 * `"id-1"` would let this file evict another file's live session through the collision path.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type CuLane, DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { CuActionApprovalInput, CuEnvelopeApprovalInput } from "./cu-consent-broker.ts";
import {
  type CuGateDeps,
  closeSession,
  type OpenSessionRequest,
  openSession,
  runAction,
} from "./cu-gate.ts";
import type { BrowserLane, ObservedNode, TerminalLane } from "./cu-types.ts";

type ApprovalInput = CuEnvelopeApprovalInput | CuActionApprovalInput;

const ORIGIN = "https://example.com";

/**
 * Values a third-party driver can throw that are NOT `Error`s. Typed `unknown` on purpose: the gate
 * receives every seam failure as `unknown`, and these are what its `String(e)` and code-fallback
 * branches exist for.
 */
const PLAIN_OBJECT_THROW: unknown = Object.freeze({
  toString: () => "driver threw a plain object",
});
const BARE_STRING_THROW: unknown = "seam threw a bare string";
const NULL_THROW: unknown = null;

let idSeq = 0;
function uniqueId(tag: string): string {
  idSeq += 1;
  return `cu-gate-cov-${tag}-${idSeq}`;
}

const SUBMIT_BUTTON: ObservedNode = {
  tagName: "BUTTON",
  type: null,
  inFormWithPassword: false,
  inForm: false,
  isSubmitControl: true,
  hrefScheme: null,
  hrefOrigin: null,
  accessibleName: "Submit",
};

interface FakeBrowserOptions {
  readonly node?: ObservedNode;
  /** `undefined` means the default origin; `null` is a page with no origin (about:blank). */
  readonly currentOrigin?: string | null;
  readonly isAlive?: () => boolean;
  readonly onObserve?: () => void | Promise<void>;
  readonly onDomSnapshot?: (call: number) => void;
  readonly observeThrows?: unknown;
  readonly clickThrows?: unknown;
}

/** A `BrowserLane` that records every call it receives, in order, into `calls`. */
function fakeBrowser(calls: string[], o: FakeBrowserOptions = {}): BrowserLane {
  let snapshots = 0;
  return {
    observe: async (selector) => {
      calls.push(`observe:${selector}`);
      if (o.observeThrows !== undefined) throw o.observeThrows;
      await o.onObserve?.();
      return o.node ?? SUBMIT_BUTTON;
    },
    currentOrigin: () => (o.currentOrigin === undefined ? ORIGIN : o.currentOrigin),
    click: async (selector) => {
      calls.push(`click:${selector}`);
      if (o.clickThrows !== undefined) throw o.clickThrows;
    },
    type: async (selector, text) => {
      calls.push(`type:${selector}:${text}`);
    },
    navigate: async (url) => {
      calls.push(`navigate:${url}`);
    },
    readText: async () => {
      calls.push("readText");
      return "page text";
    },
    domSnapshot: async () => {
      snapshots += 1;
      calls.push(`domSnapshot:${snapshots}`);
      o.onDomSnapshot?.(snapshots);
      return "<html></html>";
    },
    screenshot: async () => {
      calls.push("screenshot");
      return new Uint8Array([1, 2, 3]);
    },
    isAlive: () => o.isAlive?.() ?? true,
    close: async () => {
      calls.push("close");
    },
  };
}

interface FakeTerminalOptions {
  readonly isAlive?: () => boolean;
  /**
   * Called with the 1-based write number after the attempt is recorded; whatever it returns other
   * than `undefined` is THROWN instead of returning output.
   */
  readonly onWrite?: (call: number) => unknown;
}

/** A `TerminalLane` whose `writes` array is exactly what reached the "shell". */
function fakeTerminal(
  calls: string[],
  o: FakeTerminalOptions = {},
): TerminalLane & { readonly writes: string[] } {
  const writes: string[] = [];
  let attempts = 0;
  return {
    writes,
    write: async (bytes) => {
      attempts += 1;
      calls.push(`write:${bytes}`);
      const failure = o.onWrite?.(attempts);
      if (failure !== undefined) throw failure;
      writes.push(bytes);
      return { output: `out:${bytes}`, settled: "quiet", truncated: false };
    },
    isAlive: () => o.isAlive?.() ?? true,
    close: async () => {
      calls.push("close");
    },
  };
}

interface Harness {
  readonly deps: CuGateDeps;
  readonly db: Database;
  readonly calls: string[];
  readonly prompts: ApprovalInput[];
}

const openDbs: Database[] = [];
/** Sessions this file opened; closed after each test so none outlives it in the shared map. */
const openedSessions: Array<{ readonly id: string; readonly deps: CuGateDeps }> = [];
afterEach(async () => {
  // Best-effort and BEFORE the DBs close: a session the test already ended is simply not found,
  // and a cleanup failure must not replace the test's own result.
  for (const s of openedSessions.splice(0)) {
    await closeSession(s.id, s.deps).catch(() => undefined);
  }
  for (const db of openDbs.splice(0)) db.close();
});

function harness(
  o: {
    readonly sessionId?: string;
    readonly allowedLanes?: CuLane[];
    readonly browser?: FakeBrowserOptions;
    readonly terminal?: FakeTerminalOptions;
    readonly approve?: (input: ApprovalInput) => boolean | Promise<boolean>;
    readonly now?: () => number;
    readonly mutate?: (deps: CuGateDeps) => CuGateDeps;
  } = {},
): Harness & { readonly terminal: ReturnType<typeof fakeTerminal> } {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  openDbs.push(db);
  const calls: string[] = [];
  const prompts: ApprovalInput[] = [];
  const terminal = fakeTerminal(calls, o.terminal);
  const sessionId = o.sessionId ?? uniqueId("s");
  const base: CuGateDeps = {
    config: {
      ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
      enabled: true,
      allowedLanes: o.allowedLanes ?? ["browser", "terminal"],
    },
    enforced: { capabilitiesDisabled: new Set<string>() },
    requestApproval: async (input) => {
      prompts.push(input);
      return o.approve === undefined ? true : await o.approve(input);
    },
    lanes: {
      browser: {
        resolveBrowserPath: () => "/fake/chrome",
        buildLaunchPolicy: ({ profileDir }) => ({
          profileDir: profileDir === "" ? "/fake/profile" : profileDir,
          argv: ["--headless=new", "--remote-debugging-port=0", "--user-data-dir=/fake/profile"],
        }),
        assertLaunchable: () => null,
        openLane: async () => fakeBrowser(calls, o.browser),
      },
      terminal: {
        defaultShellId: "sh",
        resolveShellPath: () => ({
          status: "ok",
          shellPath: "/fake/sh",
          argv: ["-s"],
          envOverlay: {},
        }),
        buildLaunchPolicy: ({ sessionId: sid, shellId, shellPath, cwd }) => ({
          shellId,
          shellPath,
          argv: ["-s"],
          cwd,
          envOverlay: {},
          policy: {
            id: `cu-terminal-${sid}`,
            permissions: { network: [], filesystem: { read: [cwd], write: [cwd] } },
          },
        }),
        assertLaunchable: () => null,
        openLane: async () => terminal,
      },
    },
    db,
    now: o.now ?? (() => 1000),
    newId: () => sessionId,
  };
  const deps = o.mutate === undefined ? base : o.mutate(base);
  return { deps, db, calls, prompts, terminal };
}

async function openBrowser(h: Harness): Promise<string> {
  const r = await openSession(
    { lane: "browser", navigateOrigins: [ORIGIN], scriptOrigins: [] },
    h.deps,
  );
  if (r.status !== "open") throw new Error(`expected an open session, got ${JSON.stringify(r)}`);
  openedSessions.push({ id: r.sessionId, deps: h.deps });
  return r.sessionId;
}

async function openTerminal(h: Harness): Promise<string> {
  const r = await openSession({ lane: "terminal", cwd: "/work" }, h.deps);
  if (r.status !== "open") throw new Error(`expected an open session, got ${JSON.stringify(r)}`);
  openedSessions.push({ id: r.sessionId, deps: h.deps });
  return r.sessionId;
}

interface AuditRow {
  readonly hitl_status: string;
  readonly payload: Record<string, unknown>;
}

function auditRows(db: Database, actionType: "computer.session" | "computer.action"): AuditRow[] {
  return db
    .query<{ hitl_status: string; action_json: string }, [string]>(
      "SELECT hitl_status, action_json FROM audit_log WHERE action_type = ? ORDER BY id",
    )
    .all(actionType)
    .map((r) => ({
      hitl_status: r.hitl_status,
      payload: JSON.parse(r.action_json) as Record<string, unknown>,
    }));
}

function lastActionRow(db: Database): AuditRow {
  const rows = auditRows(db, "computer.action");
  const last = rows.at(-1);
  if (last === undefined) throw new Error("no computer.action audit row was written");
  return last;
}

function sessionRow(
  db: Database,
  sessionId: string,
): { closed_at: number | null; close_reason: string | null; tainted_at: number | null } | null {
  return db
    .query<
      { closed_at: number | null; close_reason: string | null; tainted_at: number | null },
      [string]
    >("SELECT closed_at, close_reason, tainted_at FROM cu_session WHERE id = ?")
    .get(sessionId);
}

function actionPrompts(prompts: readonly ApprovalInput[]): CuActionApprovalInput[] {
  return prompts.filter((p): p is CuActionApprovalInput => p.promptKind === "action");
}

/** A promise plus the function that settles it, so a test can hold an `await` open on purpose. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every already-queued microtask and timer callback run once. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
}

async function expectNoLiveSession(sessionId: string, deps: CuGateDeps): Promise<void> {
  let caught: unknown;
  try {
    await runAction({ sessionId, kind: "read" }, deps);
  } catch (e) {
    caught = e;
  }
  expect((caught as { code?: unknown } | undefined)?.code).toBe("ERR_CU_NO_SESSION");
}

describe("openSession — a seam's refusal reaches the caller and the audit row", () => {
  test("a launch-policy throw with no code of its own falls back to ERR_CU_BAD_LAUNCH", async () => {
    const h = harness({
      mutate: (d) => ({
        ...d,
        lanes: {
          ...d.lanes,
          terminal: {
            ...d.lanes.terminal,
            buildLaunchPolicy: () => {
              throw new Error("cwd must be absolute");
            },
          },
        },
      }),
    });
    const out = await openSession({ lane: "terminal", cwd: "work" }, h.deps);
    expect(out).toEqual({ status: "refused", code: "ERR_CU_BAD_LAUNCH" });
    // Decided before consent: the owner is never asked about a session that could not start.
    expect(h.prompts).toHaveLength(0);
    const [row] = auditRows(h.db, "computer.session");
    expect(row?.hitl_status).toBe("rejected");
    expect(row?.payload["outcome"]).toBe("refused_before_consent");
    expect(row?.payload["code"]).toBe("ERR_CU_BAD_LAUNCH");
  });

  test.each([
    ["an empty-string code", Object.assign(new Error("blank code"), { code: "" })],
    ["a non-string code", Object.assign(new Error("numeric code"), { code: 7 })],
    ["a bare string", BARE_STRING_THROW],
    ["null", NULL_THROW],
  ])("%s never becomes the refusal code — the fallback does", async (_label, thrown) => {
    const h = harness({
      mutate: (d) => ({
        ...d,
        lanes: {
          ...d.lanes,
          terminal: {
            ...d.lanes.terminal,
            buildLaunchPolicy: () => {
              throw thrown;
            },
          },
        },
      }),
    });
    const out = await openSession({ lane: "terminal", cwd: "/work" }, h.deps);
    expect(out).toEqual({ status: "refused", code: "ERR_CU_BAD_LAUNCH" });
    expect(h.prompts).toHaveLength(0);
    expect(h.calls).toEqual([]); // no lane was ever opened
  });

  test("a lane that config allows but the gate cannot prepare is refused before consent", async () => {
    // `screen` is a config-forward lane name with no implementation. The RPC transport refuses it
    // first; this is the gate's own second line, for a caller that skipped the transport.
    const h = harness({ allowedLanes: ["screen"] });
    const req = { lane: "screen" } as unknown as OpenSessionRequest;
    const out = await openSession(req, h.deps);
    expect(out).toEqual({ status: "refused", code: "ERR_CU_LANE_NOT_ALLOWED" });
    expect(h.prompts).toHaveLength(0);
    expect(h.calls).toEqual([]);
    const [row] = auditRows(h.db, "computer.session");
    expect(row?.payload["outcome"]).toBe("refused_before_consent");
  });

  test("an openLane rejection that is not an Error is still recorded by its text", async () => {
    const h = harness({
      mutate: (d) => ({
        ...d,
        lanes: {
          ...d.lanes,
          browser: {
            ...d.lanes.browser,
            openLane: async () => {
              throw PLAIN_OBJECT_THROW;
            },
          },
        },
      }),
    });
    const out = await openSession(
      { lane: "browser", navigateOrigins: [ORIGIN], scriptOrigins: [] },
      h.deps,
    );
    expect(out).toEqual({ status: "refused", code: "ERR_CU_LAUNCH_FAILED" });
    const rows = auditRows(h.db, "computer.session");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("approved"); // the owner DID approve the envelope
    expect(rows[0]?.payload["outcome"]).toBe("failed_after_approval");
    expect(rows[0]?.payload["error"]).toBe("driver threw a plain object");
  });

  test("a non-Error thrown while registering the session closes the lane and records its text", async () => {
    // The first clock read after the lane launched is the "opened" audit append; making that read
    // throw a bare string drives the registration catch with a value that is not an Error.
    let armed = false;
    const h = harness({
      now: () => {
        if (armed) {
          armed = false;
          throw BARE_STRING_THROW;
        }
        return 1000;
      },
      mutate: (d) => ({
        ...d,
        lanes: {
          ...d.lanes,
          browser: {
            ...d.lanes.browser,
            openLane: async (opts) => {
              armed = true;
              return d.lanes.browser.openLane(opts);
            },
          },
        },
      }),
    });
    const sessionId = h.deps.newId();
    const out = await openSession(
      { lane: "browser", navigateOrigins: [ORIGIN], scriptOrigins: [] },
      h.deps,
    );
    expect(out).toEqual({ status: "refused", code: "ERR_CU_LAUNCH_FAILED" });
    expect(h.calls).toEqual(["close"]); // the launched lane was torn down, not leaked
    const rows = auditRows(h.db, "computer.session");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload["stage"]).toBe("register_session");
    expect(rows[0]?.payload["error"]).toBe("seam threw a bare string");
    expect(sessionRow(h.db, sessionId)?.close_reason).toBe("failed_after_approval");
    await expectNoLiveSession(sessionId, h.deps);
  });
});

describe("runAction — a session that ended while an action waited its turn", () => {
  test("the owner closing it: the queued action records the close reason verbatim", async () => {
    const gate = deferred<boolean>();
    const h = harness({
      approve: (input) => (input.promptKind === "action" ? gate.promise : true),
    });
    const sessionId = await openBrowser(h);

    const first = runAction({ sessionId, kind: "click", selector: "#pay" }, h.deps);
    await settle(); // `first` is now parked on the owner's per-action prompt
    const second = runAction({ sessionId, kind: "read" }, h.deps); // queued behind `first`
    await settle();
    expect(await closeSession(sessionId, h.deps)).toEqual({ status: "closed" });
    gate.resolve(true);

    expect((await first).outcome).toBe("terminated_target_lost");
    // `owner` is not a CuOutcome, so the typed outcome falls back to the conservative tag while the
    // REAL reason is kept verbatim beside it.
    expect((await second).outcome).toBe("terminated_budget");
    const row = lastActionRow(h.db);
    expect(row.payload["kind"]).toBe("read");
    expect(row.payload["terminationReason"]).toBe("owner");
    expect(row.payload["seq"]).toBeNull();
    expect(row.payload["classification"]).toBeNull();
    expect(row.hitl_status).toBe("rejected");
    // Nothing reached the host for either action, and the original close reason was kept.
    expect(h.calls.filter((c) => c.startsWith("click") || c === "readText")).toEqual([]);
    expect(sessionRow(h.db, sessionId)?.close_reason).toBe("owner");
  });

  test("a lost target: the queued action records THAT outcome, not the fallback", async () => {
    const gate = deferred<boolean>();
    let alive = true;
    const h = harness({
      browser: { isAlive: () => alive },
      approve: (input) => (input.promptKind === "action" ? gate.promise : true),
    });
    const sessionId = await openBrowser(h);

    const first = runAction({ sessionId, kind: "click", selector: "#pay" }, h.deps);
    await settle();
    const second = runAction({ sessionId, kind: "read" }, h.deps);
    await settle();
    alive = false; // the browser dies while the owner reads the prompt
    gate.resolve(true);

    expect((await first).outcome).toBe("terminated_target_lost");
    expect((await second).outcome).toBe("terminated_target_lost");
    const row = lastActionRow(h.db);
    expect(row.payload["kind"]).toBe("read");
    expect(row.payload["outcome"]).toBe("terminated_target_lost");
    expect(row.payload["terminationReason"]).toBe("terminated_target_lost");
    expect(h.calls).not.toContain("readText");
  });
});

describe("runAction — the live policy re-check names which source stopped it", () => {
  test("an org policy tightened mid-session reads 'disabled by org policy'", async () => {
    const h = harness();
    const sessionId = await openBrowser(h);
    const tightened: CuGateDeps = {
      ...h.deps,
      enforced: { capabilitiesDisabled: new Set(["computer_use"]) },
    };
    const out = await runAction({ sessionId, kind: "read" }, tightened);
    expect(out.outcome).toBe("terminated_policy");
    const row = lastActionRow(h.db);
    expect(row.payload["terminationReason"]).toBe("disabled by org policy");
    expect(row.payload["observedTarget"]).toBe("session terminated: disabled by org policy");
    expect(h.calls).toEqual(["close"]);
    await expectNoLiveSession(sessionId, h.deps);
  });
});

describe("runAction — browser arm", () => {
  test("a typed control with no accessible name is described by its type", async () => {
    const h = harness({
      browser: {
        node: { ...SUBMIT_BUTTON, tagName: "INPUT", type: "submit", accessibleName: null },
      },
    });
    const sessionId = await openBrowser(h);
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, h.deps);
    expect(out.outcome).toBe("actuated");
    expect(actionPrompts(h.prompts)[0]?.observedTarget).toBe("click input type=submit");
    expect(lastActionRow(h.db).payload["observedTarget"]).toBe("click input type=submit");
  });

  test("a navigation from a page with no origin is described with '?' and needs the owner", async () => {
    const h = harness({ browser: { currentOrigin: null } });
    const sessionId = await openBrowser(h);
    const out = await runAction({ sessionId, kind: "navigate", url: `${ORIGIN}/next` }, h.deps);
    expect(out.outcome).toBe("actuated");
    const [prompt] = actionPrompts(h.prompts);
    expect(prompt?.observedTarget).toBe(`navigate ? -> ${ORIGIN}`);
    expect(prompt?.classification).toBe("actuating");
    expect(h.calls).toContain(`navigate:${ORIGIN}/next`);
  });

  test("a lane that dies while being observed terminates before classification", async () => {
    let alive = true;
    const h = harness({
      browser: {
        isAlive: () => alive,
        onObserve: () => {
          alive = false;
        },
      },
    });
    const sessionId = await openBrowser(h);
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, h.deps);
    expect(out).toEqual({ outcome: "terminated_target_lost" });
    expect(actionPrompts(h.prompts)).toHaveLength(0);
    expect(h.calls).toEqual(["observe:#go", "close"]);
    const row = lastActionRow(h.db);
    expect(row.payload["observedTarget"]).toBe("click: target was lost while observing it");
    expect(row.payload["classification"]).toBeNull();
    // Never classified, so no replay body was invented for it.
    const replay = h.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM cu_action WHERE session_id = ?")
      .get(sessionId);
    expect(replay?.n).toBe(0);
    await expectNoLiveSession(sessionId, h.deps);
  });

  test("a lane that dies during the pre-actuation snapshot actuates nothing, but stays tainted", async () => {
    let alive = true;
    const h = harness({
      browser: {
        isAlive: () => alive,
        onDomSnapshot: (call) => {
          if (call === 1) alive = false;
        },
      },
    });
    const sessionId = await openBrowser(h);
    const out = await runAction({ sessionId, kind: "read" }, h.deps);
    expect(out).toEqual({ outcome: "terminated_target_lost" });
    expect(h.calls).toEqual(["domSnapshot:1", "close"]); // readText never ran
    const replay = h.db
      .query<{ outcome: string; classification: string; dom_before: string | null }, [string]>(
        "SELECT outcome, classification, dom_before FROM cu_action WHERE session_id = ?",
      )
      .get(sessionId);
    expect(replay?.outcome).toBe("terminated_target_lost");
    expect(replay?.classification).toBe("observing");
    expect(replay?.dom_before).toBe("<html></html>");
    const sess = sessionRow(h.db, sessionId);
    expect(sess?.tainted_at).toBe(1000);
    expect(sess?.close_reason).toBe("terminated_target_lost");
  });

  test("an actuation that throws a non-Error is failed_after_approval, and the session lives on", async () => {
    const h = harness({ browser: { clickThrows: PLAIN_OBJECT_THROW } });
    const sessionId = await openBrowser(h);
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, h.deps);
    expect(out).toEqual({
      outcome: "failed_after_approval",
      result: "driver threw a plain object",
    });
    expect(lastActionRow(h.db).hitl_status).toBe("approved");
    // The browser is still alive, so this was a failed click, not a lost target.
    expect((await runAction({ sessionId, kind: "read" }, h.deps)).outcome).toBe("actuated");
    expect(h.calls).not.toContain("close");
  });

  test("an observation that throws a non-Error is refused_before_consent with its text", async () => {
    const h = harness({ browser: { observeThrows: PLAIN_OBJECT_THROW } });
    const sessionId = await openBrowser(h);
    const out = await runAction({ sessionId, kind: "click", selector: "#go" }, h.deps);
    expect(out).toEqual({
      outcome: "refused_before_consent",
      result: "driver threw a plain object",
    });
    expect(actionPrompts(h.prompts)).toHaveLength(0);
    expect(lastActionRow(h.db).hitl_status).toBe("rejected");
  });
});

describe("runAction — terminal arm", () => {
  test("a write carrying no text is an empty append: buffered, never written, never prompted", async () => {
    const h = harness();
    const sessionId = await openTerminal(h);
    expect(await runAction({ sessionId, kind: "terminal_write" }, h.deps)).toEqual({
      outcome: "buffered",
      result: "",
    });
    await runAction({ sessionId, kind: "terminal_write", text: "ls" }, h.deps);
    // An empty append leaves what was composed exactly as it was.
    expect(await runAction({ sessionId, kind: "terminal_write" }, h.deps)).toEqual({
      outcome: "buffered",
      result: "ls",
    });
    expect(h.terminal.writes).toEqual([]);
    expect(actionPrompts(h.prompts)).toHaveLength(0);
  });

  test("a shell that dies between consent and the write terminates the session and writes nothing", async () => {
    // The gate probes liveness right after the owner answers and again immediately before the
    // write; this shell survives the first probe and is gone by the second.
    let probes = 0;
    const h = harness({
      terminal: {
        isAlive: () => {
          probes += 1;
          return probes <= 1;
        },
      },
    });
    const sessionId = await openTerminal(h);
    const out = await runAction(
      { sessionId, kind: "terminal_write", text: "rm -rf build\n" },
      h.deps,
    );
    expect(out).toEqual({ outcome: "terminated_target_lost" });
    expect(probes).toBe(2);
    expect(actionPrompts(h.prompts)).toHaveLength(1); // the owner WAS asked, and said yes
    expect(h.terminal.writes).toEqual([]);
    expect(h.calls).toEqual(["close"]);
    const row = lastActionRow(h.db);
    expect(row.payload["observedTarget"]).toBe("rm -rf build");
    expect(row.payload["classification"]).toBe("actuating");
    expect(row.hitl_status).toBe("rejected");
    const sess = sessionRow(h.db, sessionId);
    expect(sess?.tainted_at).toBe(1000);
    expect(sess?.close_reason).toBe("terminated_target_lost");
    await expectNoLiveSession(sessionId, h.deps);
  });

  test("a write that fails on a live shell is failed_after_approval and the session stays live", async () => {
    const h = harness({
      terminal: { onWrite: (call) => (call === 1 ? new Error("broken pipe") : undefined) },
    });
    const sessionId = await openTerminal(h);
    const out = await runAction({ sessionId, kind: "terminal_write", text: "ls\n" }, h.deps);
    expect(out).toEqual({ outcome: "failed_after_approval", result: "broken pipe" });
    expect(lastActionRow(h.db).hitl_status).toBe("approved");
    // The shell is still alive, so this was a failed write, not a lost target.
    const again = await runAction({ sessionId, kind: "terminal_write", text: "pwd\n" }, h.deps);
    expect(again).toEqual({ outcome: "actuated", result: "out:pwd" });
    expect(h.calls).toEqual(["write:ls", "write:pwd"]);
  });

  test("a write that fails because the shell died terminates the session", async () => {
    let alive = true;
    const h = harness({
      terminal: {
        isAlive: () => alive,
        onWrite: () => {
          alive = false;
          return PLAIN_OBJECT_THROW;
        },
      },
    });
    const sessionId = await openTerminal(h);
    const out = await runAction({ sessionId, kind: "terminal_write", text: "make\n" }, h.deps);
    expect(out).toEqual({
      outcome: "failed_after_approval",
      result: "driver threw a plain object",
    });
    expect(h.calls).toEqual(["write:make", "close"]);
    expect(sessionRow(h.db, sessionId)?.close_reason).toBe("terminated_target_lost");
    await expectNoLiveSession(sessionId, h.deps);
  });
});
