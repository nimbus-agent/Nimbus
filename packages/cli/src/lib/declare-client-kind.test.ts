import { describe, expect, test } from "bun:test";

import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { declareCliClientKind } from "./declare-client-kind.ts";

describe("declareCliClientKind", () => {
  test("sends session.declareKind with kind cli", async () => {
    const ipc = createMockIpcClient([{ kind: "cli" }]);
    await declareCliClientKind(ipc.client);
    expect(ipc.calls).toEqual([{ method: "session.declareKind", params: { kind: "cli" } }]);
  });

  test("a failing declaration (older gateway) never throws", async () => {
    const ipc = createMockIpcClient([new Error("Method not found: session.declareKind")]);
    await expect(declareCliClientKind(ipc.client)).resolves.toBeUndefined();
    expect(ipc.calls).toHaveLength(1);
  });
});
