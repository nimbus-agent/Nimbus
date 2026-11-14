import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import type { ClientKind } from "../ipc/server/client-kind.ts";
import { resolveCaptureCapability } from "./capture-capability.ts";
import {
  DESCRIBE_REPLY_MAX_BYTES,
  DESCRIBE_TYPES_MAX,
  describeActions,
} from "./capture-describe.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { type ActionDescription, CaptureError } from "./capture-types.ts";

const MCP = { clientId: "c-mcp", kind: "mcp" as ClientKind };
const NOW = 1_790_000_000_000;

function entry(actionType: string, extra = ""): Extract<ActionDescription, { state: "approved" }> {
  return {
    actionType,
    state: "approved",
    wave: 2,
    typedConfirm: false,
    bound: false,
    description: `d${extra}`,
    inputSchema: { type: "object" },
  };
}

interface Harness {
  readonly calls: Array<readonly string[] | undefined>;
  readonly refusals: CaptureRefusalCounter;
  readonly deps: Parameters<typeof describeActions>[0];
}

function harness(
  opts: {
    actionEnabled?: boolean;
    maxPerHour?: number;
    noDescriber?: boolean;
    actions?: (t: readonly string[] | undefined) => Promise<readonly ActionDescription[]>;
    limiter?: CaptureAttemptLimiter;
  } = {},
): Harness {
  const calls: Array<readonly string[] | undefined> = [];
  const refusals = new CaptureRefusalCounter();
  const capability = resolveCaptureCapability(
    {
      ok: true,
      config: {
        ...DEFAULT_MCP_SINK_CONFIG,
        enabled: true,
        kinds: opts.actionEnabled === false ? ["note"] : ["note", "action"],
        maxPerHour: opts.maxPerHour ?? DEFAULT_MCP_SINK_CONFIG.maxPerHour,
      },
    },
    { capabilitiesDisabled: new Set() },
  );
  const actions =
    opts.actions ??
    (async (types: readonly string[] | undefined) =>
      types === undefined ? [] : types.map((t) => entry(t)));
  return {
    calls,
    refusals,
    deps: {
      capability: () => capability,
      refusals,
      now: () => NOW,
      ...(opts.noDescriber === true
        ? {}
        : {
            describer: {
              limiter: opts.limiter ?? new CaptureAttemptLimiter(),
              actions: async (t) => {
                calls.push(t);
                return actions(t);
              },
            },
          }),
    },
  };
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (e) {
    return (e as Error).message;
  }
  return "no refusal";
};

