// E2E over a REAL gateway socket for the extension credential methods (Readwise unbundling pilot,
// PR 2). The handlers live in `ipc/automation-rpc.ts`; a real client reaches them only through
// `ipc/server/dispatchers.ts`'s `tryDispatchAutomationRpc` prefix match, which also supplies the Vault
// and — for `credentialSet` only — the owner gate. A unit test calling `dispatchAutomationRpc`
// directly bypasses all of that. "Extension not found" (-32602) proves the request reached the
// handler with its Vault (and, for set, its gate): "Method not found" (-32601) or the handler's
// "requires the owner's HITL gate" / "requires the Vault" (-32603) would each mean a wiring gap.
import { describe, expect, test } from "bun:test";

import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("extension credentials over a real socket", () => {
  test(
    "credentialStatus and credentialSet reach their handler through both dispatcher layers",
    async () => {
      const gw = await startRealGateway("extcred");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const status = await client.raw("extension.credentialStatus", { id: "e2e.not.installed" });
        expect(status.error?.code).toBe(-32602);
        expect(status.error?.message).toBe("Extension not found");

        const set = await client.raw("extension.credentialSet", {
          id: "e2e.not.installed",
          name: "token",
          value: "e2e-secret-never-echoed",
        });
        expect(set.error?.code).toBe(-32602);
        expect(set.error?.message).toBe("Extension not found");
        expect(JSON.stringify(set)).not.toContain("e2e-secret-never-echoed");
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
