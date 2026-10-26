// E2E over a REAL gateway socket for `trust.status` / `trust.refresh` (trust layer PR 2a). The
// handlers live in `ipc/trust-rpc.ts`; a real client reaches them only through `tryDispatchTrustRpc`
// wired into `dispatchMethod`, which a unit test of `dispatchTrustRpc` bypasses. This build bakes
// no trust feed, so both methods answer "not configured" — and nothing is fetched.
import { describe, expect, test } from "bun:test";

import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("trust.* over a real socket", () => {
  test(
    "status and refresh reach their handler through both dispatcher layers",
    async () => {
      const gw = await startRealGateway("trust");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);

        const status = await client.raw("trust.status", {});
        expect(status.error).toBeUndefined();
        expect(status.result).toMatchObject({
          configured: false,
          url: null,
          sequence: null,
          intervalHours: 1,
          counts: { revocations: 0, takedowns: 0, rotations: 0, verifiedPublishers: 0 },
        });

        const refresh = await client.raw("trust.refresh", {});
        expect(refresh.error).toBeUndefined();
        expect(refresh.result).toEqual({ status: "not_configured" });

        const unknown = await client.raw("trust.nope", {});
        expect(unknown.error?.code).toBe(-32601);
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
