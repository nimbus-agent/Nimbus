import { describe, expect, test } from "bun:test";
import { dispatchMediaRpc } from "./media-rpc.ts";

const SUMMARY = {
  understood: 2,
  skipped: 1,
  skippedByReason: {
    over_byte_cap: 1,
    no_local_model: 0,
    no_remote_grant: 0,
    unresolvable_modality: 0,
    fetch_miss: 0,
    path_outside_roots: 0,
    transcode_failed: 0,
    transcribe_failed: 0,
  },
  lastItemId: "filesystem:/m/a.mp4",
};

describe("dispatchMediaRpc", () => {
  test("returns undefined for an unrelated method", async () => {
    expect(
      await dispatchMediaRpc("index.rebody", {}, { runPass: async () => SUMMARY }),
    ).toBeUndefined();
  });

  test("runs the pass and returns the summary", async () => {
    const out = await dispatchMediaRpc("media.understand", {}, { runPass: async () => SUMMARY });
    expect(out).toEqual(SUMMARY);
  });

  test("passes through the limit", async () => {
    let seen: unknown = null;
    await dispatchMediaRpc(
      "media.understand",
      { limit: 5 },
      {
        runPass: async (o) => {
          seen = o;
          return SUMMARY;
        },
      },
    );
    expect(seen).toMatchObject({ limit: 5 });
  });

  test("converts sinceDays to an epoch-ms floor", async () => {
    let seen: { sinceMs?: number } = {};
    await dispatchMediaRpc(
      "media.understand",
      { sinceDays: 2 },
      {
        runPass: async (o) => {
          seen = o;
          return SUMMARY;
        },
        nowMs: () => 1_000_000_000,
      },
    );
    expect(seen.sinceMs).toBe(1_000_000_000 - 2 * 86_400_000);
  });

  test("rejects a non-numeric limit rather than coercing it", async () => {
    await expect(
      dispatchMediaRpc("media.understand", { limit: "lots" }, { runPass: async () => SUMMARY }),
    ).rejects.toThrow(/limit/);
  });

  test("rejects an unknown modality", async () => {
    await expect(
      dispatchMediaRpc("media.understand", { modality: "smell" }, { runPass: async () => SUMMARY }),
    ).rejects.toThrow(/modality/);
  });
});
