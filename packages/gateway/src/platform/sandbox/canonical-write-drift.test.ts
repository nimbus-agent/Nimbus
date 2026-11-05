/**
 * I15 (B4b, review finding 5): a write path the gateway canonicalised when it decided the grant
 * must still canonicalise to itself when the sandbox wrapper spawns, or the wrapper refuses.
 * Real links on every OS (junctions on win32 need no privilege).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalPath } from "./canonical-path.ts";
import {
  canonicalWriteDrift,
  parseSandboxPolicy,
  policyFromManifest,
  type SandboxPolicy,
  writeFileDrift,
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

describe("writeFileDrift: a declared file must still be one regular file (re-review finding 2)", () => {
  function filePolicy(write: readonly string[], files: readonly string[]): SandboxPolicy {
    return {
      id: "com.nimbus.obsidian",
      permissions: { network: [], filesystem: { read: [], write: [...write] } },
      canonicalWriteFiles: files,
    };
  }

  test("a regular file with one name passes", () => {
    const f = join(base(), "note.md");
    writeFileSync(f, "");
    expect(writeFileDrift(filePolicy([f], [f]), (p) => lstatSync(p))).toBeUndefined();
  });

  test("a folder, a missing path, a symlink or a second name at a declared file's path refuses", () => {
    const b = base();
    const folder = join(b, "now-a-folder.md");
    mkdirSync(folder);
    expect(writeFileDrift(filePolicy([folder], [folder]), (p) => lstatSync(p))).toBe(folder);
    const gone = join(b, "gone.md");
    expect(writeFileDrift(filePolicy([gone], [gone]), (p) => lstatSync(p))).toBe(gone);
    const target = join(b, "target.md");
    writeFileSync(target, "");
    const hard = join(b, "hard.md");
    linkSync(target, hard);
    expect(writeFileDrift(filePolicy([hard], [hard]), (p) => lstatSync(p))).toBe(hard);
    const sym = join(b, "sym.md");
    try {
      symlinkSync(target, sym, "file");
    } catch {
      return; // Windows without the privilege: the other three cases stand
    }
    expect(writeFileDrift(filePolicy([sym], [sym]), (p) => lstatSync(p))).toBe(sym);
  });

  test("a declared file that is not in the write list refuses; no declaration, no check", () => {
    expect(
      writeFileDrift(filePolicy([], ["/x.md"]), () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        nlink: 1,
      })),
    ).toBe("/x.md");
    expect(
      writeFileDrift(
        { id: "x", permissions: { network: [], filesystem: { read: [], write: ["/d"] } } },
        () => {
          throw new Error("never called");
        },
      ),
    ).toBeUndefined();
  });

  test("the field crosses the wire", () => {
    const p = filePolicy(["/n.md"], ["/n.md"]);
    expect(parseSandboxPolicy(JSON.stringify(p)).canonicalWriteFiles).toEqual(["/n.md"]);
    expect(() => parseSandboxPolicy(JSON.stringify({ ...p, canonicalWriteFiles: [1] }))).toThrow();
    expect(
      policyFromManifest({
        id: "com.nimbus.obsidian",
        version: "1.0.0",
        permissions: { network: [], filesystem: { read: [], write: ["/n.md"] } },
        canonicalWriteFiles: ["/n.md"],
      } as unknown as Parameters<typeof policyFromManifest>[0]).canonicalWriteFiles,
    ).toEqual(["/n.md"]);
  });
});
