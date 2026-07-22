import { describe, expect, test } from "bun:test";
import { MAX_SOURCES_PER_RUN } from "./brief-constants.ts";
import {
  BriefValidationError,
  validateCreateInput,
  validateSourceInput,
} from "./brief-validate.ts";

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof BriefValidationError) return e.field;
    throw e;
  }
  throw new Error("expected a BriefValidationError");
}

describe("validateCreateInput", () => {
  const ok = {
    brief: "compare X and Y",
    sources: [{ url: "https://a.test", title: "A" }],
    useIndex: true,
  };

  test("accepts a well-formed body", () => {
    expect(validateCreateInput(ok).useIndex).toBe(true);
  });

  test("defaults useIndex to false when absent", () => {
    expect(validateCreateInput({ brief: "q", sources: ok.sources }).useIndex).toBe(false);
  });

  test("accepts an explicit useIndex: false", () => {
    expect(validateCreateInput({ ...ok, useIndex: false }).useIndex).toBe(false);
  });

  test("rejects a non-boolean useIndex instead of silently coercing to false", () => {
    expect(fieldOf(() => validateCreateInput({ ...ok, useIndex: "true" }))).toBe("useIndex");
  });

  test("rejects a non-object body", () => {
    expect(fieldOf(() => validateCreateInput("nope"))).toBeUndefined();
  });

  test("rejects an empty brief", () => {
    expect(fieldOf(() => validateCreateInput({ ...ok, brief: "  " }))).toBe("brief");
  });

  test("rejects an over-long brief", () => {
    expect(fieldOf(() => validateCreateInput({ ...ok, brief: "x".repeat(5000) }))).toBe("brief");
  });

  test("rejects an empty source list", () => {
    expect(fieldOf(() => validateCreateInput({ ...ok, sources: [] }))).toBe("sources");
  });

  test("rejects more than MAX_SOURCES_PER_RUN sources", () => {
    const sources = Array.from({ length: MAX_SOURCES_PER_RUN + 1 }, (_, i) => ({
      url: `https://a.test/${i}`,
      title: `T${i}`,
    }));
    expect(fieldOf(() => validateCreateInput({ ...ok, sources }))).toBe("sources");
  });

  test("rejects a source missing its url", () => {
    expect(fieldOf(() => validateCreateInput({ ...ok, sources: [{ title: "A" }] }))).toBe(
      "sources",
    );
  });

  test("rejects a source that isn't an object", () => {
    expect(fieldOf(() => validateCreateInput({ ...ok, sources: ["https://a.test"] }))).toBe(
      "sources",
    );
  });

  test("rejects a source missing its title", () => {
    expect(
      fieldOf(() => validateCreateInput({ ...ok, sources: [{ url: "https://a.test" }] })),
    ).toBe("sources");
  });
});

describe("validateSourceInput", () => {
  const ok = { url: "https://a.test", title: "A", body: "text", capturedAt: 1700000000000 };

  test("rejects a seconds-precision timestamp rather than accepting it silently", () => {
    expect(fieldOf(() => validateSourceInput({ ...ok, capturedAt: 1700000000 }))).toBe(
      "capturedAt",
    );
  });

  test("accepts a well-formed body and defaults truncated to false", () => {
    expect(validateSourceInput(ok).truncated).toBe(false);
  });

  test("honours truncated: true", () => {
    expect(validateSourceInput({ ...ok, truncated: true }).truncated).toBe(true);
  });

  test("accepts an explicit truncated: false", () => {
    expect(validateSourceInput({ ...ok, truncated: false }).truncated).toBe(false);
  });

  test("rejects a non-boolean truncated instead of silently coercing to false", () => {
    expect(fieldOf(() => validateSourceInput({ ...ok, truncated: 1 }))).toBe("truncated");
  });

  test("rejects an empty body", () => {
    expect(fieldOf(() => validateSourceInput({ ...ok, body: "" }))).toBe("body");
  });

  test("rejects a non-finite capturedAt", () => {
    expect(fieldOf(() => validateSourceInput({ ...ok, capturedAt: "soon" }))).toBe("capturedAt");
  });

  test("rejects a missing url", () => {
    expect(fieldOf(() => validateSourceInput({ ...ok, url: "" }))).toBe("url");
  });

  test("rejects a non-string title", () => {
    expect(fieldOf(() => validateSourceInput({ ...ok, title: 42 }))).toBe("title");
  });
});
