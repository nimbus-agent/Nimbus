import { describe, expect, test } from "bun:test";
import {
  loadInvariantCitedFiles,
  MIN_CITED_FILES,
  ProtectedSetUnavailableError,
  parseInvariantCitedFiles,
  protectionFor,
} from "./protected-comments.ts";

describe("parseInvariantCitedFiles", () => {
  test("collects a path cited BY LINE", () => {
    const got = parseInvariantCitedFiles(
      "| `packages/gateway/src/ipc/http-routes.ts:2` | I13 | x |",
    );
    expect([...got]).toEqual(["packages/gateway/src/ipc/http-routes.ts"]);
  });

  test("ignores a bare path mention with no line", () => {
    // The doc names many files as wiring sites without depending on their comments;
    // only a line citation means "there is a comment here that this row attests to".
    const got = parseInvariantCitedFiles(
      "see `packages/gateway/src/engine/executor.ts` for the gate",
    );
    expect(got.size).toBe(0);
  });

  test("dedupes repeated citations of one file", () => {
    const got = parseInvariantCitedFiles("`scripts/a.ts:1` and `scripts/a.ts:99`");
    expect([...got]).toEqual(["scripts/a.ts"]);
  });

  test("collects .tsx and .rs too", () => {
    const got = parseInvariantCitedFiles(
      "`packages/ui/src/App.tsx:4` `packages/ui/src-tauri/src/lib.rs:9`",
    );
    expect(got.size).toBe(2);
  });

  test("does not match a path outside packages/ or scripts/", () => {
    expect(parseInvariantCitedFiles("`docs/notes.ts:3`").size).toBe(0);
  });
});

describe("protectionFor", () => {
  const cited = new Set(["packages/gateway/src/cited.ts"]);

  test("protects a file the invariant doc cites by line", () => {
    const v = protectionFor("packages/gateway/src/cited.ts", "const x = 1;", cited);
    expect(v.protected).toBe(true);
    expect(v).toMatchObject({ reason: expect.stringContaining("SECURITY-INVARIANTS") });
  });

  test("protects a file carrying a HITL comment", () => {
    const v = protectionFor(
      "packages/gateway/src/other.ts",
      "// HITL gate runs first\nconst x = 1;",
      cited,
    );
    expect(v).toEqual({ protected: true, reason: "load-bearing comment (HITL)" });
  });

  test("protects a file carrying an invariant id", () => {
    const v = protectionFor(
      "packages/gateway/src/other.ts",
      "// I29 appends before dispatch\n",
      cited,
    );
    expect(v).toEqual({ protected: true, reason: "load-bearing comment (I-numbered)" });
  });

  test("protects a ticket reference", () => {
    const v = protectionFor("packages/gateway/src/other.ts", "// see #1234 for why\n", cited);
    expect(v).toEqual({ protected: true, reason: "load-bearing comment (ticket-ref)" });
  });

  test("does NOT protect a file whose comments carry no marker", () => {
    const v = protectionFor(
      "packages/gateway/src/other.ts",
      "// increment the counter\nlet n = 0;",
      cited,
    );
    expect(v).toEqual({ protected: false });
  });

  test("a marker in CODE rather than a comment does not protect", () => {
    // The scanner reads comment text only; otherwise any file mentioning a ticket id in a
    // string would be immune and the guard would creep toward protecting everything.
    const v = protectionFor("packages/gateway/src/other.ts", 'const msg = "HITL";\n', cited);
    expect(v).toEqual({ protected: false });
  });

  test("finds a marker inside a multi-line block comment body", () => {
    const src = "/**\n * Something long.\n * WORKAROUND for the driver bug.\n */\nconst x = 1;";
    expect(protectionFor("packages/gateway/src/other.ts", src, cited).protected).toBe(true);
  });
});

describe("loadInvariantCitedFiles — fail-closed floor", () => {
  // The dangerous failure is an EMPTY protected set: it is indistinguishable from
  // "nothing here is attested", and acting on that reading deletes every cited comment
  // while reporting success. So a shrunken or unreadable inventory must throw.
  test("throws when the doc cannot be read", async () => {
    await expect(
      loadInvariantCitedFiles(() => Promise.reject(new Error("ENOENT"))),
    ).rejects.toBeInstanceOf(ProtectedSetUnavailableError);
  });

  test("throws when the doc parses to too few citations", async () => {
    await expect(
      loadInvariantCitedFiles(() => Promise.resolve("`packages/a.ts:1`")),
    ).rejects.toBeInstanceOf(ProtectedSetUnavailableError);
  });

  test("accepts a doc at the floor", async () => {
    const doc = Array.from(
      { length: MIN_CITED_FILES },
      (_, i) => `\`packages/f${String(i)}.ts:1\``,
    ).join("\n");
    const got = await loadInvariantCitedFiles(() => Promise.resolve(doc));
    expect(got.size).toBe(MIN_CITED_FILES);
  });

  test("the real SECURITY-INVARIANTS.md clears the floor", async () => {
    // Pins the guard against the live doc: if the inventory format changes, this fails here
    // rather than silently unprotecting 70+ files at the next strip.
    const got = await loadInvariantCitedFiles();
    expect(got.size).toBeGreaterThanOrEqual(MIN_CITED_FILES);
    expect(got.has("packages/gateway/src/ipc/http-routes.ts")).toBe(true);
  });
});
