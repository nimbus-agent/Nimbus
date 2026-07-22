import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUN_TTL_MS,
  MAX_RETAINED_TERMINAL_RUNS,
  MAX_RUN_BYTES,
  MAX_SOURCE_BYTES,
} from "./brief-constants.ts";
import { BriefRunController } from "./brief-run-store.ts";
import type { Report } from "./brief-types.ts";

function fixture() {
  let now = 1_000_000;
  let n = 0;
  const c = new BriefRunController({ nowMs: () => now, genId: () => `run_${++n}` });
  return {
    c,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

const SRC = [
  { url: "https://a.test/1", title: "A" },
  { url: "https://b.test/2", title: "B" },
];

function created(c: BriefRunController, sources = SRC) {
  const out = c.create({ brief: "q", sources, useIndex: false });
  if ("error" in out) throw new Error("expected a run");
  return out.run;
}

const REPORT: Report = {
  summary: "s",
  findings: [],
  conflicts: [],
  gaps: [],
  synthesis: { model: "m", remote: false },
};

describe("create", () => {
  test("counts distinct canonical URLs as expected", () => {
    const { c } = fixture();
    const run = created(c, [
      { url: "https://a.test/1?utm_source=x", title: "A" },
      { url: "https://a.test/1", title: "A dup" },
      { url: "https://b.test/2", title: "B" },
    ]);
    expect(run.declared.size).toBe(2);
  });

  test("refuses a 4th concurrent run", () => {
    const { c } = fixture();
    created(c);
    created(c);
    created(c);
    const out = c.create({ brief: "q", sources: SRC, useIndex: false });
    expect("error" in out && out.error).toBe("busy");
  });

  test("reports activeRuns and an expiry upper bound when busy", () => {
    const { c } = fixture();
    created(c);
    created(c);
    created(c);
    const out = c.create({ brief: "q", sources: SRC, useIndex: false });
    if (!("error" in out)) throw new Error("expected busy");
    expect(out.activeRuns).toBe(3);
    expect(out.oldestExpiresInSeconds).toBeGreaterThan(0);
    expect(out.oldestExpiresInSeconds).toBeLessThanOrEqual(DEFAULT_RUN_TTL_MS / 1000);
  });

  test("sweeps expired runs before enforcing the cap (abandoned-run lockout)", () => {
    const { c, advance } = fixture();
    created(c);
    created(c);
    created(c);
    // Nobody ever polls these three. Without a sweep at create() they pin the cap forever.
    advance(DEFAULT_RUN_TTL_MS + 1);
    const out = c.create({ brief: "q", sources: SRC, useIndex: false });
    expect("error" in out).toBe(false);
  });
});

describe("get and expiry", () => {
  test("returns the run before its TTL", () => {
    const { c } = fixture();
    const run = created(c);
    expect(c.get(run.id)).not.toBeNull();
  });

  test("expires lazily on access and remembers the id was known", () => {
    const { c, advance } = fixture();
    const run = created(c);
    advance(DEFAULT_RUN_TTL_MS + 1);
    expect(c.get(run.id)).toBeNull();
    expect(c.wasKnown(run.id)).toBe(true);
  });

  test("an id that never existed is not known", () => {
    const { c } = fixture();
    expect(c.wasKnown("run_nope")).toBe(false);
  });

  test("does NOT refresh the TTL on access", () => {
    const { c, advance } = fixture();
    const run = created(c);
    advance(DEFAULT_RUN_TTL_MS - 10);
    expect(c.get(run.id)).not.toBeNull();
    advance(20);
    expect(c.get(run.id)).toBeNull();
  });
});

describe("addSource", () => {
  test("accepts a declared source and increments received", () => {
    const { c } = fixture();
    const run = created(c);
    const out = c.addSource(run, {
      url: "https://a.test/1",
      title: "A",
      body: "text",
      capturedAt: 1,
      truncated: false,
    });
    expect(out).toEqual({ accepted: true, received: 1 });
  });

  test("a re-feed is accepted:false with received unchanged", () => {
    const { c } = fixture();
    const run = created(c);
    const s = {
      url: "https://a.test/1",
      title: "A",
      body: "text",
      capturedAt: 1,
      truncated: false,
    };
    c.addSource(run, s);
    expect(c.addSource(run, s)).toEqual({ accepted: false, received: 1 });
    expect(run.sources.size).toBe(1);
  });

  test("a tracking-param variant matches the declared canonical URL", () => {
    const { c } = fixture();
    const run = created(c);
    const out = c.addSource(run, {
      url: "https://a.test/1?utm_source=news",
      title: "A",
      body: "t",
      capturedAt: 1,
      truncated: false,
    });
    expect(out).toEqual({ accepted: true, received: 1 });
  });

  test("rejects an undeclared URL", () => {
    const { c } = fixture();
    const run = created(c);
    const out = c.addSource(run, {
      url: "https://z.test/9",
      title: "Z",
      body: "t",
      capturedAt: 1,
      truncated: false,
    });
    expect(out).toEqual({ error: "undeclared" });
  });

  test("rejects a body over MAX_SOURCE_BYTES", () => {
    const { c } = fixture();
    const run = created(c);
    const out = c.addSource(run, {
      url: "https://a.test/1",
      title: "A",
      body: "x".repeat(MAX_SOURCE_BYTES + 1),
      capturedAt: 1,
      truncated: false,
    });
    expect(out).toEqual({ error: "source_too_large" });
  });

  test("measures UTF-8 bytes, not code units", () => {
    const { c } = fixture();
    const run = created(c);
    // 100_000 CJK chars: String.length 100_000, encoded ~300 KB — over the 256 KB cap.
    const body = "漢".repeat(100_000);
    expect(body.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(
      c.addSource(run, {
        url: "https://a.test/1",
        title: "A",
        body,
        capturedAt: 1,
        truncated: false,
      }),
    ).toEqual({ error: "source_too_large" });
  });

  test("rejects a source with a small body but an oversized title", () => {
    const { c } = fixture();
    const run = created(c);
    const out = c.addSource(run, {
      url: "https://a.test/1",
      title: "x".repeat(MAX_SOURCE_BYTES + 1),
      body: "x",
      capturedAt: 1,
      truncated: false,
    });
    expect(out).toEqual({ error: "source_too_large" });
  });

  test("titles count toward the run byte budget, not just bodies", () => {
    const { c } = fixture();
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `https://a.test/${i}`,
      title: `T${i}`,
    }));
    const run = created(c, many);
    // Just under MAX_SOURCE_BYTES on its own (with headroom for the tiny body + url), so
    // each source passes the per-source cap but 16+ of them blow the 4 MB run budget.
    const title = "x".repeat(MAX_SOURCE_BYTES - 64);
    let sawCapacity = false;
    for (let i = 0; i < 20; i++) {
      const out = c.addSource(run, {
        url: `https://a.test/${i}`,
        title,
        body: "x",
        capturedAt: 1,
        truncated: false,
      });
      if ("error" in out && out.error === "run_capacity") {
        sawCapacity = true;
        break;
      }
    }
    expect(sawCapacity).toBe(true);
    expect(run.bytesHeld).toBeLessThanOrEqual(MAX_RUN_BYTES);
  });

  test("rejects once the run byte budget is exhausted", () => {
    const { c } = fixture();
    const many = Array.from({ length: 20 }, (_, i) => ({
      url: `https://a.test/${i}`,
      title: `T${i}`,
    }));
    const run = created(c, many);
    // Leave headroom below MAX_SOURCE_BYTES for the title + url, which now count too
    // (see brief-run-store.ts addSource).
    const body = "x".repeat(MAX_SOURCE_BYTES - 64);
    let sawCapacity = false;
    for (let i = 0; i < 20; i++) {
      const out = c.addSource(run, {
        url: `https://a.test/${i}`,
        title: `T${i}`,
        body,
        capturedAt: 1,
        truncated: false,
      });
      if ("error" in out && out.error === "run_capacity") {
        sawCapacity = true;
        break;
      }
    }
    expect(sawCapacity).toBe(true);
    expect(run.bytesHeld).toBeLessThanOrEqual(MAX_RUN_BYTES);
  });

  test("NFC-normalizes the stored body so quote offsets stay valid", () => {
    const { c } = fixture();
    const run = created(c);
    c.addSource(run, {
      url: "https://a.test/1",
      title: "A",
      body: "école",
      capturedAt: 1,
      truncated: false,
    });
    expect(run.sources.get("https://a.test/1")?.body).toBe("école");
  });
});

