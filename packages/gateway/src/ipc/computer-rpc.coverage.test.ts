import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CuActionApprovalInput,
  CuActionConsentBroker,
  type CuEnvelopeApprovalInput,
  CuEnvelopeConsentBroker,
} from "../computer-use/cu-consent-broker.ts";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type ComputerRpcCtx, dispatchComputerRpc } from "./computer-rpc.ts";

/**
 * Transport-level coverage for `computer.sessionOpen`'s TERMINAL-lane forwarding (`shellId`,
 * `maxWallClockMs`) and for `computer.sessionStatus` over real `cu_session` rows. The owner DENIES
 * every envelope here, so the gate stops at consent (I35) and no lane is ever opened — what is
 * asserted is exactly what crossed this RPC boundary into the envelope the owner was shown.
 */

const brokers: Array<CuEnvelopeConsentBroker | CuActionConsentBroker> = [];
const dbs: Database[] = [];

afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
  for (const db of dbs.splice(0)) db.close();
});

type Seen = {
  readonly prompts: Array<CuEnvelopeApprovalInput | CuActionApprovalInput>;
  readonly shellIds: string[];
};

function makeTerminalCtx(): { ctx: ComputerRpcCtx; seen: Seen; db: Database } {
  const db = new Database(":memory:");
  dbs.push(db);
  runIndexedSchemaMigrations(db, 57);
  const envelopeConsent = new CuEnvelopeConsentBroker();
  const actionConsent = new CuActionConsentBroker();
  brokers.push(envelopeConsent, actionConsent);
  const seen: Seen = { prompts: [], shellIds: [] };
  const ctx: ComputerRpcCtx = {
    envelopeConsent,
    actionConsent,
    gateDeps: {
      config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: ["terminal"] },
      enforced: { capabilitiesDisabled: new Set<string>() },
      lanes: {
        browser: {
          resolveBrowserPath: () => null,
          buildLaunchPolicy: ({ profileDir }) => ({ profileDir, argv: [] }),
          assertLaunchable: () => "the browser lane is not used here",
          openLane: () => {
            throw new Error("the browser lane is never opened in this file");
          },
        },
        terminal: {
          defaultShellId: "sh",
          resolveShellPath: (shellId) => {
            seen.shellIds.push(shellId);
            return { status: "ok", shellPath: `/fake/${shellId}`, argv: [], envOverlay: {} };
          },
          buildLaunchPolicy: ({ sessionId, shellId, shellPath, cwd }) => ({
            shellId,
            shellPath,
            argv: [],
            cwd,
            envOverlay: {},
            policy: {
              id: `cu-terminal-${sessionId}`,
              permissions: { network: [], filesystem: { read: [cwd], write: [cwd] } },
            },
          }),
          assertLaunchable: () => null,
          openLane: () => {
            throw new Error("a denied envelope must never open the terminal lane");
          },
        },
      },
      db,
      now: () => 1_700_000_000_000,
      newId: () => "s-term",
      requestApproval: async (input) => {
        seen.prompts.push(input);
        return false;
      },
    },
  };
  return { ctx, seen, db };
}

async function hit(method: string, params: unknown, ctx: ComputerRpcCtx): Promise<unknown> {
  const out = await dispatchComputerRpc(method, params, ctx);
  if (out.kind !== "hit") throw new Error(`${method} missed`);
  return out.value;
}

describe("computer.sessionOpen — terminal-lane forwarding into the owner's envelope", () => {
  const cwd = join(tmpdir(), "nimbus-cu-rpc-cwd");

  test("a requested shellId and maxWallClockMs reach the envelope verbatim", async () => {
    const { ctx, seen } = makeTerminalCtx();
    const result = await hit(
      "computer.sessionOpen",
      { lane: "terminal", cwd, shellId: "pwsh", maxWallClockMs: 1_234 },
      ctx,
    );

    expect(result).toEqual({ status: "denied" });
    expect(seen.shellIds).toEqual(["pwsh"]);
    expect(seen.prompts).toEqual([
      {
        promptKind: "envelope",
        lane: "terminal",
        sessionId: "s-term",
        shellId: "pwsh",
        cwd,
        maxActions: DEFAULT_NIMBUS_COMPUTER_USE_TOML.maxActions,
        maxWallClockMs: 1_234,
      },
    ]);
  });

  test("without either field the default shell and the configured wall-clock bound apply", async () => {
    const { ctx, seen } = makeTerminalCtx();
    await hit("computer.sessionOpen", { lane: "terminal", cwd }, ctx);

    expect(seen.shellIds).toEqual(["sh"]);
    const prompt = seen.prompts[0] as CuEnvelopeApprovalInput & { shellId: string };
    expect(prompt.shellId).toBe("sh");
    expect(prompt.maxWallClockMs).toBe(DEFAULT_NIMBUS_COMPUTER_USE_TOML.maxWallClockMs);
  });

  test("non-string shellId and non-number maxWallClockMs are ignored, not coerced", async () => {
    const { ctx, seen } = makeTerminalCtx();
    await hit(
      "computer.sessionOpen",
      { lane: "terminal", cwd, shellId: 7, maxWallClockMs: "1234" },
      ctx,
    );

    expect(seen.shellIds).toEqual(["sh"]);
    const prompt = seen.prompts[0] as CuEnvelopeApprovalInput;
    expect(prompt.maxWallClockMs).toBe(DEFAULT_NIMBUS_COMPUTER_USE_TOML.maxWallClockMs);
  });
});

describe("computer.sessionStatus over durable cu_session rows", () => {
  function seedSessions(db: Database): void {
    const insert = db.prepare(
      `INSERT INTO cu_session (id, lane, envelope_json, opened_at, closed_at, close_reason, tainted_at, actions_used)
       VALUES (?, ?, '{}', ?, ?, ?, ?, ?)`,
    );
    insert.run("s-old", "browser", 1_000, 2_000, "owner_closed", 1_500, 3);
    insert.run("s-new", "terminal", 5_000, null, null, null, 0);
    insert.finalize();
  }

  test("a named session returns its row mapped to the status entry (closed => open:false)", async () => {
    const { ctx, db } = makeTerminalCtx();
    seedSessions(db);
    expect(await hit("computer.sessionStatus", { sessionId: "s-old" }, ctx)).toEqual({
      sessions: [
        {
          sessionId: "s-old",
          lane: "browser",
          openedAt: 1_000,
          closedAt: 2_000,
          closeReason: "owner_closed",
          taintedAt: 1_500,
          actionsUsed: 3,
          open: false,
        },
      ],
    });
  });

  test("no sessionId (or an empty one) lists every session newest-first", async () => {
    const { ctx, db } = makeTerminalCtx();
    seedSessions(db);
    const expected = {
      sessions: [
        {
          sessionId: "s-new",
          lane: "terminal",
          openedAt: 5_000,
          closedAt: null,
          closeReason: null,
          taintedAt: null,
          actionsUsed: 0,
          open: true,
        },
        {
          sessionId: "s-old",
          lane: "browser",
          openedAt: 1_000,
          closedAt: 2_000,
          closeReason: "owner_closed",
          taintedAt: 1_500,
          actionsUsed: 3,
          open: false,
        },
      ],
    };
    expect(await hit("computer.sessionStatus", {}, ctx)).toEqual(expected);
    expect(await hit("computer.sessionStatus", { sessionId: "" }, ctx)).toEqual(expected);
  });
});
