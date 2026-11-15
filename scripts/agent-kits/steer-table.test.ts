// The agent kits steer a shell command to a door action type. This test holds every such type to
// a REAL connector write row that the door can offer: a kit must never tell an agent to propose
// something Nimbus refuses. It lives under scripts/ because it reads both packages; neither
// package imports the other.
import { describe, expect, test } from "bun:test";

import { OWNER_COMMANDS, STEER_ROWS } from "../../packages/cli/src/agent-kits/steer-table.ts";
import { COMMAND_NAMES } from "../../packages/cli/src/commands/registry.ts";
import { CONNECTOR_WRITE_ROWS } from "../../packages/gateway/src/connectors/connector-writes/index.ts";
import {
  isModelOfferableRow,
  MODEL_NEVER_OFFERED_TOOL_IDS,
} from "../../packages/gateway/src/connectors/connector-writes/model-offerable.ts";

describe("the agent kits' steer table against the connector write table", () => {
  test.each(STEER_ROWS.map((r) => [r.argv.join(" "), r.actionType]))(
    "%s -> %s is a write row the door can offer",
    (_command, actionType) => {
      const rows = CONNECTOR_WRITE_ROWS.filter((r) => r.actionType === actionType);
      expect(rows.length).toBeGreaterThan(0);
      const offerable = rows.filter(isModelOfferableRow);
      expect(offerable.length).toBeGreaterThan(0);
      for (const row of offerable) expect(MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)).toBe(false);
    },
  );

  test("no action type is steered to twice, and every steered command is at least two words", () => {
    const types = STEER_ROWS.map((r) => r.actionType);
    expect(new Set(types).size).toBe(types.length);
    for (const row of STEER_ROWS) expect(row.argv.length).toBeGreaterThanOrEqual(2);
  });

  test("the owner commands are real nimbus commands", () => {
    for (const command of OWNER_COMMANDS) {
      expect(command[0]).toBe("nimbus");
      expect((COMMAND_NAMES as readonly string[]).includes(command[1] ?? "")).toBe(true);
    }
    expect(OWNER_COMMANDS.map((c) => c.join(" "))).toEqual([
      "nimbus approvals",
      "nimbus connector writes",
      "nimbus captures",
    ]);
  });
});
