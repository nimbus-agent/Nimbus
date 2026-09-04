// packages/gateway/src/multimodal/build-media-pass-deps.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { GpuArbiter } from "../llm/gpu-arbiter.ts";
import {
  buildMediaPassDeps,
  resolveMediaRoots,
  withTranscribeTimeout,
} from "./build-media-pass-deps.ts";
import { loadMultimodalConfig } from "./multimodal-config.ts";

/**
 * Run `body` against a fresh, isolated config directory and always remove it afterwards.
 *
 * `mkdtempSync` rather than a fixed path: these tests run in parallel with the rest of the file
 * and a shared directory name would let one case observe another's `nimbus.toml`.
 */
function withTempConfigDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-cfg-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function db(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

describe("buildMediaPassDeps", () => {
  test("passes the configured roots through", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: ["/a", "/b"],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.roots).toEqual(["/a", "/b"]);
  });

  test("understanderFor resolves BOTH modalities now that a VLM exists", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.gate.understanderFor("av")).toBeDefined();
    expect(deps.gate.understanderFor("image")).toBeDefined();
  });

  test("the image understander is the LEDGERED provider, not a bare one", () => {
    // A loopback default makes the wrapper an identity, so this asserts the WIRING is present
    // rather than the row: D22(g) is what proves the wrap cannot be dropped.
    //
    // Resolved relative to THIS FILE, never to the process working directory: CI's coverage job
    // `cd`s into `packages/gateway` before running `bun test`, where a CWD-relative
    // `"packages/gateway/src/..."` throws ENOENT. Same reasoning as `llm/local-definition.test.ts`.
    const src = readFileSync(join(import.meta.dir, "build-media-pass-deps.ts"), "utf8");
    const wrapAt = src.indexOf("wrapLedgeredVlm(");
    const ctorAt = src.indexOf("createOllamaVlm(");
    expect(wrapAt).toBeGreaterThan(-1);
    // The constructor call is textually INSIDE the wrapper's argument list.
    expect(ctorAt).toBeGreaterThan(wrapAt);
  });

  test("the AV understander declares itself LOCAL", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.gate.understanderFor("av")?.isLocal).toBe(true);
  });

  test("propagates the disabled flags into the gate, so the gate refuses", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: false,
      capabilityDisabled: true,
      scratchDir: "/scratch",
    });
    expect(deps.gate.enabled).toBe(false);
    expect(deps.gate.capabilityDisabled).toBe(true);
  });

  test("wires a REAL touch() — without it a long transcription is evicted mid-run", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(typeof deps.gate.gpu.touch).toBe("function");
  });

  test("passes the scratch directory through, so the start-of-pass sweep runs", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.scratchDir).toBe("/scratch");
  });
});

