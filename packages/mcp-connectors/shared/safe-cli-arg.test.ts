import { describe, expect, test } from "bun:test";
import { assertSafeCliArg, isSafeCliArg } from "./safe-cli-arg.ts";

const NUL = String.fromCharCode(0);
const UNIT_SEP = String.fromCharCode(0x1f); // the last control character
const LF = String.fromCharCode(0x0a);
const TAB = String.fromCharCode(0x09);
const CR = String.fromCharCode(0x0d);

/**
 * This is a security control, not a formatter: it is the universal guard against
 * "argv flag smuggling", where a tool-supplied value beginning with `-` is
 * parsed by a spawned CLI as a FLAG rather than as a positional. Spawns use an
 * argv array, so there is no shell to inject into — the flag itself is the
 * injection.
 *
 * Every REJECT arm therefore needs cover. Before this file the module sat at
 * 62.5% line coverage with no test of its own: the accept path was exercised
 * incidentally by connectors that call it inline, and the arms that actually
 * stop an attack were exercised by nothing.
 */
describe("assertSafeCliArg — accepts", () => {
  test("returns the value unchanged so it can be used inline", () => {
    expect(assertSafeCliArg("my-sink-1")).toBe("my-sink-1");
  });

  test("allows the per-service charsets the docblock names", () => {
    // sink ids, CloudWatch log-group names (slashes), BigQuery refs (dots)
    expect(assertSafeCliArg("a_b.c-d")).toBe("a_b.c-d");
    expect(assertSafeCliArg("/aws/lambda/my-fn")).toBe("/aws/lambda/my-fn");
    expect(assertSafeCliArg("project.dataset.table")).toBe("project.dataset.table");
  });

  test("allows a hyphen anywhere except the first character", () => {
    expect(assertSafeCliArg("not-a-flag")).toBe("not-a-flag");
  });

  test("allows exactly 1024 characters — the boundary is inclusive", () => {
    const at = "a".repeat(1024);
    expect(assertSafeCliArg(at)).toBe(at);
  });

  /**
   * The boundary is `< 0x20`, so SPACE (0x20) is deliberately allowed. Pinned
   * because it reads like an oversight and is not: a spawn passes argv entries
   * verbatim with no word-splitting, so an embedded space is inert, while
   * rejecting it would break services whose resource names permit spaces.
   */
  test("allows space, which is 0x20 and therefore not a control character", () => {
    expect(assertSafeCliArg("my resource")).toBe("my resource");
  });
});

describe("assertSafeCliArg — rejects", () => {
  test("an empty string", () => {
    expect(() => assertSafeCliArg("")).toThrow(/must be a non-empty string/);
  });

  test("a non-string, even though the type says otherwise", () => {
    // The runtime guard exists because tool input crosses a JSON boundary where
    // the declared type is not enforced.
    expect(() => assertSafeCliArg(undefined as unknown as string)).toThrow(
      /must be a non-empty string/,
    );
    expect(() => assertSafeCliArg(42 as unknown as string)).toThrow(/must be a non-empty string/);
  });

  test("a value over 1024 characters", () => {
    expect(() => assertSafeCliArg("a".repeat(1025))).toThrow(/exceeds 1024 characters/);
  });

  // The arm this module exists for.
  test("a value starting with a dash — the flag-smuggling case", () => {
    expect(() => assertSafeCliArg("--project=attacker")).toThrow(/argv flag smuggling/);
    expect(() => assertSafeCliArg("-h")).toThrow(/argv flag smuggling/);
    expect(() => assertSafeCliArg("-")).toThrow(/argv flag smuggling/);
  });

  test("control characters, wherever they sit in the value", () => {
    expect(() => assertSafeCliArg(`${NUL}abc`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`ab${LF}cd`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`ab${TAB}cd`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`trailing${CR}`)).toThrow(/control characters/);
    expect(() => assertSafeCliArg(`x${UNIT_SEP}`)).toThrow(/control characters/);
  });

  test("names the caller's label in the message, so the failure is attributable", () => {
    expect(() => assertSafeCliArg("-x", "sinkName")).toThrow(/Invalid sinkName/);
  });
});

describe("isSafeCliArg — the non-throwing predicate form", () => {
  test("is true for a safe value", () => {
    expect(isSafeCliArg("my-sink-1")).toBe(true);
  });

  test("is false for every reject arm, rather than throwing", () => {
    for (const bad of ["", "-h", "--flag", `a${NUL}b`, "a".repeat(1025)]) {
      expect(isSafeCliArg(bad)).toBe(false);
    }
  });

  test("is false for non-strings, which is what makes it usable in .refine()", () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(isSafeCliArg(bad)).toBe(false);
    }
  });

  /**
   * The two must never disagree: `isSafeCliArg` is the schema-boundary form of
   * the same rule, so a value the predicate waves through must also survive the
   * assertion the handler later makes.
   */
  test("agrees with assertSafeCliArg on every case", () => {
    const cases = [
      "ok",
      "a.b-c",
      "my resource",
      "",
      "-x",
      `a${LF}b`,
      "a".repeat(1025),
      "a".repeat(1024),
    ];
    for (const v of cases) {
      let asserted = true;
      try {
        assertSafeCliArg(v);
      } catch {
        asserted = false;
      }
      expect(isSafeCliArg(v)).toBe(asserted);
    }
  });
});
