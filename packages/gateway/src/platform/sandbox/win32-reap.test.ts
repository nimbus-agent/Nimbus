import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

import { liveExtensionIds, reapAppContainersAtBoot, reapWith } from "./win32-reap.ts";

// NO `describe.skipIf(process.platform !== "win32")` at file scope — deliberately, for the same
// reason recorded at the top of win32.test.ts. `reapAppContainersAtBoot` short-circuits on
// `process.platform !== "win32"`, but everything past that short-circuit is reachable off-Windows
// by overriding `process.platform` (the established pattern in voice/tts.test.ts and
// cli/src/paths.test.ts) and pointing NIMBUS_SANDBOX_HELPER_PATH at a stand-in executable: the
// helper is invoked with `execFile`, a plain cross-platform Node API, never a Windows-only FFI.
// The two POSIX-only cases below are skipped on Windows rather than on non-Windows, so they still
// run — and still count — on the CI-Linux-authoritative coverage run.

describe("liveExtensionIds", () => {
  it("includes every first-party manifest id", () => {
    const ids = liveExtensionIds({ query: () => ({ all: () => [] }) } as never);
    expect(ids.has("com.nimbus.github")).toBe(true);
  });

  it("includes installed extension ids from the extension table", () => {
    const db = { query: () => ({ all: () => [{ id: "com.acme.custom" }] }) };
    expect(liveExtensionIds(db as never).has("com.acme.custom")).toBe(true);
  });
});

describe("reapWith", () => {
  it("deletes a nimbus profile whose extension is gone", async () => {
    const deleted: string[] = [];
    const reaped = await reapWith({
      enumProfiles: async () => ["nimbus-ext-com.acme.gone", "nimbus-ext-com.nimbus.github"],
      deleteProfile: async (n) => {
        deleted.push(n);
      },
      liveExtensionIds: new Set(["com.nimbus.github"]),
    });
    expect(deleted).toEqual(["nimbus-ext-com.acme.gone"]);
    expect(reaped).toEqual(["nimbus-ext-com.acme.gone"]);
  });

  it("leaves a profile outside the nimbus-ext namespace alone", async () => {
    const deleted: string[] = [];
    await reapWith({
      enumProfiles: async () => ["some-other-app"],
      deleteProfile: async (n) => {
        deleted.push(n);
      },
      liveExtensionIds: new Set(),
    });
    expect(deleted).toEqual([]);
  });
});

describe("reapAppContainersAtBoot", () => {
  // Fresh mkdtemp per test, removed by its own full path. Never %LOCALAPPDATA%/%APPDATA%:
  // those hold the live Gateway database.
  let tmp: string;
  let origPlatform: PropertyDescriptor | undefined;
  let origHelperPath: string | undefined;
  let infos: unknown[];
  let warns: unknown[];

  function logger(): Logger {
    return {
      info: (obj: unknown) => {
        infos.push(obj);
      },
      warn: (obj: unknown) => {
        warns.push(obj);
      },
    } as unknown as Logger;
  }

  function emptyDb(): never {
    return { query: () => ({ all: () => [] }) } as never;
  }

  function pretendWindows(): void {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  }

  /** Writes an executable POSIX stand-in for nimbus-sandbox-helper.exe and points the env at it. */
  function installFakeHelper(body: string): string {
    const helper = join(tmp, "fake-sandbox-helper");
    writeFileSync(helper, `#!/bin/sh\n${body}`);
    chmodSync(helper, 0o755);
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = helper;
    return helper;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-sandbox-reap-test-"));
    origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    origHelperPath = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    infos = [];
    warns = [];
  });

  afterEach(() => {
    if (origPlatform !== undefined) Object.defineProperty(process, "platform", origPlatform);
    if (origHelperPath === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    else process.env["NIMBUS_SANDBOX_HELPER_PATH"] = origHelperPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("is inert off Windows — never even reads the extension table", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    let queried = false;
    const db = {
      query: () => {
        queried = true;
        return { all: () => [] };
      },
    } as never;
    expect(await reapAppContainersAtBoot({ db, logger: logger() })).toEqual([]);
    expect(queried).toBe(false);
  });

  it("skips the whole reap when the live-set read throws — fail-closed, deletes nothing", async () => {
    pretendWindows();
    // A helper that leaves a marker file behind the instant it is invoked at all. If the live-set
    // read did NOT gate enumeration, this file would exist.
    const marker = join(tmp, "helper-was-invoked");
    installFakeHelper(`printf '%s' "$1" > "${marker}"\nexit 0\n`);
    const db = {
      query: () => {
        throw new Error("no such table: extension");
      },
    } as never;

    const reaped = await reapAppContainersAtBoot({ db, logger: logger() });

    // The failure mode is reaping NOTHING, never reaping everything.
    expect(reaped).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(warns).toHaveLength(1);
    expect(infos).toHaveLength(0);
  });

  it("returns empty and logs nothing when the helper cannot be executed at all", async () => {
    pretendWindows();
    // Exists nowhere: execFile rejects, the enumProfiles catch swallows it, the sweep is a no-op.
    process.env["NIMBUS_SANDBOX_HELPER_PATH"] = join(tmp, "definitely-not-here.exe");

    expect(await reapAppContainersAtBoot({ db: emptyDb(), logger: logger() })).toEqual([]);
    expect(warns).toHaveLength(0);
    expect(infos).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")(
    "deletes only the orphaned nimbus profiles the helper lists, and logs what it reaped",
    async () => {
      pretendWindows();
      const deletedLog = join(tmp, "deleted.txt");
      installFakeHelper(
        [
          'case "$1" in',
          // A blank line in the middle exercises the non-empty filter on real helper output.
          "  --list-profiles)",
          "    printf 'nimbus-ext-com.acme.gone\\n\\nnimbus-ext-com.nimbus.github\\nsome-other-app\\n' ;;",
          `  --delete-profile) printf '%s\\n' "$2" >> "${deletedLog}" ;;`,
          "  *) exit 3 ;;",
          "esac",
          "exit 0",
        ].join("\n"),
      );

      const reaped = await reapAppContainersAtBoot({ db: emptyDb(), logger: logger() });

      // com.nimbus.github is a live first-party manifest id; some-other-app is outside the
      // nimbus-ext namespace. Only the orphan goes.
      expect(reaped).toEqual(["nimbus-ext-com.acme.gone"]);
      expect(readFileSync(deletedLog, "utf8")).toBe("nimbus-ext-com.acme.gone\n");
      expect(infos).toHaveLength(1);
      expect(warns).toHaveLength(0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps sweeping when one profile refuses to delete",
    async () => {
      pretendWindows();
      installFakeHelper(
        [
          'case "$1" in',
          "  --list-profiles)",
          "    printf 'nimbus-ext-com.acme.one\\nnimbus-ext-com.acme.two\\n' ;;",
          "  --delete-profile) exit 9 ;;",
          "  *) exit 3 ;;",
          "esac",
          "exit 0",
        ].join("\n"),
      );

      // Best effort: a delete that fails is swallowed, and the second profile is still attempted.
      const reaped = await reapAppContainersAtBoot({ db: emptyDb(), logger: logger() });

      expect(reaped).toEqual(["nimbus-ext-com.acme.one", "nimbus-ext-com.acme.two"]);
      expect(warns).toHaveLength(0);
    },
  );
});