describe("buildMediaPassDeps — cloud arm wiring (PR 3)", () => {
  test("the constructed deps fetch through safeFetchFollowing, not bare fetch", async () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    // A loopback URL must be REFUSED by the wiring itself. Bare `fetch` would happily return —
    // this is what proves `cloudBytes.fetchFn` is actually `safeFetchFollowing` and not a stub
    // that merely has the right shape. Exercises BOTH consumers' shared field, since
    // `cloud-url-resolver.ts`'s `CloudUrlResolverDeps.fetchFn` and `cloud-bytes.ts`'s
    // `CloudBytesDeps.fetchFn` are the same function reference in the returned deps object.
    await expect(deps.cloudBytes.fetchFn("http://127.0.0.1:9/x", {})).rejects.toThrow(
      /loopback\/private/,
    );
  });

  test("cloudBytes.bearerFor fails CLOSED (null) when no vault is supplied", async () => {
    // No `media.understand` dispatcher forwards a vault into this input yet — a disclosed gap
    // (see BuildMediaPassDepsInput.vault's doc comment), not a silent one. Every bearer-requiring
    // service must skip as not_configured rather than throw or fabricate a credential.
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    await expect(deps.cloudBytes.bearerFor("google_drive")).resolves.toBeNull();
    await expect(deps.cloudBytes.bearerFor("google_photos")).resolves.toBeNull();
    await expect(deps.cloudBytes.bearerFor("onedrive")).resolves.toBeNull();
    await expect(deps.cloudBytes.bearerFor("some_other_service")).resolves.toBeNull();
  });

  test("cloudBytes.appendEgress ledgers a REAL sync-class row via recordSyncEgress, not a stub", () => {
    const database = db();
    const deps = buildMediaPassDeps({
      db: database,
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    const out = deps.cloudBytes.appendEgress({
      destination: "google_drive",
      method: "media.fetchBytes",
    });
    expect(out?.rowHash).toBeDefined();
    const n = database.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger").get()?.n;
    expect(n).toBe(1);
  });

  test("cloudBytes.appendEgress is a no-op for a LOCAL_ONLY_SYNC_SERVICES destination, matching recordSyncEgress", () => {
    const database = db();
    const deps = buildMediaPassDeps({
      db: database,
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    const out = deps.cloudBytes.appendEgress({
      destination: "filesystem",
      method: "media.fetchBytes",
    });
    expect(out).toBeUndefined();
    const n = database.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger").get()?.n;
    expect(n).toBe(0);
  });

  test("defaults fetchBudgetBytes and preferRenditions when not supplied", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.fetchBudgetBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(deps.preferRenditions).toBe(false);
  });

  test("honors explicit fetchBudgetBytes and preferRenditions overrides", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      fetchBudgetBytes: 123,
      preferRenditions: true,
    });
    expect(deps.fetchBudgetBytes).toBe(123);
    expect(deps.preferRenditions).toBe(true);
  });
});

describe("buildMediaPassDeps — optional overrides", () => {
  test("defaults maxBytes to 250 MB when not supplied", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
    });
    expect(deps.maxBytes).toBe(250 * 1024 * 1024);
  });

  test("honors an explicit maxBytes override", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      maxBytes: 1024,
    });
    expect(deps.maxBytes).toBe(1024);
  });

  test("uses an injected GpuArbiter rather than constructing its own", async () => {
    const shared = new GpuArbiter();
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      gpu: shared,
    });
    expect(deps.gate.gpu).toBeDefined();
    // Acquiring through the deps-exposed handle reaches the SAME arbiter instance we injected —
    // proven by observing the grant on `shared` directly rather than merely on the deps object.
    const release = await deps.gate.gpu.acquire("probe");
    expect(shared.currentProvider).toBe("probe");
    release();
    expect(shared.currentProvider).toBeNull();
  });

  test("passes an explicit whisperBin through to the STT provider construction", () => {
    // No assertion on internal wiring is possible without a real whisper binary; this exercises
    // the `input.whisperBin === undefined ? {} : {...}` branch so the defined-value arm is covered
    // and confirms construction does not throw when a custom binary path is supplied.
    expect(() =>
      buildMediaPassDeps({
        db: db(),
        roots: [],
        enabled: true,
        capabilityDisabled: false,
        scratchDir: "/scratch",
        whisperBin: "/usr/local/bin/whisper-cli",
      }),
    ).not.toThrow();
  });
});

