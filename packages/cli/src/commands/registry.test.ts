import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

import { COMMAND_NAMES, type CommandName } from "./registry.ts";

describe("COMMAND_NAMES — registry contract", () => {
  it("is a non-empty readonly tuple of strings", () => {
    expect(Array.isArray(COMMAND_NAMES)).toBe(true);
    expect(COMMAND_NAMES.length).toBeGreaterThan(0);
    for (const name of COMMAND_NAMES) {
      expect(typeof name).toBe("string");
    }
  });

  it("contains no duplicates", () => {
    const set = new Set(COMMAND_NAMES);
    expect(set.size).toBe(COMMAND_NAMES.length);
  });

  it("includes the load-bearing built-in commands", () => {
    const required = [
      "ask",
      "config",
      "connector",
      "extension",
      "help",
      "query",
      "search",
      "session",
      "start",
      "stop",
      "vault",
    ];
    for (const r of required) {
      expect(COMMAND_NAMES).toContain(r as CommandName); // NOSONAR S4325: r is a raw string from the iteration; toContain expects CommandName
    }
  });

  it("includes Phase 5 surface (CI/CD + agents + people)", () => {
    expect(COMMAND_NAMES).toContain("deploy");
    expect(COMMAND_NAMES).toContain("metrics");
    expect(COMMAND_NAMES).toContain("expert");
    expect(COMMAND_NAMES).toContain("impact");
    expect(COMMAND_NAMES).toContain("people");
  });

  it("entries are kebab-cased lowercase identifiers (no spaces, no slashes)", () => {
    for (const n of COMMAND_NAMES) {
      expect(n).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  // `negotiate` shipped in #1166 wired into COMMAND_HANDLERS but never added
  // here, and stayed missing until `audit:readme-cli` — which validates the
  // landing page against this list, not against the dispatch table — happened
  // to trip over it. Nothing else compared the two: the assertions above name
  // individual commands by hand, so a command absent from BOTH the registry and
  // every hand-written list is invisible. This closes that gap from the
  // dispatch side.
  //
  // Source-scanned rather than imported: `packages/cli/src/index.ts` is the CLI
  // entry point and runs argv parsing at import time, so importing it here
  // would execute the CLI. The regex reads the `COMMAND_HANDLERS` object
  // literal, whose keys are plain or double-quoted identifiers.
  it("registers every command wired into the CLI dispatch table", async () => {
    // `fileURLToPath`, not `.pathname` — `URL.pathname` stays percent-encoded, so a
    // checkout under a path containing a space or a `#` yields `C:/My%20Repos/…`,
    // which `Bun.file()` cannot open. It also strips the leading slash off a Windows
    // drive letter itself, so no manual rewrite is needed.
    const src = await Bun.file(fileURLToPath(new URL("../index.ts", import.meta.url))).text();

    const block = /const COMMAND_HANDLERS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    expect(block, "COMMAND_HANDLERS object literal not found in index.ts").not.toBeNull();

    const dispatched = [
      ...(block?.[1] ?? "").matchAll(/^\s{2}(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9-]*)):/gm),
    ].map((m) => m[1] ?? m[2]);

    // Guard the scanner itself: if the regex ever stops matching, the set is
    // empty and every assertion below passes vacuously.
    expect(dispatched.length).toBeGreaterThan(30);

    const registered = new Set<string>(COMMAND_NAMES);
    const missing = dispatched.filter((c) => c !== undefined && !registered.has(c));
    expect(
      missing,
      `dispatched in index.ts but absent from COMMAND_NAMES: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