describe("terminal states", () => {
  test("finish stores the report and drops every source body", () => {
    const { c } = fixture();
    const run = created(c);
    c.addSource(run, {
      url: "https://a.test/1",
      title: "A",
      body: "t",
      capturedAt: 1,
      truncated: false,
    });
    c.markRunning(run);
    c.finish(run, REPORT);
    expect(run.status).toBe("done");
    expect(run.report).toEqual(REPORT);
    expect(run.sources.size).toBe(0);
    expect(run.bytesHeld).toBe(0);
  });

  test("fail stores the error code and drops the bodies", () => {
    const { c } = fixture();
    const run = created(c);
    c.addSource(run, {
      url: "https://a.test/1",
      title: "A",
      body: "t",
      capturedAt: 1,
      truncated: false,
    });
    c.fail(run, "llm_unavailable");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("llm_unavailable");
    expect(run.sources.size).toBe(0);
  });

  test("a terminal run frees its concurrency slot immediately", () => {
    const { c } = fixture();
    const a = created(c);
    created(c);
    created(c);
    c.finish(a, REPORT);
    // The cap is a MEMORY bound and a finished run holds no source bytes. Locking the
    // user out for the rest of the TTL over a ~20 KB report would read as broken.
    expect("error" in c.create({ brief: "q", sources: SRC, useIndex: false })).toBe(false);
  });

  test("a terminal run stays readable after freeing its slot", () => {
    const { c } = fixture();
    const a = created(c);
    c.finish(a, REPORT);
    created(c);
    created(c);
    created(c);
    expect(c.get(a.id)?.report).toEqual(REPORT);
  });

  test("retained terminal runs are bounded, oldest evicted first", () => {
    const { c } = fixture();
    const first = created(c);
    c.finish(first, REPORT);
    for (let i = 0; i < MAX_RETAINED_TERMINAL_RUNS; i++) {
      c.finish(created(c), REPORT);
    }
    expect(c.get(first.id)).toBeNull();
    expect(c.wasKnown(first.id)).toBe(true);
  });
});

