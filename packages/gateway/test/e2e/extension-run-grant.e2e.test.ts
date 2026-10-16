// E2E over a REAL gateway socket for the extension run-grant methods (extension-runtime PR 2).
// The handlers live in `ipc/automation-rpc.ts`; a real client reaches them only through
// `ipc/server/dispatchers.ts`'s `tryDispatchAutomationRpc` prefix match AND the owner gate +
// run-grant env that `dispatchExtensionAutomationRpc` builds. A unit test calling
// `dispatchAutomationRpc` directly bypasses all three. "Extension not found" (-32602) proves the
// request reached the handler with BOTH a gate and an env; "Method not found" (-32601) or the
// handler's "not configured" (-32603) would each mean a wiring gap.
import { describe, expect, test } from "bun:test";

import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("extension run grants over a real socket", () => {
  test(
    "approveRun and revokeRun reach their handler through both dispatcher layers",
    async () => {
      const gw = await startRealGateway("extrun");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        for (const method of ["extension.approveRun", "extension.revokeRun"]) {
          const reply = await client.raw(method, { id: "e2e.not.installed" });
          expect(reply.error?.code, method).toBe(-32602);
          expect(reply.error?.message, method).toBe("Extension not found");
        }
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