describe("describeActions: the gate order", () => {
  test("the source reads capability, role, params, limiter, describer, reply cap, in that order", () => {
    const src = readFileSync(join(import.meta.dir, "capture-describe.ts"), "utf8");
    const order = [
      "requireDescribeCapability(",
      "CAPTURE_ROLE_BY_KIND[caller.kind]",
      "requireDescribeParams(",
      "describer.limiter.tryAcquire(",
      "describer.actions(",
      "capReply(",
    ].map((needle) => src.indexOf(needle, src.indexOf("export async function describeActions")));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  test("an mcp caller with no arguments gets the summary, and the describer is called with undefined", async () => {
    const h = harness({ actions: async () => [entry("github.issue.create")] });
    const out = await describeActions(h.deps, MCP, undefined);
    expect(out).toEqual({ actions: [entry("github.issue.create")], truncated: false });
    expect(h.calls).toEqual([undefined]);
    expect((await describeActions(h.deps, MCP, null)).truncated).toBe(false);
    const again = await describeActions(h.deps, MCP, {});
    expect(again.truncated).toBe(false);
    expect(h.calls).toEqual([undefined, undefined, undefined]);
  });

  test("a cli, ui, unknown, http, chatops, fleet and push caller is refused before the describer runs", async () => {
    for (const kind of ["cli", "ui", "unknown", "http", "chatops", "fleet", "push"] as const) {
      const h = harness();
      const msg = await refusal(describeActions(h.deps, { clientId: "x", kind }, {}));
      expect(msg, kind).toContain("ERR_CAPTURE_FORBIDDEN_CLIENT");
      expect(h.calls, kind).toEqual([]);
      expect(h.refusals.snapshot()["ERR_CAPTURE_FORBIDDEN_CLIENT"]).toBe(1);
    }
  });

  test("with the act door off the method refuses ERR_CAPTURE_DISABLED before the role is read", async () => {
    const h = harness({ actionEnabled: false });
    const msg = await refusal(describeActions(h.deps, { clientId: "x", kind: "cli" }, {}));
    expect(msg).toContain("ERR_CAPTURE_DISABLED");
    expect(h.calls).toEqual([]);
  });

  test("an absent describer refuses ERR_CAPTURE_DISABLED", async () => {
    const h = harness({ noDescriber: true });
    expect(await refusal(describeActions(h.deps, MCP, {}))).toContain("ERR_CAPTURE_DISABLED");
  });

  test("the limiter refuses call 4 x max_per_hour + 1, on its own window, while a submit limiter still passes", async () => {
    const limiter = new CaptureAttemptLimiter();
    const submitLimiter = new CaptureAttemptLimiter();
    const h = harness({ maxPerHour: 2, limiter });
    for (let i = 0; i < 8; i++) await describeActions(h.deps, MCP, {});
    expect(await refusal(describeActions(h.deps, MCP, {}))).toContain("ERR_CAPTURE_RATE_LIMITED");
    expect(h.calls).toHaveLength(8);
    expect(submitLimiter.tryAcquire(NOW, 2 * 4)).toBe(true);
    expect(h.refusals.snapshot()["ERR_CAPTURE_RATE_LIMITED"]).toBe(1);
  });
});

describe("describeActions: the params", () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["a non-object", "github.issue.create"],
    ["an array", ["github.issue.create"]],
    ["actionTypes that is not an array", { actionTypes: "a.b" }],
    ["an empty array", { actionTypes: [] }],
    ["a non-string entry", { actionTypes: ["github.issue.create", 7] }],
    ["an empty string", { actionTypes: [""] }],
    [
      "eleven types",
      { actionTypes: Array.from({ length: DESCRIBE_TYPES_MAX + 1 }, () => "github.issue.create") },
    ],
    ["a 129-character type", { actionTypes: [`github.${"a".repeat(122)}`] }],
    [
      "four services",
      {
        actionTypes: [
          "github.issue.create",
          "gitlab.issue.create",
          "jira.issue.create",
          "slack.message.post",
        ],
      },
    ],
  ];

  test("each malformed or oversized request is ERR_CAPTURE_INVALID before the describer runs", async () => {
    for (const [name, params] of bad) {
      const h = harness();
      // Eleven copies of one type de-duplicate to one: the bound is on what the caller sent.
      const msg = await refusal(describeActions(h.deps, MCP, params));
      expect(msg, name).toContain("ERR_CAPTURE_INVALID");
      expect(h.calls, name).toEqual([]);
    }
  });

  test("a 128-character type, ten types and three services are accepted, duplicates removed in order", async () => {
    const h = harness();
    const long = `github.${"a".repeat(121)}`;
    expect(long).toHaveLength(128);
    const out = await describeActions(h.deps, MCP, {
      actionTypes: [long, "gitlab.issue.create", "jira.issue.create", long],
    });
    expect(out.actions.map((a) => a.actionType)).toEqual([
      long,
      "gitlab.issue.create",
      "jira.issue.create",
    ]);
    const ten = Array.from({ length: 10 }, (_, i) => `github.t${String(i)}`);
    const h2 = harness();
    await describeActions(h2.deps, MCP, { actionTypes: ten });
    expect(h2.calls[0]).toEqual(ten);
  });

  test("a malformed call from an allowed caller consumes nothing from the limiter; a well-formed one does", async () => {
    const limiter = new CaptureAttemptLimiter();
    const h = harness({ maxPerHour: 1, limiter }); // 4 describes an hour
    for (let i = 0; i < 10; i++) {
      expect(await refusal(describeActions(h.deps, MCP, { actionTypes: [] }))).toContain(
        "ERR_CAPTURE_INVALID",
      );
    }
    for (let i = 0; i < 4; i++) await describeActions(h.deps, MCP, {});
    expect(await refusal(describeActions(h.deps, MCP, {}))).toContain("ERR_CAPTURE_RATE_LIMITED");
  });

  test("a describer that throws becomes a fixed-text CaptureError: the thrown message never reaches the caller", async () => {
    const h = harness({
      actions: async () => {
        throw new Error("SQLITE_CORRUPT: /home/owner/nimbus.db");
      },
    });
    const msg = await refusal(describeActions(h.deps, MCP, undefined));
    expect(msg).toContain("ERR_CAPTURE_STATE");
    expect(msg).not.toContain("SQLITE");
    expect(msg).not.toContain("nimbus.db");
    try {
      await describeActions(h.deps, MCP, undefined);
    } catch (e) {
      expect(e).toBeInstanceOf(CaptureError);
    }
  });

  test("a CaptureError from the describer passes through unchanged", async () => {
    const h = harness({
      actions: async () => {
        throw new CaptureError("ERR_CAPTURE_DISABLED", "the agent door is not available");
      },
    });
    expect(await refusal(describeActions(h.deps, MCP, undefined))).toBe(
      "ERR_CAPTURE_DISABLED: the agent door is not available",
    );
  });
});