describe("custom ttlMs and default genId", () => {
  test("custom ttlMs is honoured", () => {
    let now = 1_000_000;
    const customTtl = 60_000;
    const c = new BriefRunController({ nowMs: () => now, ttlMs: customTtl });
    const run = created(c, SRC);
    // Advance past the custom TTL but well short of the default.
    now += 100_000;
    expect(c.get(run.id)).toBeNull();
    expect(c.wasKnown(run.id)).toBe(true);
  });

  test("the default genId produces the production id format", () => {
    const now = 1_000_000;
    const c = new BriefRunController({ nowMs: () => now });
    const run1 = created(c, SRC);
    const run2 = created(c, SRC);
    expect(run1.id).toMatch(/^run_[0-9a-f]{20}$/);
    expect(run2.id).toMatch(/^run_[0-9a-f]{20}$/);
    expect(run1.id).not.toBe(run2.id);
  });
});

describe("get() edge cases", () => {
  test("get() on a never-created id distinguishes from expired", () => {
    const { c } = fixture();
    expect(c.get("run_neverexisted")).toBeNull();
    expect(c.wasKnown("run_neverexisted")).toBe(false);
  });

  test("a terminal run present while busy does not count against the active cap", () => {
    const { c } = fixture();
    const a = created(c);
    created(c);
    created(c);
    // Finish the first run so it becomes terminal (drops source bytes).
    c.finish(a, REPORT);
    // Now a terminal run is in the map alongside two non-terminals.
    // Attempting another create should succeed (activeRuns = 2, < 3).
    // But if we had one more, we'd have 3 non-terminal + 1 terminal.
    // Let's verify the behavior: after finishing a, we have 2 non-terminal + a (terminal).
    // activeRuns should count only the 2 non-terminals = 2, so create should succeed.
    const out = c.create({ brief: "q", sources: SRC, useIndex: false });
    expect("error" in out).toBe(false);
  });

  test("oldestExpiresInSeconds reaches 0 for a run sitting exactly on its expiry", () => {
    let now = 1_000_000;
    let nextGenId = 0;
    const c = new BriefRunController({
      nowMs: () => now,
      ttlMs: 10_000,
      genId: () => `run_${++nextGenId}`,
    });

    // Create three runs.
    created(c, SRC);
    const run1Expiry = now + 10_000;

    now += 5_000;
    created(c, SRC);

    now += 4_999;
    created(c, SRC);
    // Now run1 expires at 1010000, run2 at 1015000, run3 at 1014999.
    // Current now = 1009999. Oldest non-terminal expires at 1010000,
    // remaining = 1000 ms, ceil(1000/1000) = 1, max(0, 1) = 1.

    now = run1Expiry;
    // The oldest run sits exactly on its expiry. sweep() needs `now > expiresAtMs`, so it
    // survives and still counts toward the cap — that boundary is what this test pins.
    //
    // NOTE: this does NOT exercise the Math.max(0, ...) clamp. At now === expiry the
    // expression is max(0, ceil(0)) = 0 either way, so deleting the clamp would not fail
    // this test. Reaching the clamp needs soonest < now, i.e. a past-expiry run still in
    // the map when the busy response is computed — unreachable, because create() sweeps
    // those away first. The clamp is defensive only.
    const out = c.create({ brief: "q", sources: SRC, useIndex: false });
    if (!("error" in out)) throw new Error("expected busy");
    expect(out.activeRuns).toBe(3);
    expect(out.oldestExpiresInSeconds).toBe(0);
  });
});
