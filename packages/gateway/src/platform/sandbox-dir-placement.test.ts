import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import {
  createDarwinPaths,
  createLinuxPaths,
  createWindowsPaths,
  type PlatformPaths,
} from "./paths.ts";

/**
 * Runs the REAL `create*Paths` resolvers (not hand-written layouts, which could never disagree with
 * this test) under a stubbed environment, the same way `paths.test.ts` does, and checks where each
 * puts `sandboxDir` relative to the data and config directories.
 */

const TRACKED_ENV_KEYS = [
  "APPDATA",
  "LOCALAPPDATA",
  "NIMBUS_CONFIG_DIR",
  "NIMBUS_DEMO",
  "NIMBUS_GATEWAY_SOCKET",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const k of TRACKED_ENV_KEYS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TRACKED_ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** true when `child` is `parent` or lies inside it. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function placementHolds(p: PlatformPaths): boolean {
  return [p.dataDir, p.configDir].every(
    (other) => !isSameOrInside(p.sandboxDir, other) && !isSameOrInside(other, p.sandboxDir),
  );
}

function setWindowsProfile(): void {
  const base = join(homedir(), "AppData");
  process.env["APPDATA"] = join(base, "Roaming");
  process.env["LOCALAPPDATA"] = join(base, "Local");
}

const RESOLVERS: ReadonlyArray<[string, () => PlatformPaths]> = [
  ["linux", () => createLinuxPaths()],
  ["darwin (configDir === dataDir)", () => createDarwinPaths()],
  [
    "windows",
    () => {
      setWindowsProfile();
      return createWindowsPaths();
    },
  ],
];

describe("sandboxDir placement — the real resolvers", () => {
  for (const [name, resolve] of RESOLVERS) {
    test(`${name}: the default layout keeps sandboxDir out of data/config`, () => {
      const p = resolve();
      expect(p.demo).toBeUndefined();
      expect(placementHolds(p)).toBe(true);
    });

    test(`${name}: the demo layout keeps sandboxDir inside the demo root and out of data/config`, () => {
      const real = resolve();
      process.env["NIMBUS_DEMO"] = "1";
      const demo = resolve();
      expect(demo.demo).toBe(true);
      expect(placementHolds(demo)).toBe(true);
      expect(isSameOrInside(demo.sandboxDir, join(real.dataDir, "demo"))).toBe(true);
    });
  }

  // A STATED BOUND, not a guarantee: placement is not enforced, so an override can nest it. If a
  // boot-time refusal is ever added, this test is the one to flip.
  test("linux: XDG_CACHE_HOME equal to XDG_DATA_HOME nests sandboxDir inside dataDir (unenforced)", () => {
    const shared = join(homedir(), "nimbus-shared-xdg");
    process.env["XDG_CACHE_HOME"] = shared;
    process.env["XDG_DATA_HOME"] = shared;
    const p = createLinuxPaths();
    expect(isSameOrInside(p.sandboxDir, p.dataDir)).toBe(true);
    expect(placementHolds(p)).toBe(false);
  });
});
