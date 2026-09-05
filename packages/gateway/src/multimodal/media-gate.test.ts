import { describe, expect, test } from "bun:test";
import type { MediaGateDeps, Understander } from "./media-gate.ts";
import { understandArtifact } from "./media-gate.ts";
import type { MediaCandidate, MediaSource } from "./media-types.ts";
import { UnsupportedImageFormatError } from "./media-types.ts";

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

const IMAGE_CANDIDATE: MediaCandidate = {
  itemId: "onedrive:img-1",
  service: "onedrive",
  externalId: "img-1",
  type: "media_image",
  title: "a.png",
  url: null,
  modality: "image",
  sourcePath: null,
  sourceMime: "image/png",
  sourceBytes: 10,
};

const PATH_SOURCE: MediaSource = { kind: "path", path: "/m/a.mp4" };
const IMAGE_SOURCE: MediaSource = { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" };

function understander(over: Partial<Understander> = {}): Understander {
  return {
    isLocal: true,
    model: "whisper-base",
    isAvailable: async () => true,
    understand: async () => ({ text: "transcript text" }),
    ...over,
  };
}

function gateDeps(over: Partial<MediaGateDeps> = {}): MediaGateDeps {
  return {
    enabled: true,
    capabilityDisabled: false,
    understanderFor: () => understander(),
    gpu: { acquire: async () => () => undefined, touch: () => undefined },
    ...over,
  };
}

function imageCandidate(over: Partial<MediaCandidate> = {}): MediaCandidate {
  return { ...IMAGE_CANDIDATE, ...over };
}

function imageSource(): MediaSource {
  return IMAGE_SOURCE;
}

describe("understandArtifact — ordered refusals", () => {
  test("refuses when the capability is disabled by config, before any model work", async () => {
    let touched = false;
    const out = await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps({ enabled: false }),
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
    const out = await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps({ capabilityDisabled: true }),
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
      PATH_SOURCE,
      gateDeps({ understanderFor: () => undefined }),
    );
    expect(out).toEqual({ ok: false, reason: "unresolvable_modality" });
  });

  test("REFUSES rather than degrading when the local model is unavailable", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      PATH_SOURCE,
      gateDeps({ understanderFor: () => understander({ isAvailable: async () => false }) }),
    );
    expect(out).toEqual({ ok: false, reason: "no_local_model" });
  });

  test("refuses a NON-LOCAL understander with no grant — never falls back to remote", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      PATH_SOURCE,
      gateDeps({ understanderFor: () => understander({ isLocal: false }) }),
    );
    expect(out).toEqual({ ok: false, reason: "no_remote_grant" });
  });

  test("succeeds locally and reports isLocal DERIVED from the provider", async () => {
    const out = await understandArtifact(CANDIDATE, PATH_SOURCE, gateDeps());
    expect(out).toEqual({
      ok: true,
      outcome: { text: "transcript text", model: "whisper-base", isLocal: true },
    });
  });

  test("maps a thrown understander error to transcribe_failed, not a crash", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      PATH_SOURCE,
      gateDeps({
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

  test("an image understander that throws records describe_failed, not transcribe_failed", async () => {
    const out = await understandArtifact(
      IMAGE_CANDIDATE,
      IMAGE_SOURCE,
      gateDeps({
        understanderFor: () =>
          understander({
            understand: async () => {
              throw new Error("model exploded");
            },
          }),
      }),
    );
    expect(out).toEqual({ ok: false, reason: "describe_failed" });
  });

  test("an AV understander that throws still records transcribe_failed", async () => {
    const out = await understandArtifact(
      CANDIDATE,
      PATH_SOURCE,
      gateDeps({
        understanderFor: () =>
          understander({
            understand: async () => {
              throw new Error("whisper exploded");
            },
          }),
      }),
    );
    expect(out).toEqual({ ok: false, reason: "transcribe_failed" });
  });

  test("an UnsupportedImageFormatError wins over the modality branch — unsupported_image_format, not describe_failed", async () => {
    const out = await understandArtifact(
      IMAGE_CANDIDATE,
      IMAGE_SOURCE,
      gateDeps({
        understanderFor: () =>
          understander({
            understand: async () => {
              throw new UnsupportedImageFormatError("not a recognised wire format");
            },
          }),
      }),
    );
    expect(out).toEqual({ ok: false, reason: "unsupported_image_format" });
  });

  test("RELEASES the GPU lease even when the understander throws", async () => {
    let released = 0;
    await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps({
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
    await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps(),
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
      ...gateDeps(),
      gpu: {
        acquire: async () => {
          acquired += 1;
          return () => undefined;
        },
        touch: () => undefined,
      },
    };
    await understandArtifact(CANDIDATE, PATH_SOURCE, d);
    await understandArtifact(CANDIDATE, PATH_SOURCE, d);
    expect(acquired).toBe(2);
  });

  test("does NOT acquire the GPU on any refusal before the model call", async () => {
    async function acquireCount(over: Partial<MediaGateDeps>): Promise<number> {
      let acquired = 0;
      await understandArtifact(CANDIDATE, PATH_SOURCE, {
        ...gateDeps(over),
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
    const out = await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps({
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
    await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps(),
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
    const res = await understandArtifact(CANDIDATE, PATH_SOURCE, {
      ...gateDeps(),
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
    const res = await understandArtifact(
      CANDIDATE,
      { kind: "path", path: "/m/a.png" },
      {
        ...gateDeps(),
        understanderFor: () => ({
          isLocal: true,
          model: "m",
          isAvailable: () => Promise.resolve(true),
          understand: () => Promise.resolve({ text: "t" }),
        }),
      },
    );
    if (res.ok) expect("framesSampled" in res.outcome).toBe(false);
  });

  test("the gate passes a bytes source straight through to the understander", async () => {
    let received: MediaSource | undefined;
    const deps = gateDeps({
      understanderFor: () => ({
        isLocal: true,
        model: "fake",
        isAvailable: async () => true,
        understand: async (s: MediaSource) => {
          received = s;
          return { text: "ok" };
        },
      }),
    });
    const src: MediaSource = { kind: "bytes", bytes: new Uint8Array([1, 2]), mime: "image/png" };
    const r = await understandArtifact(IMAGE_CANDIDATE, src, deps);
    expect(r.ok).toBe(true);
    expect(received).toEqual(src);
  });

  /**
   * Regression guard: the union must not reorder the gate's steps. Step 3 (non-local refused)
   * still precedes step 4 (availability) and step 5 (model contact) — if the shape change moved
   * the refusal after either of those, `touched` would flip to `true`.
   */
  test("a non-local provider is still refused BEFORE the source is touched", async () => {
    let touched = false;
    const deps = gateDeps({
      understanderFor: () => ({
        isLocal: false,
        model: "remote",
        isAvailable: async () => {
          touched = true;
          return true;
        },
        understand: async () => ({ text: "" }),
      }),
    });
    const r = await understandArtifact(IMAGE_CANDIDATE, { kind: "path", path: "/x" }, deps);
    expect(r).toEqual({ ok: false, reason: "no_remote_grant" });
    expect(touched).toBe(false);
  });

  test("resolves the understander PER CANDIDATE, not once per modality", async () => {
    const seen: string[] = [];
    const deps = gateDeps({
      understanderFor: (_m, candidate) => {
        seen.push(candidate.itemId);
        return {
          isLocal: true,
          model: "m",
          isAvailable: async () => true,
          understand: async () => ({ text: "ok" }),
        };
      },
    });
    await understandArtifact(imageCandidate({ itemId: "a" }), imageSource(), deps);
    await understandArtifact(imageCandidate({ itemId: "b" }), imageSource(), deps);
    // Two different artifacts of the SAME modality must each get their own resolution — that is what
    // lets one be granted remote and the other not.
    expect(seen).toEqual(["a", "b"]);
  });
});
