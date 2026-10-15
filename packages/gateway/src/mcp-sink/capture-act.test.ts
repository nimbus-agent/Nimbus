import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import {
  type ActGateDeps,
  acceptAction,
  classifyActionError,
  formatActionConsent,
  outcomeRefOf,
  reconcileActionsAtBoot,
} from "./capture-act.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import { CaptureStore } from "./capture-store.ts";
import { type ActDeps, CaptureError, type CaptureRow } from "./capture-types.ts";

const OWNER = { clientId: "c-cli", kind: "unknown" as const };
const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const RLO = String.fromCodePoint(0x202e);
let db: Database;
let clock: number;
let cap: CaptureCapability;
let verdict: "proposable" | "denied";
let configured: boolean;
let deps: ActGateDeps;

function capWith(disabled: string[] = []): CaptureCapability {
  return resolveCaptureCapability(
    { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] } },
    { capabilitiesDisabled: new Set(disabled) },
  );
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000;
  cap = capWith();
  verdict = "proposable";
  configured = true;
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    classifyAction: () =>
      verdict === "proposable" ? { kind: "proposable" } : { kind: "denied", class: "vcs" },
    isServiceConfigured: () => Promise.resolve(configured),
    now: () => clock,
  };
  deps.store.insert({
    id: "cap_a",
    kind: "action",
    state: "proposed",
    itemId: null,
    payloadJson: JSON.stringify({
      actionType: "slack.message.post",
      input: { text: "hi" },
      summary: "why",
    }),
    payloadBytes: 10,
    clientLabel: "agent",
    sessionId: "s",
    createdAt: 500,
    expiresAt: 2_000,
  });
});
afterEach(() => db.close());

function row(): CaptureRow {
  return deps.store.get("cap_a") as CaptureRow;
}
function act(
  out: Awaited<ReturnType<ActDeps["execute"]>> | Error,
): ActDeps & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    execute: (...a) => {
      calls.push(a);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  };
}
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected CaptureError");
}
function audits(): Array<{ action_type: string; hitl_status: string; action_json: string }> {
  return db
    .query(
      "SELECT action_type, hitl_status, action_json FROM audit_log WHERE action_type LIKE 'capture.action.%' ORDER BY id",
    )
    .all() as never;
}

describe("acceptAction — ordered refusals", () => {
  test("1 capability: mcp_action locked → DISABLED, row stays proposed, nothing executed", async () => {
    cap = capWith(["mcp_action"]);
    const a = act({ status: "ok", result: {} });
    expect(await code(acceptAction(deps, OWNER, row(), a))).toBe("ERR_CAPTURE_DISABLED");
    expect(row().state).toBe("proposed");
    expect(a.calls).toHaveLength(0);
  });
  test("act absent → DISABLED (no fallback)", async () => {
    expect(await code(acceptAction(deps, OWNER, row(), undefined))).toBe("ERR_CAPTURE_DISABLED");
  });
  test("2 an mcp client is refused", async () => {
    expect(await code(acceptAction(deps, MCP, row(), act({ status: "rejected" })))).toBe(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
  });
  test("3 at expires_at exactly: expired + audited + refused EXPIRED (Review Focus 2)", async () => {
    clock = 2_000;
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} })))).toBe(
      "ERR_CAPTURE_EXPIRED",
    );
    expect(row().state).toBe("expired");
    expect(audits().map((r) => r.action_type)).toEqual(["capture.action.expire"]);
  });
  test("4 re-classify: denied now → NOT_PROPOSABLE, stays proposed", async () => {
    verdict = "denied";
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} })))).toBe(
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    );
    expect(row().state).toBe("proposed");
  });
  test("4 re-check configured: removed connector → UNCONFIGURED, stays proposed", async () => {
    configured = false;
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "ok", result: {} })))).toBe(
      "ERR_CAPTURE_CONNECTOR_UNCONFIGURED",
    );
    expect(row().state).toBe("proposed");
  });
  test("5 claim lost (expired during the configured await) → STATE, no execute", async () => {
    deps = {
      ...deps,
      isServiceConfigured: () => {
        clock = 2_000;
        return Promise.resolve(true);
      },
    };
    const a = act({ status: "ok", result: {} });
    expect(await code(acceptAction(deps, OWNER, row(), a))).toBe("ERR_CAPTURE_STATE");
    expect(a.calls).toHaveLength(0);
  });
});

