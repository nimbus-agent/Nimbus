// E2E over a REAL gateway socket for `catalog.list` (role packs P1 PR 5).
//
// Proves the method is routed through the outer dispatcher (not just handled by a sub-dispatcher a
// unit test calls directly) and that hiding an agent is presentation only: the agent still answers.
import { describe, expect, test } from "bun:test";
import {
  startRealGateway,
  TEST_TIMEOUT_MS,
  TinyIpcClient,
} from "./_fixtures/real-gateway-client.ts";

describe("catalog.list over a real socket", () => {
  test(
    "catalog.list routes over the real socket and reports decisions hidden",
    async () => {
      const gw = await startRealGateway("catalog-list", {
        configFiles: { "nimbus.toml": '[agents]\nhide = ["decisions"]\n' },
      });
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const r = await client.call<{
          agents: { name: string; visible: boolean }[];
          connectors: unknown[];
          visibility: { notes: string[] };
        }>("catalog.list", null);
        expect(r.agents.find((a) => a.name === "decisions")?.visible).toBe(false);
        expect(r.agents.find((a) => a.name === "catchup")?.visible).toBe(true);
        expect(r.connectors.length).toBeGreaterThan(0);
        expect(r.visibility.notes.length).toBeGreaterThan(0);
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a hidden agent still answers",
    async () => {
      const gw = await startRealGateway("catalog-hidden", {
        configFiles: { "nimbus.toml": '[agents]\nhide = ["decisions"]\n' },
      });
      const client = new TinyIpcClient();
      try {
        await client.connect(gw.socketPath);
        const list = await client.call<{ agents: { name: string; visible: boolean }[] }>(
          "catalog.list",
          null,
        );
        expect(list.agents.find((a) => a.name === "decisions")?.visible).toBe(false);
        const r = await client.call<{ sessionId: string }>("agents.decisions", {});
        expect(typeof r.sessionId).toBe("string");
      } finally {
        client.disconnect();
        await gw.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
