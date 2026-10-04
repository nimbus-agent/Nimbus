/**
 * Paths of the model-facing computer-use tool layer (`cu-tools.ts`) that `cu-tools.test.ts` does
 * not reach: the `terminal_write` tool end to end through the real gate (I35) into the I11
 * envelope and the tool-call log, a tool input that is not an object, and a screenshot whose action
 * produced no digest.
 *
 * Session ids are unique to this file: the gate's live-session map is module-private and shared by
 * every test file in one `bun test` process, so a fixed id could collide with another file's
 * session.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { CuActionApprovalInput, CuEnvelopeApprovalInput } from "./cu-consent-broker.ts";
import { type CuGateDeps, closeSession, openSession } from "./cu-gate.ts";
import { buildComputerUseTools } from "./cu-tools.ts";
import type { BrowserLane, TerminalLane } from "./cu-types.ts";

type ToolExecute = (input: unknown) => Promise<unknown>;
type ToolsMap = Record<string, { execute?: ToolExecute } | undefined>;
type Approval = CuEnvelopeApprovalInput | CuActionApprovalInput;

let seq = 0;
const openDbs: Database[] = [];
const openSessions: Array<{ id: string; deps: CuGateDeps }> = [];

afterEach(async () => {
  for (const s of openSessions.splice(0)) await closeSession(s.id, s.deps);
  for (const db of openDbs.splice(0)) db.close();
});

function browserLaneStub(): BrowserLane {
  return {
    observe: async () => null,
    currentOrigin: () => "https://example.com",
    click: async () => {},
    type: async () => {},
    navigate: async () => {},
    readText: async () => "page text",
    domSnapshot: async () => "<html></html>",
    screenshot: async () => new Uint8Array([9, 9, 9]),
    isAlive: () => true,
    close: async () => {},
  };
}

function harness(): {
  deps: CuGateDeps;
  db: Database;
  approvals: Approval[];
  writes: string[];
} {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  openDbs.push(db);
  const approvals: Approval[] = [];
  const writes: string[] = [];
  const terminal: TerminalLane = {
    write: async (bytes) => {
      writes.push(bytes);
      return { output: `ran: ${bytes}`, settled: "quiet", truncated: false };
    },
    isAlive: () => true,
    close: async () => {},
  };
  seq += 1;
  const sessionId = `cu-tools-cov-${seq}`;
  const deps: CuGateDeps = {
    config: {
      ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
      enabled: true,
      allowedLanes: ["browser", "terminal"],
    },
    enforced: { capabilitiesDisabled: new Set<string>() },
    requestApproval: async (input) => {
      approvals.push(input);
      return true;
    },
    lanes: {
      browser: {
        resolveBrowserPath: () => "/fake/chrome",
        buildLaunchPolicy: () => ({
          profileDir: "/fake/profile",
          argv: ["--user-data-dir=/fake/profile"],
        }),
        assertLaunchable: () => null,
        openLane: async () => browserLaneStub(),
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
    now: () => 1_000,
    newId: () => sessionId,
  };
  return { deps, db, approvals, writes };
}

async function openLane(deps: CuGateDeps, lane: "browser" | "terminal"): Promise<string> {
  const out =
    lane === "terminal"
      ? await openSession({ lane: "terminal", cwd: "/work" }, deps)
      : await openSession(
          { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
          deps,
        );
  if (out.status !== "open")
    throw new Error(`expected an open session, got ${JSON.stringify(out)}`);
  openSessions.push({ id: out.sessionId, deps });
  return out.sessionId;
}

function tools(sessionId: string, lane: "browser" | "terminal", deps: CuGateDeps): ToolsMap {
  return buildComputerUseTools({ sessionId, lane }, deps) as unknown as ToolsMap;
}

function logRows(
  db: Database,
  toolId: string,
): Array<{ session_id: string; result_envelope: string; status: string }> {
  return db
    .query<{ session_id: string; result_envelope: string; status: string }, [string]>(
      "SELECT session_id, result_envelope, status FROM tool_call_log WHERE tool_id = ? ORDER BY id",
    )
    .all(toolId);
}

describe("terminal_write", () => {
  test("a complete line goes through the gate's single-use approval, runs verbatim, and comes back enveloped and logged", async () => {
    const h = harness();
    const sessionId = await openLane(h.deps, "terminal");
    const terminalWrite = tools(sessionId, "terminal", h.deps)["terminal_write"]?.execute;
    if (terminalWrite === undefined) throw new Error("terminal_write was not built");

    const envelope = await terminalWrite({ text: "ls -la\n", modelDescription: "list the dir" });

    // Exactly the approved line reached the shell, once.
    expect(h.writes).toEqual(["ls -la"]);
    const actionPrompts = h.approvals.filter(
      (a): a is CuActionApprovalInput => a.promptKind === "action",
    );
    expect(actionPrompts).toHaveLength(1);
    expect(actionPrompts[0]).toMatchObject({
      kind: "terminal_write",
      observedTarget: "ls -la",
      classification: "actuating",
      modelDescription: "list the dir",
    });
    // The output is untrusted shell text, so it comes back inside the I11 envelope...
    expect(envelope).toBe(
      `<tool_output service="computer_use" tool="terminal_write">${JSON.stringify({
        outcome: "actuated",
        result: "ran: ls -la",
      })}</tool_output>`,
    );
    // ...and the SAME envelope is what the tool-call log recorded.
    expect(logRows(h.db, "terminal_write")).toEqual([
      { session_id: sessionId, result_envelope: envelope as string, status: "ok" },
    ]);
  });

  test("a call with no text composes nothing: buffered, never run, never prompted", async () => {
    const h = harness();
    const sessionId = await openLane(h.deps, "terminal");
    const terminalWrite = tools(sessionId, "terminal", h.deps)["terminal_write"]?.execute;
    const envelope = await terminalWrite?.({});
    expect(envelope).toBe(
      `<tool_output service="computer_use" tool="terminal_write">${JSON.stringify({
        outcome: "buffered",
        result: "",
      })}</tool_output>`,
    );
    expect(h.writes).toEqual([]);
    expect(h.approvals.filter((a) => a.promptKind === "action")).toEqual([]);
  });

  test("an input that is not an object is never read as the command — even a string ending in a newline", async () => {
    const h = harness();
    const sessionId = await openLane(h.deps, "terminal");
    const terminalWrite = tools(sessionId, "terminal", h.deps)["terminal_write"]?.execute;
    const envelope = await terminalWrite?.("rm -rf ~\n");
    // The EXACT envelope: nothing was composed. `"buffered"` alone would also pass for a call that
    // put text into the buffer without submitting it, leaving it armed for the next newline.
    expect(envelope).toBe(
      `<tool_output service="computer_use" tool="terminal_write">${JSON.stringify({
        outcome: "buffered",
        result: "",
      })}</tool_output>`,
    );
    expect(h.writes).toEqual([]);
    expect(h.approvals.filter((a) => a.promptKind === "action")).toEqual([]);
  });
});

describe("browser_screenshot with no digest", () => {
  test("an action that produced nothing reports a null digest, and logs a plain JSON record — not an envelope", async () => {
    const h = harness();
    const sessionId = await openLane(h.deps, "browser");
    const screenshot = tools(sessionId, "browser", {
      ...h.deps,
      // Revoked mid-session: the gate terminates the session instead of capturing anything.
      config: { ...h.deps.config, enabled: false },
    })["browser_screenshot"]?.execute;

    const result = await screenshot?.({});

    expect(result).toEqual({ outcome: "terminated_policy", screenshotDigest: null });
    const rows = logRows(h.db, "browser_screenshot");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.result_envelope ?? "null")).toEqual({
      outcome: "terminated_policy",
      screenshotDigest: null,
    });
    expect(rows[0]?.result_envelope).not.toContain("<tool_output");
  });
});