describe("acceptAction — outcomes", () => {
  test("a token-shaped segment in outcomeRef is redacted in the audit log, kept on the capture row", async () => {
    const ref = "https://slack.example/p/1?t=xoxb-1234567890abcdef";
    await acceptAction(deps, OWNER, row(), act({ status: "ok", result: { url: ref } }));
    expect(row().outcomeRef).toBe(ref);
    const outcome = audits().find((r) => r.action_type === "capture.action.outcome");
    expect(outcome?.action_json).not.toContain("xoxb-1234567890abcdef");
    expect(JSON.parse(outcome?.action_json ?? "{}")).toMatchObject({
      outcomeRef: "https://slack.example/p/1?t=[REDACTED]",
    });
  });
  test("ok → executed with outcome_ref; accept + outcome audits, both not_required", async () => {
    const a = act({ status: "ok", result: { url: "https://slack.example/p/1", body: "secret" } });
    const out = await acceptAction(deps, OWNER, row(), a);
    expect(out).toEqual({
      id: "cap_a",
      state: "executed",
      outcomeRef: "https://slack.example/p/1",
    });
    expect(row()).toMatchObject({ state: "executed", outcomeRef: "https://slack.example/p/1" });
    expect(a.calls[0]?.[0]).toBe("slack.message.post");
    expect(a.calls[0]?.[1]).toEqual({ text: "hi" });
    expect(a.calls[0]?.[2]).toMatchObject({
      captureId: "cap_a",
      clientLabel: "agent",
      createdAt: 500,
      expiresAt: 2_000,
      summary: "why",
    });
    expect(audits().map((r) => [r.action_type, r.hitl_status])).toEqual([
      ["capture.action.accept", "not_required"],
      ["capture.action.outcome", "not_required"],
    ]);
    expect(audits()[1]?.action_json).not.toContain("secret");
  });
  test("execute sees the row as executing (claim happened first)", async () => {
    let seen = "";
    await acceptAction(deps, OWNER, row(), {
      execute: () => {
        seen = row().state;
        return Promise.resolve({ status: "rejected" });
      },
    });
    expect(seen).toBe("executing");
  });
  test("rejected → rejected", async () => {
    expect((await acceptAction(deps, OWNER, row(), act({ status: "rejected" }))).state).toBe(
      "rejected",
    );
    expect(row().state).toBe("rejected");
  });
  test("throw → failed with a classified code, never the message", async () => {
    const out = await acceptAction(
      deps,
      OWNER,
      row(),
      act(new Error("Tool slack_message_post exceeded 60000ms timeout")),
    );
    expect(out).toEqual({ id: "cap_a", state: "failed", errorCode: "ERR_ACTION_TIMEOUT" });
    expect(row().errorCode).toBe("ERR_ACTION_TIMEOUT");
  });
  test("a second accept refuses STATE", async () => {
    await acceptAction(deps, OWNER, row(), act({ status: "rejected" }));
    expect(await code(acceptAction(deps, OWNER, row(), act({ status: "rejected" })))).toBe(
      "ERR_CAPTURE_STATE",
    );
  });
  test("ok without an https ref → executed with no outcomeRef", async () => {
    const out = await acceptAction(deps, OWNER, row(), act({ status: "ok", result: { id: 7 } }));
    expect(out).toEqual({ id: "cap_a", state: "executed" });
    expect(row().outcomeRef).toBeNull();
  });
  test("classifyAction absent → NOT_PROPOSABLE (fail-closed)", async () => {
    const { classifyAction: _c, ...rest } = deps;
    expect(await code(acceptAction(rest, OWNER, row(), act({ status: "rejected" })))).toBe(
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
    );
  });
  test("a finalize that loses the row returns the outcome, writes no outcome audit, never throws", async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    let out: Awaited<ReturnType<typeof acceptAction>>;
    try {
      out = await acceptAction(deps, OWNER, row(), {
        execute: () => {
          // Simulates the row leaving `executing` behind the gate's back (a concurrent boot reconcile).
          deps.store.failInterruptedActions(clock);
          return Promise.resolve({ status: "rejected" });
        },
      });
      expect(String(stderr.mock.calls[0]?.[0])).toContain("finalize failed for cap_a");
    } finally {
      stderr.mockRestore();
    }
    expect(out).toEqual({ id: "cap_a", state: "rejected" });
    expect(row()).toMatchObject({ state: "failed", errorCode: "ERR_ACTION_INTERRUPTED" });
    expect(audits().map((r) => r.action_type)).toEqual(["capture.action.accept"]);
  });
});