describe("buildMediaPassDeps — the input->provider hop (second-hop wiring)", () => {
  // A prior round pinned the DISPATCHER->INPUT hop by value. Nothing pinned INPUT->PROVIDER: a
  // refactor that quietly dropped `input.vlmBaseUrl ?? DEFAULT_VLM_BASE_URL` /
  // `input.vlmModel ?? DEFAULT_VLM_MODEL` / `input.maxFrames ?? DEFAULT_MAX_FRAMES` in favor of the
  // bare defaults left the FULL suite green — a user's `vlm_model = "llava:13b"` would be parsed,
  // validated, clamped, and then silently ignored. Each assertion below is RED-PROVEN by reverting
  // its `input.X ??` read to the bare default one at a time (see the fix report for the exact
  // observations); this is not merely a green assertion that happens to pass either way.
  test("input.vlmModel reaches the constructed VLM, observed via the AV understander's composite model id", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      vlmModel: "custom-vision:9b",
    });
    // `av-understander.ts`'s `model` field is `${stt.model}+${vlm.model}` — "whisper-cli" is the
    // STT leg's fixed model id, so a non-default suffix here can only have come from `input.vlmModel`.
    expect(deps.gate.understanderFor("av")?.model).toBe("whisper-cli+custom-vision:9b");
  });

  test("input.vlmBaseUrl reaches the constructed VLM, observed via non-loopback flipping isLocal false", () => {
    const deps = buildMediaPassDeps({
      db: db(),
      roots: [],
      enabled: true,
      capabilityDisabled: false,
      scratchDir: "/scratch",
      vlmBaseUrl: "http://gpu-box.lan:11434",
    });
    // `isLocal` is DERIVED (I34) from the provider's resolved base URL via `isLoopbackBaseUrl`, so
    // a non-loopback `input.vlmBaseUrl` can only surface here if it actually reached
    // `createOllamaVlm`'s `baseUrl` option. Checked on both understanders: the image understander
    // mirrors the VLM's `isLocal` directly, and the AV understander ANDs it with the STT leg's (see
    // `av-understander.ts`), so a dropped `input.vlmBaseUrl` read would leave BOTH `true`.
    expect(deps.gate.understanderFor("image")?.isLocal).toBe(false);
    expect(deps.gate.understanderFor("av")?.isLocal).toBe(false);
  });

  // `input.maxFrames` has NO observable assertion at this seam without adding new production
  // surface. `AvUnderstanderDeps.maxFrames` is consumed only inside `av-understander.ts`'s private
  // `understand()` closure (`frameTimestamps(duration, deps.maxFrames)`) — it is never exposed on
  // the constructed `LocalUnderstander`, and `buildMediaPassDeps` wires the AV understander to the
  // REAL `probeDurationSeconds`/`extractFrameJpeg` (no injection hooks), so exercising `understand()`
  // here would need a real ffprobe/ffmpeg and a real video file, which is exactly the kind of
  // production-surface widening this fix is not meant to introduce. `av-understander.test.ts`
  // already pins that `createAvUnderstander` itself honors `deps.maxFrames`; what is NOT pinned
  // anywhere is that `buildMediaPassDeps` forwards `input.maxFrames` into that `deps.maxFrames`
  // rather than silently using `DEFAULT_MAX_FRAMES`. Stated here rather than covered with an
  // assertion that cannot actually fail.
});

describe("withTranscribeTimeout", () => {
  test("forwards the result when transcribe settles before the bound", async () => {
    const bounded = withTranscribeTimeout(async (wavPath) => ({ text: `heard:${wavPath}` }), 5000);
    await expect(bounded("/scratch/a.wav")).resolves.toEqual({ text: "heard:/scratch/a.wav" });
  });

  test("rejects with a clear error when transcribe never settles — bounded in MS, not minutes", async () => {
    const neverSettles = () => new Promise<{ text: string }>(() => undefined);
    const bounded = withTranscribeTimeout(neverSettles, 20);
    await expect(bounded("/scratch/wedged.wav")).rejects.toThrow(/timed out.*20ms/);
  });

  test("propagates a real transcribe rejection unchanged, not a timeout error", async () => {
    const bounded = withTranscribeTimeout(async () => {
      throw new Error("whisper-cli exited 1");
    }, 5000);
    await expect(bounded("/scratch/bad.wav")).rejects.toThrow("whisper-cli exited 1");
  });

  test("a late resolution after expiry does not throw an unhandled rejection", async () => {
    let releaseLate: (() => void) | undefined;
    const late = () =>
      new Promise<{ text: string }>((resolve) => {
        releaseLate = () => resolve({ text: "too late" });
      });
    const bounded = withTranscribeTimeout(late, 10);
    await expect(bounded("/scratch/late.wav")).rejects.toThrow(/timed out/);
    // Settling the underlying promise after the caller already saw the timeout must be inert.
    expect(() => releaseLate?.()).not.toThrow();
  });
});

