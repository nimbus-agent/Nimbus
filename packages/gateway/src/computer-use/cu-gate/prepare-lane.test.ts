import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { type CuGateDeps, openSession } from "../cu-gate.ts";
import type { CuTerminalLaunchPolicy, OpenTerminalLaneOptions, TerminalLane } from "../cu-types.ts";

function terminalDeps(seen: { asserted: unknown; launched: unknown }): CuGateDeps {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  const lane: TerminalLane = {
    write: async () => ({ output: "", settled: "quiet" as const, truncated: false }),
    isAlive: () => true,
    close: async () => {},
  };
  const browserRefused = (): never => {
    throw new Error("the browser seams are not used by a terminal session");
  };
  return {
    config: {
      ...DEFAULT_NIMBUS_COMPUTER_USE_TOML,
      enabled: true,
      allowedLanes: ["terminal"],
    },
    enforced: { capabilitiesDisabled: new Set<string>() },
    requestApproval: async () => true,
    lanes: {
      browser: {
        resolveBrowserPath: browserRefused,
        buildLaunchPolicy: browserRefused,
        assertLaunchable: browserRefused,
        openLane: browserRefused,
      },
      terminal: {
        defaultShellId: "sh",
        resolveShellPath: () => ({
          status: "ok",
          shellPath: "/fake/sh",
          argv: ["-s"],
          envOverlay: {},
        }),
        buildLaunchPolicy: ({ sessionId, shellId, shellPath, cwd }): CuTerminalLaunchPolicy => ({
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
        assertLaunchable: (p) => {
          seen.asserted = p;
          return null;
        },
        openLane: async (opts: OpenTerminalLaneOptions) => {
          seen.launched = opts.launch;
          return lane;
        },
      },
    },
    db,
    now: () => 1000,
    newId: () => "id-1",
  };
}

describe("terminal lane — the launch policy", () => {
  test("the policy asserted before consent is the SAME OBJECT handed to openLane", async () => {
    // I35 re-verify item 2, terminal arm. A rebuilt-but-equal policy would let the object that was
    // cleared and the object that launches drift apart the moment either construction site changed.
    const seen: { asserted: unknown; launched: unknown } = { asserted: null, launched: null };
    const out = await openSession({ lane: "terminal", cwd: "/tmp/work" }, terminalDeps(seen));
    expect(out.status).toBe("open");
    expect(seen.asserted).not.toBeNull();
    expect(seen.launched).toBe(seen.asserted as never);
  });
});