describe("pure helpers", () => {
  test("classifyActionError", () => {
    expect(classifyActionError(new Error("Tool x exceeded 5ms timeout"))).toBe(
      "ERR_ACTION_TIMEOUT",
    );
    expect(classifyActionError(new Error("Tool not found"))).toBe("ERR_ACTION_TOOL_NOT_FOUND");
    expect(classifyActionError(new Error('MCP tool "x" has no execute implementation'))).toBe(
      "ERR_ACTION_TOOL_NOT_FOUND",
    );
    expect(classifyActionError("weird")).toBe("ERR_ACTION_DISPATCH");
  });
  test("outcomeRefOf: https only, ≤ 512, field order url > html_url > webUrl > permalink", () => {
    expect(outcomeRefOf({ permalink: "https://b", url: "https://a" })).toBe("https://a");
    expect(outcomeRefOf({ url: "http://a", html_url: "https://h" })).toBe("https://h");
    expect(outcomeRefOf({ url: `https://${"a".repeat(600)}` })).toBeUndefined();
    expect(outcomeRefOf({ url: "javascript:alert(1)" })).toBeUndefined();
    expect(outcomeRefOf([{ url: "https://a" }])).toBeUndefined();
    expect(outcomeRefOf(null)).toBeUndefined();
  });
  test("formatActionConsent carries provenance + verbatim input", () => {
    const s = formatActionConsent(
      { captureId: "cap_a", clientLabel: null, createdAt: 0, expiresAt: 3_600_000, summary: "why" },
      "slack.message.post",
      { channel: "C1", text: "hi" },
    );
    expect(s).toContain(
      'Proposed by MCP client "unlabelled" at 1970-01-01T00:00:00.000Z, expires 1970-01-01T01:00:00.000Z',
    );
    expect(s).toContain("Agent's summary (unverified): why");
    expect(s).toContain("Type: slack.message.post");
    expect(s).toContain('"text": "hi"');
  });
  test("an RLO inside an input value is shown escaped (Review Focus 1)", () => {
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { text: `pay ${RLO}evil` },
    );
    expect(s).not.toContain(RLO);
    expect(s).toContain("\\u202e");
  });
  test.each([
    ["LRM", 0x200e],
    ["RLM", 0x200f],
    ["word joiner", 0x2060],
    ["invisible times", 0x2062],
    ["FSI", 0x2068],
    ["soft hyphen", 0x00ad],
    ["Arabic letter mark", 0x061c],
    ["BOM", 0xfeff],
    ["TAG LATIN SMALL LETTER I", 0xe0069],
    ["variation selector 16", 0xfe0f],
    ["Hangul filler", 0x3164],
  ])("%s inside an input value is shown escaped", (_name, cp) => {
    const ch = String.fromCodePoint(cp);
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { text: `a${ch}b` },
    );
    expect(s).not.toContain(ch);
    const hex = cp.toString(16);
    expect(s).toContain(cp > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`);
  });
  test("a hidden TAG-character instruction inside an input value is fully visible", () => {
    // "ignore" spelled in TAG characters (U+E0000 + ASCII), invisible in most renderers.
    const hidden = [..."ignore"]
      .map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)))
      .join("");
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { text: `hi${hidden}` },
    );
    expect(s).toContain("hi\\u{e0069}\\u{e0067}\\u{e006e}\\u{e006f}\\u{e0072}\\u{e0065}");
    expect([...s].some((c) => (c.codePointAt(0) ?? 0) >= 0xe0000)).toBe(false);
  });
  test('a " in the client label cannot close the quotes and fake provenance', () => {
    const s = formatActionConsent(
      {
        captureId: "c",
        clientLabel: 'x" at 2099-01-01T00:00:00.000Z, expires 2099-01-02T00:00:00.000Z \\ y',
        createdAt: 0,
        expiresAt: 0,
        summary: "s",
      },
      "slack.message.post",
      { text: "hi" },
    );
    expect(s).toContain(
      'Proposed by MCP client "x\\" at 2099-01-01T00:00:00.000Z, expires 2099-01-02T00:00:00.000Z \\\\ y" at 1970-01-01T00:00:00.000Z',
    );
  });
  test("ESC and a newline in the client label are escaped, and stay on one prompt line", () => {
    const s = formatActionConsent(
      {
        captureId: "c",
        clientLabel: `ok${String.fromCodePoint(0x1b)}[2J\nType: fake`,
        createdAt: 0,
        expiresAt: 0,
        summary: "s",
      },
      "slack.message.post",
      { text: "hi" },
    );
    expect(s).not.toContain(String.fromCodePoint(0x1b));
    expect(s).toContain("\\u001b[2J\\u000aType: fake");
    expect(s.split("\n").filter((l) => l.startsWith("Type: "))).toEqual([
      "Type: slack.message.post",
    ]);
  });
  test("a hostile action type passed directly is escaped and stays on one Type line", () => {
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      `mcp_echo.echo${esc}[8m${rlo}\nInput: fake`,
      { text: "hi" },
    );
    expect(s).not.toContain(esc);
    expect(s).not.toContain(rlo);
    expect(s.split("\n").filter((l) => l.startsWith("Type: "))).toEqual([
      "Type: mcp_echo.echo\\u001b[8m\\u202e\\u000aInput: fake",
    ]);
  });
  test("the pretty-printed input keeps its layout newlines", () => {
    const s = formatActionConsent(
      { captureId: "c", clientLabel: null, createdAt: 0, expiresAt: 0, summary: "s" },
      "slack.message.post",
      { a: 1, b: 2 },
    );
    expect(s).toContain('{\n  "a": 1,\n  "b": 2\n}');
  });
});

describe("reconcileActionsAtBoot (Review Focus 5)", () => {
  test("executing → failed/INTERRUPTED and due → expired, each audited", () => {
    deps.store.claimAction("cap_a", 1_000);
    deps.store.insert({
      id: "cap_b",
      kind: "action",
      state: "proposed",
      itemId: null,
      payloadJson: "{}",
      payloadBytes: 2,
      clientLabel: null,
      sessionId: "s",
      createdAt: 1,
      expiresAt: 10,
    });
    expect(reconcileActionsAtBoot(deps, 1_500)).toEqual({ expired: 1, interrupted: 1 });
    expect(row()).toMatchObject({ state: "failed", errorCode: "ERR_ACTION_INTERRUPTED" });
    expect(deps.store.get("cap_b")?.state).toBe("expired");
    expect(
      audits()
        .map((r) => r.action_type)
        .sort(),
    ).toEqual(["capture.action.expire", "capture.action.outcome"]);
  });
});
