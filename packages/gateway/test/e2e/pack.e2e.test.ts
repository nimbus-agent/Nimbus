// E2E over a REAL gateway socket for `pack.*` (role packs P3 PR 2).
//
// Proves the namespace is routed through the outer dispatcher (not just handled by the
// sub-dispatcher a unit test calls directly) and that the pack store reached the IPC options. The
// approval path is covered in-process (`ipc/server/dispatchers-pack.test.ts`).
import { describe, expect, test } from "bun:test";
import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("pack.* over a real socket", () => {
  test(
    "pack.list, pack.remove and a refused pack.install route over the real socket",
    async () => {
      const gw = await startRealGateway("pack-rpc");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const list = await client.call<{
          profile: string;
          installed: unknown[];
          available: { id: string }[];
        }>("pack.list", null);
        expect(list.available.map((p) => p.id).sort()).toEqual(["devops", "pm"]);
        expect(list.installed).toEqual([]);

        const removed = await client.call<{ removed: boolean }>("pack.remove", { id: "pm" });
        expect(removed.removed).toBe(false);

        const refused = await client.raw("pack.install", { id: "nope" });
        expect(refused.error?.code).toBe(-32000);
        expect(refused.error?.message).toBe(
          'ERR_PACK_NOT_FOUND: no bundled pack "nope"; a local-file pack is installed with --file',
        );
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
