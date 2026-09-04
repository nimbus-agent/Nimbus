import { describe, expect, test } from "bun:test";
import type { LocalUnderstander, MediaGateDeps } from "./media-gate.ts";
import { understandArtifact } from "./media-gate.ts";
import type { MediaCandidate } from "./media-types.ts";

const CANDIDATE: MediaCandidate = {
  itemId: "filesystem:/m/a.mp4",
  service: "filesystem",
  externalId: "/m/a.mp4",
  type: "media_av",
  title: "a.mp4",
  url: null,
  modality: "av",
  sourcePath: "/m/a.mp4",
  sourceMime: null,
  sourceBytes: 10,
};

function understander(over: Partial<LocalUnderstander> = {}): LocalUnderstander {
  return {
    isLocal: true,
    model: "whisper-base",
    isAvailable: async () => true,
    understand: async () => ({ text: "transcript text" }),
    ...over,
  };
}

function deps(over: Partial<MediaGateDeps> = {}): MediaGateDeps {
  return {
    enabled: true,
    capabilityDisabled: false,
    understanderFor: () => understander(),
    gpu: { acquire: async () => () => undefined, touch: () => undefined },
    ...over,
  };
}

describe("understandArtifact — ordered refusals", () => {
  test("refuses when the capability is disabled by config, before any model work", async () => {
    let touched = false;
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({ enabled: false }),
      understanderFor: () => {
        touched = true;
        return understander();
      },
    });
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
    expect(touched).toBe(false);
  });

  test("refuses when disabled by org policy, before any model work", async () => {
    let touched = false;
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({ capabilityDisabled: true }),
      understanderFor: () => {
        touched = true;
        return understander();
      },
    });
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
    expect(touched).toBe(false);
  });

  test("refuses an unresolvable modality rather than guessing", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({ understanderFor: () => undefined }),
    );
    expect(out).toEqual({ ok: false, reason: "unresolvable_modality" });
  });

  test("REFUSES rather than degrading when the local model is unavailable", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({ understanderFor: () => understander({ isAvailable: async () => false }) }),
    );
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
  });

  test("refuses a NON-LOCAL understander with no grant — never falls back to remote", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({ understanderFor: () => understander({ isLocal: false }) }),
    );
    expect(out).toEqual({ ok: false, reason: "no_remote_grant" });
  });

  test("succeeds locally and reports isLocal DERIVED from the provider", async () => {
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", deps());
    expect(out).toEqual({
      ok: true,
      outcome: { text: "transcript text", model: "whisper-base", isLocal: true },
    });
  });

  test("maps a thrown understander error to transcribe_failed, not a crash", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      "/m/a.mp4",
      deps({
        understanderFor: () =>
          understander({
            understand: async () => {
              throw new Error("whisper died");
            },
          }),
      }),
    );
    expect(out).toEqual({ ok: false, reason: "transcribe_failed" });
  });

  test("RELEASES the GPU lease even when the understander throws", async () => {
    let released = 0;
    await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({
        understanderFor: () =>
          understander({
            understand: async () => {
              throw new Error("boom");
            },
          }),
      }),
      gpu: {
        acquire: async () => () => {
          released += 1;
        },
        touch: () => undefined,
      },
    });
    expect(released).toBe(1);
  });

  test("RELEASES the GPU lease on the success path", async () => {
    let released = 0;
    await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps(),
      gpu: {
        acquire: async () => () => {
          released += 1;
        },
        touch: () => undefined,
      },
    });
    expect(released).toBe(1);
  });

  test("acquires the GPU lease ONCE PER CALL, not once per pass", async () => {
    let acquired = 0;
    const d: MediaGateDeps = {
      ...deps(),
      gpu: {
        acquire: async () => {
          acquired += 1;
          return () => undefined;
        },
        touch: () => undefined,
      },
    };
    await understandArtifact(CANDIDATE, "/m/a.mp4", d);
    await understandArtifact(CANDIDATE, "/m/a.mp4", d);
    expect(acquired).toBe(2);
  });

  test("does NOT acquire the GPU on any refusal before the model call", async () => {
    async function acquireCount(over: Partial<MediaGateDeps>): Promise<number> {
      let acquired = 0;
      await understandArtifact(CANDIDATE, "/m/a.mp4", {
        ...deps(over),
        gpu: {
          acquire: async () => {
            acquired += 1;
            return () => undefined;
          },
          touch: () => undefined,
        },
      });
      return acquired;
    }

    expect(await acquireCount({ enabled: false })).toBe(0);
    expect(await acquireCount({ capabilityDisabled: true })).toBe(0);
    expect(await acquireCount({ understanderFor: () => undefined })).toBe(0);
    expect(await acquireCount({ understanderFor: () => understander({ isLocal: false }) })).toBe(0);
    expect(
      await acquireCount({
        understanderFor: () => understander({ isAvailable: async () => false }),
      }),
    ).toBe(0);
  });

  /**
   * A multi-minute transcription must keep the arbiter's idle timer fresh. Without the heartbeat an
   * interactive `nimbus ask` evicts the lease AND wipes the arbiter's waiter queue.
   */
  test("heartbeats touch() while a slow understander runs", async () => {
    let touches = 0;
    const out = await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps({
        understanderFor: () =>
          understander({
            understand: async () => {
              await Bun.sleep(60);
              return { text: "slow transcript" };
            },
          }),
      }),
      heartbeatMs: 10,
      gpu: {
        acquire: async () => () => undefined,
        touch: () => {
          touches += 1;
        },
      },
    });
    expect(out.ok).toBe(true);
    expect(touches).toBeGreaterThan(0);
  }, 10_000);

  test("stops heartbeating once the call returns — a live interval hangs the suite", async () => {
    let touches = 0;
    await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps(),
      heartbeatMs: 10,
      gpu: {
        acquire: async () => () => undefined,
        touch: () => {
          touches += 1;
        },
      },
    });
    const after = touches;
    await Bun.sleep(60);
    expect(touches).toBe(after);
  });

  test("understandArtifact carries frame counts from the understander onto the outcome", async () => {
    const res = await understandArtifact(CANDIDATE, "/m/a.mp4", {
      ...deps(),
      understanderFor: () => ({
        isLocal: true,
        model: "m",
        isAvailable: () => Promise.resolve(true),
        understand: () => Promise.resolve({ text: "t", framesSampled: 8, framesCaptioned: 6 }),
      }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.outcome.framesSampled).toBe(8);
      expect(res.outcome.framesCaptioned).toBe(6);
    }
  });

  test("an understander reporting no counts leaves them absent, not zero", async () => {
    const res = await understandArtifact(CANDIDATE, "/m/a.png", {
      ...deps(),
      understanderFor: () => ({
        isLocal: true,
        model: "m",
        isAvailable: () => Promise.resolve(true),
        understand: () => Promise.resolve({ text: "t" }),
      }),
    });
    if (res.ok) expect("framesSampled" in res.outcome).toBe(false);
  });
});
