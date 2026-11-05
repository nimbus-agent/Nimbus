/**
 * I15 (B4b, review finding 5): a write path the gateway canonicalised when it decided the grant
 * must still canonicalise to itself when the sandbox wrapper spawns, or the wrapper refuses.
 * Real links on every OS (junctions on win32 need no privilege).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath } from "./canonical-path.ts";
import {
  canonicalWriteDrift,
  parseSandboxPolicy,
  policyFromManifest,
  type SandboxPolicy,
} from "./sandbox-policy.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function base(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-drift-")));
  temps.push(d);
  return d;
}

function policy(write: readonly string[], canonicalWritePaths?: readonly string[]): SandboxPolicy {
  return {
    id: "com.nimbus.obsidian",
    permissions: { network: [], filesystem: { read: [], write: [...write] } },
    ...(canonicalWritePaths === undefined ? {} : { canonicalWritePaths }),
  };
}

describe("canonicalWriteDrift", () => {
  test("an unchanged canonical vault passes", () => {
    const v = join(base(), "vault");
    mkdirSync(v);
    expect(canonicalWriteDrift(policy([v], [v]), canonicalPath)).toBeUndefined();
  });

  test("a vault replaced by a link (to anywhere) after the decision is refused", () => {
    const b = base();
    const v = join(b, "vault");
    mkdirSync(join(b, "elsewhere"));
    symlinkSync(join(b, "elsewhere"), v, process.platform === "win32" ? "junction" : "dir");
    expect(canonicalPath(v)).not.toBe(v);
    expect(canonicalWriteDrift(policy([v], [v]), canonicalPath)).toBe(v);
  });

  test("a canonical path that is not in the write list is refused", () => {
    expect(canonicalWriteDrift(policy([], ["/v"]), (p) => p)).toBe("/v");
  });

  test("a policy without the field is never refused (every other spawn is unchanged)", () => {
    expect(canonicalWriteDrift(policy(["/not/canonical"]), () => "/other")).toBeUndefined();
  });

  test("the field crosses the wire: policyFromManifest carries it, parseSandboxPolicy validates it", () => {
    const p = policyFromManifest({
      id: "com.nimbus.obsidian",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: ["/v"] } },
      canonicalWritePaths: ["/v"],
    } as unknown as Parameters<typeof policyFromManifest>[0]);
    expect(p.canonicalWritePaths).toEqual(["/v"]);
    expect(parseSandboxPolicy(JSON.stringify(p)).canonicalWritePaths).toEqual(["/v"]);
    expect(() => parseSandboxPolicy(JSON.stringify({ ...p, canonicalWritePaths: [7] }))).toThrow();
    const { canonicalWritePaths: _c, ...without } = p;
    expect(parseSandboxPolicy(JSON.stringify(without)).canonicalWritePaths).toBeUndefined();
  });
});