describe("buildMediaPassDeps — transcribeTimeoutMs", () => {
  test("accepts an explicit transcribeTimeoutMs override without throwing", () => {
    expect(() =>
      buildMediaPassDeps({
        db: db(),
        roots: [],
        enabled: true,
        capabilityDisabled: false,
        scratchDir: "/scratch",
        transcribeTimeoutMs: 30_000,
      }),
    ).not.toThrow();
  });
});

describe("resolveMediaRoots", () => {
  test("returns an empty array with no configDir — the test/embedded shape", () => {
    expect(resolveMediaRoots(undefined)).toEqual([]);
  });

  test("returns an empty array when nimbus.toml is absent", () => {
    withTempConfigDir((dir) => {
      expect(resolveMediaRoots(dir)).toEqual([]);
    });
  });

  test("keeps only roots with media_index = true, mapped to their path", () => {
    withTempConfigDir((dir) => {
      writeFileSync(
        join(dir, "nimbus.toml"),
        [
          "[[filesystem.roots]]",
          'path = "/media-yes"',
          "media_index = true",
          "",
          "[[filesystem.roots]]",
          'path = "/media-no"',
          "media_index = false",
        ].join("\n"),
      );
      const roots = resolveMediaRoots(dir);
      expect(roots).toEqual([resolve("/media-yes")]);
    });
  });
});

describe("loadMultimodalConfig(...).enabled", () => {
  test("reads false with no configDir — the test/embedded shape", () => {
    expect(loadMultimodalConfig(undefined).enabled).toBe(false);
  });

  test("reads false when nimbus.toml is absent", () => {
    withTempConfigDir((dir) => {
      expect(loadMultimodalConfig(dir).enabled).toBe(false);
    });
  });

  // The kill switch is DEFAULT OFF and every non-`true` shape must read as off, so the cases
  // that matter are a table of (config text -> verdict) rather than eight copies of one fixture.
  // Each row still runs as its own `test`, so a regression names the shape that broke.
  const ENABLED_CASES: ReadonlyArray<{ what: string; toml: string; expected: boolean }> = [
    { what: "[multimodal] section is absent", toml: '[other]\nfoo = "bar"\n', expected: false },
    {
      what: "[multimodal] is present but the 'enabled' key is absent",
      toml: "[multimodal]\nother_key = true\n",
      expected: false,
    },
    { what: "a literal 'true'", toml: "[multimodal]\nenabled = true\n", expected: true },
    { what: "an explicit 'false'", toml: "[multimodal]\nenabled = false\n", expected: false },
    {
      what: "an inline comment after the value",
      toml: "[multimodal]\nenabled = true # turn on locally\n",
      expected: true,
    },
    {
      what: "a garbage (non-boolean) value",
      toml: "[multimodal]\nenabled = maybe\n",
      expected: false,
    },
    {
      what: "an 'enabled' key found OUTSIDE the [multimodal] section",
      toml: "[other]\nenabled = true\n\n[multimodal]\n",
      expected: false,
    },
  ];

  for (const { what, toml, expected } of ENABLED_CASES) {
    test(`reads ${String(expected)} for ${what}`, () => {
      withTempConfigDir((dir) => {
        writeFileSync(join(dir, "nimbus.toml"), toml);
        expect(loadMultimodalConfig(dir).enabled).toBe(expected);
      });
    });
  }

  test("reads false when the file cannot be parsed as expected (readFileSync throws)", () => {
    // Point configDir at a location where nimbus.toml is actually a directory, so
    // existsSync() is true but readFileSync() throws — the catch-arm around parseMultimodalEnabled.
    withTempConfigDir((dir) => {
      mkdirSync(join(dir, "nimbus.toml"));
      expect(loadMultimodalConfig(dir).enabled).toBe(false);
    });
  });
});
