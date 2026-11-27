// The connector.writes* handler wiring (source pins), moved out of `connector-rpc-model-writes.test.ts`
// unchanged, since that file's size is locked by `audit:file-size`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("wiring", () => {
  test("the executor the connector dispatcher builds is gate-only: NULL_EGRESS_SINK, stub dispatcher", () => {
    const src = readFileSync(join(import.meta.dir, "server/dispatchers/platform-rpcs.ts"), "utf8");
    const at = src.indexOf("export async function tryDispatchConnectorRpc(");
    const body = src.slice(at, src.indexOf("export async function tryDispatchDiagnosticsRpc(", at));
    expect(body).toContain("NULL_EGRESS_SINK");
    expect(body).toContain("stubDispatcher");
    expect(body).toContain("getEnforcedPolicy");
  });

  test("the handler calls gate(), never execute()", () => {
    const src = readFileSync(
      join(import.meta.dir, "connector-rpc-handlers", "model-writes.ts"),
      "utf8",
    );
    expect(src).toContain(".gate(");
    expect(src).not.toMatch(/\.execute\(/);
  });
});
