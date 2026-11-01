import { describe, expect, test } from "bun:test";
import { diffPermissions, permissionsAfterUpdate } from "./auto-update-permissions-diff.ts";
import { accessEvidence, approvalFields } from "./extension-evidence.ts";
import type { ReachRunner } from "./extension-reach.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";

const perHost: ReachRunner = {
  platform: "linux",
  isFullyActive: () => true,
  degradedReason: () => null,
  canConfine: () => null,
};

function env(
  paths: Record<string, string>,
  roots: string[] = ["/data/nimbus"],
): ExtensionRunGrantEnv {
  return {
    platform: "linux",
    protectedRoots: roots,
    runtimeReadPaths: [],
    realpath(p: string): string {
      const hit = paths[p];
      if (hit === undefined) throw new Error("ENOENT");
      return hit;
    },
  };
}

const perms = (network: string[], read: string[] = [], write: string[] = []) => ({
  network,
  filesystem: { read, write },
});

describe("accessEvidence", () => {
  test("undefined deps: unknown reach, declared files marked not checked", () => {
    const e = accessEvidence(undefined, perms(["a.com"], ["/x"]));
    expect(e.networkReach).toContain("not known here");
    expect(e.fileAccess).toContain("/x");
    expect(e.fileAccess).toEndWith("(not checked here)");
    expect(e.canRunHere).toBeNull();
    expect(e.checked).toBe(false);
  });

  test("a runner and an environment give a real reach and a real file outcome", () => {
    const e = accessEvidence(
      { sandbox: perHost, grantEnv: env({ "/ok": "/ok" }), homeDir: "/home/ada" },
      perms(["a.com", "b.com"], ["/ok"]),
    );
    expect(e.networkReach).toBe("network access to a.com, b.com");
    expect(e.canRunHere).toBe(true);
    expect(e.checked).toBe(true);
  });

  test("a protected path cannot run here", () => {
    const e = accessEvidence(
      { sandbox: perHost, grantEnv: env({ "/data/nimbus": "/data/nimbus" }), homeDir: "/home/ada" },
      perms([], [], ["/data/nimbus"]),
    );
    expect(e.canRunHere).toBe(false);
    expect(e.fileAccess).toContain("can't run here");
  });

  test("a preview that throws is stated, never thrown", () => {
    const boom: ExtensionRunGrantEnv = {
      ...env({ "/x": "/x" }),
      get protectedRoots(): readonly string[] {
        throw new TypeError("odd");
      },
    };
    const e = accessEvidence({ grantEnv: boom, homeDir: "/h" }, perms([], ["/x"]));
    expect(e.fileAccess).toContain("not known here");
    expect(e.canRunHere).toBeNull();
  });
});

describe("approvalFields", () => {
  test("keeps reach and files, and canRunHere only when false", () => {
    const base = { networkReach: "r", fileAccess: "f", checked: true };
    expect(approvalFields({ ...base, canRunHere: true })).toEqual({
      networkReach: "r",
      fileAccess: "f",
    });
    expect(approvalFields({ ...base, canRunHere: null })).toEqual({
      networkReach: "r",
      fileAccess: "f",
    });
    expect(approvalFields({ ...base, canRunHere: false })).toEqual({
      networkReach: "r",
      fileAccess: "f",
      canRunHere: false,
    });
  });
});

describe("permissionsAfterUpdate", () => {
  test("applies adds and removes, sorted and deduplicated", () => {
    const before = perms(["b.com", "a.com"], ["/r"], ["/w"]);
    const after = perms(["c.com", "b.com"], ["/r", "/r2"], []);
    expect(permissionsAfterUpdate(before, diffPermissions(before, after))).toEqual({
      network: ["b.com", "c.com"],
      filesystem: { read: ["/r", "/r2"], write: [] },
    });
  });
});