describe("describeActions: the reply cap", () => {
  test("an entry that would cross the byte cap and every later one become undescribed, in request order, with truncated", async () => {
    const big = (t: string): ActionDescription => ({
      ...entry(t),
      description: "x".repeat(DESCRIBE_REPLY_MAX_BYTES / 3),
    });
    const h = harness({ actions: async (types) => (types ?? []).map(big) });
    const out = await describeActions(h.deps, MCP, {
      actionTypes: ["github.a", "github.b", "github.c", "github.d"],
    });
    expect(out.truncated).toBe(true);
    expect(out.actions.map((a) => a.state)).toEqual([
      "approved",
      "approved",
      "undescribed",
      "undescribed",
    ]);
    const cutEntry = out.actions[2];
    if (cutEntry?.state !== "undescribed") throw new Error("expected a cut entry");
    expect(cutEntry.reason).not.toContain("alone");
    expect(out.actions.map((a) => a.actionType)).toEqual([
      "github.a",
      "github.b",
      "github.c",
      "github.d",
    ]);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(DESCRIBE_REPLY_MAX_BYTES);
  });

  test("the cap counts bytes, not characters", async () => {
    const wide = (t: string): ActionDescription => ({
      ...entry(t),
      description: "é".repeat(DESCRIBE_REPLY_MAX_BYTES / 3),
    });
    const h = harness({ actions: async (types) => (types ?? []).map(wide) });
    const out = await describeActions(h.deps, MCP, { actionTypes: ["github.a", "github.b"] });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(DESCRIBE_REPLY_MAX_BYTES);
  });

  test("a kept entry that nearly fills the cap, followed by a cut entry, still leaves a reply under the cap", async () => {
    // The replacement of a cut entry has a size of its own: it is budgeted before anything is kept.
    for (const slack of [0, 1, 40, 80, 120, 200]) {
      const first = (t: string): ActionDescription => ({
        ...entry(t),
        description: "x".repeat(DESCRIBE_REPLY_MAX_BYTES - 400 + slack),
      });
      const h = harness({
        actions: async (types) =>
          (types ?? []).map((t, i) =>
            i === 0 ? first(t) : { ...entry(t), description: "y".repeat(900) },
          ),
      });
      const out = await describeActions(h.deps, MCP, {
        actionTypes: ["github.a", "github.b", "github.c"],
      });
      expect(Buffer.byteLength(JSON.stringify(out)), String(slack)).toBeLessThanOrEqual(
        DESCRIBE_REPLY_MAX_BYTES,
      );
      expect(out.actions.length).toBe(3);
    }
  });

  test("the reply cap leaves headroom under the IPC line limit", async () => {
    const { IPC_MAX_LINE_BYTES } = await import("../ipc/jsonrpc.ts");
    expect(DESCRIBE_REPLY_MAX_BYTES).toBeLessThanOrEqual(IPC_MAX_LINE_BYTES / 2);
  });

  test("a reply under the cap is untouched", async () => {
    const h = harness();
    const out = await describeActions(h.deps, MCP, { actionTypes: ["github.a"] });
    expect(out).toEqual({ actions: [entry("github.a")], truncated: false });
  });
});

describe("capture-describe.ts imports only sink modules (static D32(f))", () => {
  test("no import from connectors/ or the executor, type imports included", () => {
    const src = readFileSync(join(import.meta.dir, "capture-describe.ts"), "utf8");
    const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec, spec).not.toMatch(/connectors\/|engine\/executor/);
    }
  });
});
