import { describe, expect, test } from "bun:test";
import { runSyncThroughputDriveOnce } from "./bench-sync-throughput-drive.ts";
import { fakeSpawnEmitsMarker } from "./spawn-test-helpers.ts";

describe("runSyncThroughputDriveOnce", () => {
  test("returns positive items/sec for each of 5 runs", async () => {
    let queryCount = 0;
    const samples = await runSyncThroughputDriveOnce(
      { runs: 1, runner: "local-dev", corpus: "small" },
      {
        spawn: fakeSpawnEmitsMarker({
          pid: 6262,
          stdoutChunks: ["[gateway] ready\n"],
        }),
        ipcCall: async (method, _params) => {
          if (method === "index.querySql") {
            queryCount += 1;
            return [{ c: queryCount % 2 === 1 ? 0 : 50 }];
          }
          if (method === "connector.sync") {
            await new Promise((r) => setTimeout(r, 50));
            return { ok: true };
          }
          return undefined;
        },
      },
    );
    expect(samples).toHaveLength(5);
    for (const s of samples) {
      expect(s).toBeGreaterThan(0);
    }
  });
});
