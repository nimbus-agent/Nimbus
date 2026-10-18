// E2E over a REAL gateway socket for the `registry.*` client methods. The handlers live in
// `ipc/registry-rpc.ts`; a real client reaches them only through `tryDispatchRegistryRpc` wired
// into `dispatchMethod`. A unit test calling `dispatchRegistryRpc` directly bypasses that routing.
// A handler error (never -32601 "Method not found") proves the request reached the handler.
import { describe, expect, test } from "bun:test";

import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("registry.* over a real socket", () => {
  test(
    "all six methods reach their handler through both dispatcher layers",
    async () => {
      const gw = await startRealGateway("registry");
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);

        const refresh = await client.raw("registry.refresh", { name: "nope" });
        expect(refresh.error?.code).toBe(-32000);
        expect(refresh.error?.message).toContain("ERR_REGISTRY_NOT_FOUND");

        // Validation runs before the gate, the fetch and any prompt, so this needs no consent.
        const add = await client.raw("registry.add", { name: "Not Valid", url: "/x" });
        expect(add.error?.code).toBe(-32602);
        expect(add.error?.message).toContain("ERR_INVALID_PARAMS");

        const list = await client.raw("registry.list", {});
        expect(list.error).toBeUndefined();
        expect(list.result).toEqual({ registries: [] });

        // Search over zero registries is an empty answer, not an error.
        const search = await client.raw("registry.search", { query: "x" });
        expect(search.error).toBeUndefined();
        expect(search.result).toEqual({ results: [], errors: [] });

        const info = await client.raw("registry.info", { id: "a.b", registry: "nope" });
        expect(info.error?.code).toBe(-32000);
        expect(info.error?.message).toContain("ERR_REGISTRY_NOT_FOUND");

        const remove = await client.raw("registry.remove", { name: "nope" });
        expect(remove.error).toBeUndefined();
        expect(remove.result).toEqual({ removed: false, orphanedExtensions: [] });
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
