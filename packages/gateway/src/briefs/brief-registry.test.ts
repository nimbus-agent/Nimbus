import { describe, expect, test } from "bun:test";
import { MAX_REF_TITLE_CHARS, MAX_REF_URL_CHARS } from "./brief-constants.ts";
import { buildRegistry } from "./brief-registry.ts";
import { BriefRunController } from "./brief-run-store.ts";
import type { BriefRun } from "./brief-types.ts";

function runWith(useIndex: boolean, bodies: readonly string[]): BriefRun {
  const c = new BriefRunController({ nowMs: () => 1000 });
  const sources = bodies.map((_, i) => ({ url: `https://a.test/${i}`, title: `T${i}` }));
  const out = c.create({ brief: "why do workers die", sources, useIndex });
  if ("error" in out) throw new Error("expected a run");
  bodies.forEach((body, i) => {
    c.addSource(out.run, {
      url: `https://a.test/${i}`,
      title: `T${i}`,
      body,
      capturedAt: 1,
      truncated: false,
    });
  });
  return out.run;
}

describe("buildRegistry", () => {
  test("tokenizes fed sources as S1..Sn in declaration order", async () => {
    const { registry } = await buildRegistry(runWith(false, ["a", "b"]), null);
    expect([...registry.keys()]).toEqual(["S1", "S2"]);
    expect(registry.get("S1")?.ref.title).toBe("T0");
    expect(registry.get("S1")?.ref.kind).toBe("source");
  });

  test("carries the source body for quote verification", async () => {
    const { registry } = await buildRegistry(runWith(false, ["the body text"]), null);
    expect(registry.get("S1")?.body).toBe("the body text");
  });

  test("does not search the index when useIndex is false", async () => {
    let called = false;
    await buildRegistry(runWith(false, ["a"]), async () => {
      called = true;
      return { hits: [], semanticAvailable: true };
    });
    expect(called).toBe(false);
  });

  test("does not search the index when useIndex is true but no search fn is injected", async () => {
    const { registry, indexHits, searchFailed } = await buildRegistry(runWith(true, ["a"]), null);
    expect(indexHits).toBe(0);
    expect(searchFailed).toBe(false);
    expect([...registry.keys()]).toEqual(["S1"]);
  });

  test("adds index hits as C1..Cm with clip citations", async () => {
    const { registry, indexHits } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits: [{ itemId: "nimbus:clip:aa", title: "Saved", url: "https://z.test", snippet: "snip" }],
      semanticAvailable: true,
    }));
    expect(indexHits).toBe(1);
    expect(registry.get("C1")?.ref.kind).toBe("clip");
    expect(registry.get("C1")?.ref.clipId).toBe("nimbus:clip:aa");
    expect(registry.get("C1")?.body).toBe("snip");
  });

  test("caps index hits at MAX_INDEX_HITS", async () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      itemId: `nimbus:clip:${i}`,
      title: `C${i}`,
      url: null,
      snippet: "s",
    }));
    const { registry } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits,
      semanticAvailable: true,
    }));
    expect([...registry.keys()].filter((k) => k.startsWith("C"))).toHaveLength(8);
    // Assert that null url from the hit produces an absent ref.url (undefined, not null).
    expect(registry.get("C1")?.ref.url).toBeUndefined();
  });

  test("propagates semanticAvailable so the caller can emit the keyword-only gap", async () => {
    const { semanticAvailable } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits: [],
      semanticAvailable: false,
    }));
    expect(semanticAvailable).toBe(false);
  });

  test("a successful search that returns empty hits is reported as searchFailed: false", async () => {
    let searchWasCalled = false;
    const { registry, indexHits, searchFailed } = await buildRegistry(
      runWith(true, ["a"]),
      async () => {
        searchWasCalled = true;
        return { hits: [], semanticAvailable: true };
      },
    );
    expect(searchWasCalled).toBe(true);
    expect(indexHits).toBe(0);
    expect(searchFailed).toBe(false);
    expect([...registry.keys()]).toEqual(["S1"]);
  });

  test("a failing index search degrades to sources only and is reported as a failure", async () => {
    const { registry, indexHits, searchFailed } = await buildRegistry(
      runWith(true, ["a"]),
      async () => {
        throw new Error("vec0 not loaded");
      },
    );
    expect(indexHits).toBe(0);
    expect(searchFailed).toBe(true);
    expect([...registry.keys()]).toEqual(["S1"]);
  });

  test("clips an over-long S-token source title and url to the caps", async () => {
    const c = new BriefRunController({ nowMs: () => 1000 });
    const longTitle = "T".repeat(MAX_REF_TITLE_CHARS + 50);
    const longUrl = `https://a.test/${"x".repeat(MAX_REF_URL_CHARS + 50)}`;
    const out = c.create({
      brief: "why do workers die",
      sources: [{ url: longUrl, title: longTitle }],
      useIndex: false,
    });
    if ("error" in out) throw new Error("expected a run");
    c.addSource(out.run, {
      url: longUrl,
      title: longTitle,
      body: "body",
      capturedAt: 1,
      truncated: false,
    });

    const { registry } = await buildRegistry(out.run, null);
    const ref = registry.get("S1")?.ref;
    expect(ref?.title.length).toBe(MAX_REF_TITLE_CHARS);
    expect(ref?.title).toBe(longTitle.slice(0, MAX_REF_TITLE_CHARS));
    expect(ref?.url?.length).toBe(MAX_REF_URL_CHARS);
    expect(ref?.url).toBe(longUrl.slice(0, MAX_REF_URL_CHARS));
  });

  test("clips an over-long C-token index-hit title and url to the caps", async () => {
    const longTitle = "C".repeat(MAX_REF_TITLE_CHARS + 50);
    const longUrl = `https://z.test/${"y".repeat(MAX_REF_URL_CHARS + 50)}`;
    const { registry } = await buildRegistry(runWith(true, ["a"]), async () => ({
      hits: [{ itemId: "nimbus:clip:aa", title: longTitle, url: longUrl, snippet: "snip" }],
      semanticAvailable: true,
    }));
    const ref = registry.get("C1")?.ref;
    expect(ref?.title.length).toBe(MAX_REF_TITLE_CHARS);
    expect(ref?.title).toBe(longTitle.slice(0, MAX_REF_TITLE_CHARS));
    expect(ref?.url?.length).toBe(MAX_REF_URL_CHARS);
    expect(ref?.url).toBe(longUrl.slice(0, MAX_REF_URL_CHARS));
  });
});
