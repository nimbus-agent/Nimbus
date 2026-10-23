// E2E over a REAL gateway socket for `config.explain` (role packs P1 PR 1).
//
// The one layer that proves `config.explain` is reachable through `tryDispatchDiagnosticsRpc`'s
// outer `config.` routing, and that a gateway booted with NIMBUS_PROFILE=work pins that profile and
// serves the profile overlay's value rather than the base file's.
import { describe, expect, test } from "bun:test";
import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("config.explain over a real socket", () => {
  test(
    "serves the profile layer's value for the pinned profile",
    async () => {
      const gw = await startRealGateway("config-explain", {
        configFiles: {
          "nimbus.toml": "[decisions]\nmin_confidence = 0.3\n",
          "nimbus.work.toml": "[decisions]\nmin_confidence = 0.6\n",
        },
        env: { NIMBUS_PROFILE: "work" },
      });
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const r = await client.call<{
          runningProfile: string;
          entries: { value: string }[];
        }>("config.explain", { path: "decisions.min_confidence" });
        expect(r.entries[0]?.value).toBe("0.6");
        expect(r.runningProfile).toBe("work");
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
