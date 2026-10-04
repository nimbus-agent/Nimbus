/**
 * `bundledSqlitePath` on EVERY platform's separator rules, from any host.
 *
 * `sqlite-runtime.test.ts` asserts `bundledSqlitePath` for darwin only, so its win32 arm — the
 * separator choice itself — was never exercised. It takes the platform as an argument for exactly
 * this reason (see the module), so nothing here depends on the host OS. Its sibling helpers
 * `sidecarPath` / `sidecarFilename` make the same choice and already have win32 and POSIX cases in
 * `index/sqlite-vec-load.test.ts`, through the re-export every other consumer uses.
 */
import { describe, expect, test } from "bun:test";

import { BUNDLED_SQLITE_FILENAME, bundledSqlitePath } from "./sqlite-runtime.ts";

const WIN_EXEC = String.raw`C:\Program Files\Nimbus\nimbus-gateway.exe`;
const POSIX_EXEC = "/opt/nimbus/bin/nimbus-gateway";

describe("bundledSqlitePath — the separator follows the TARGET platform", () => {
  test("win32 splits a backslash path at its last backslash", () => {
    expect(bundledSqlitePath(WIN_EXEC, "win32")).toBe(
      ["C:", "Program Files", "Nimbus", BUNDLED_SQLITE_FILENAME].join("\\"),
    );
  });

  test("POSIX rules never split at a backslash — the whole Windows path is one name to them", () => {
    // The mirror of the case above, and the reason the platform is a parameter: under posix rules
    // a backslash is an ordinary character, so the "directory" of WIN_EXEC is `.`.
    expect(bundledSqlitePath(WIN_EXEC, "darwin")).toBe(BUNDLED_SQLITE_FILENAME);
    expect(bundledSqlitePath(POSIX_EXEC, "linux")).toBe(
      `/opt/nimbus/bin/${BUNDLED_SQLITE_FILENAME}`,
    );
  });
});
