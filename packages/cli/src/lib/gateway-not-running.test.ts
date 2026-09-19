import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gatewayNotRunningMessage, gatewayStartCommand } from "./gateway-not-running.ts";

describe("gatewayStartCommand", () => {
  test("non-demo", () => {
    expect(gatewayStartCommand(false)).toBe("nimbus start");
  });
  test("demo", () => {
    expect(gatewayStartCommand(true)).toBe("nimbus --demo start");
  });
});

describe("gatewayNotRunningMessage", () => {
  test("non-demo", () => {
    expect(gatewayNotRunningMessage(false)).toBe(
      "Gateway is not running. Start with: nimbus start",
    );
  });
  test("demo", () => {
    expect(gatewayNotRunningMessage(true)).toBe(
      "Gateway is not running (demo root). Start with: nimbus --demo start",
    );
  });
  test("both variants contain the shared substring existing tests assert on", () => {
    expect(gatewayNotRunningMessage(false)).toContain("Gateway is not running");
    expect(gatewayNotRunningMessage(true)).toContain("Gateway is not running");
  });
});

/**
 * Static guard: the not-running HINT form ("start with: nimbus start") must live in exactly one
 * place — this builder — never re-hardcoded at a call site. A re-hardcoded copy is invisible to
 * every runtime test that only exercises the non-demo path, and is exactly how ~25 sites drifted
 * out of demo-awareness before this file existed.
 *
 * Scoped to the literal hint phrase, not every "nimbus start" mention: `help.ts`'s usage synopsis,
 * `init.ts`'s next-step list, the doctor keyring instructions, and `profile.ts`'s restart text are
 * legitimate non-hint mentions and must keep working unmodified.
 */
describe("gateway-not-running hint is not re-hardcoded elsewhere", () => {
  const SRC_ROOT = import.meta.dir;
  const CLI_SRC = resolve(SRC_ROOT, "..");
  const BUILDER_FILE = resolve(SRC_ROOT, "gateway-not-running.ts");
  // Widened to also catch `tui.tsx`'s former "Start it with: nimbus start" — a `.tsx` site the
  // narrower `/start with:/` (no "it") and the `.ts`-only scan below both missed.
  const HINT_RE = /start (?:it )?with:\s*nimbus start/i;

  async function nonTestTsFiles(): Promise<string[]> {
    const entries = await readdir(CLI_SRC, { recursive: true });
    return entries
      .map((f) => f.replaceAll("\\", "/"))
      .filter(
        (f) =>
          (f.endsWith(".ts") || f.endsWith(".tsx")) &&
          !f.endsWith(".test.ts") &&
          !f.endsWith(".test.tsx") &&
          !f.endsWith(".d.ts"),
      )
      .map((f) => resolve(CLI_SRC, f));
  }

  test("the literal hint pattern appears only in the builder", async () => {
    const files = await nonTestTsFiles();
    const offenders: string[] = [];
    for (const file of files) {
      if (file === BUILDER_FILE) continue;
      const contents = await readFile(file, "utf8");
      if (HINT_RE.test(contents)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the builder itself is on disk and matches the pattern (sanity: the scan isn't vacuous)", async () => {
    const contents = await readFile(BUILDER_FILE, "utf8");
    expect(HINT_RE.test(contents)).toBe(true);
  });
});
