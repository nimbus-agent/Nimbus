import { describe, expect, test } from "bun:test";
import { runRssHeavySyncOnce } from "./bench-rss-heavy-sync.ts";
import { fakeSpawnEmitsMarker } from "./spawn-test-helpers.ts";

describe("runRssHeavySyncOnce", () => {
  test("triggers sync for drive/gmail/github in parallel; returns RSS samples", async () => {
    const synced: string[] = [];
    const fullFlags: unknown[] = [];
    const samples = await runRssHeavySyncOnce(
      { runs: 1, runner: "local-dev" },
      {
        spawn: fakeSpawnEmitsMarker({
          pid: 5252,
          stdoutChunks: ["[gateway] ready\n"],
        }),
        durationMs: 100,
        intervalMs: 20,
        pidusage: async () => ({ memory: 200_000_000 }),
        ipcCall: async (method, params) => {
          if (method === "connector.sync") {
            synced.push((params as { service: string }).service);
            fullFlags.push((params as { full?: unknown }).full);
            await new Promise((r) => setTimeout(r, 30));
            return { ok: true };
          }
          return undefined;
        },
      },
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(synced.toSorted((a, b) => a.localeCompare(b))).toEqual(["drive", "github", "gmail"]);
    // "Heavy" sync means a FULL sync of each service, not an incremental one.
    expect(fullFlags).toEqual([true, true, true]);
  });
});
