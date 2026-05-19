import { describe, expect, it } from "bun:test";

import { diffPermissions, isWidened } from "./auto-update-permissions-diff.ts";
import type { SandboxPermissions } from "./permissions-validator.ts";

const empty: SandboxPermissions = { network: [], filesystem: { read: [], write: [] } };

describe("diffPermissions", () => {
  it("returns empty diff when both sides are empty", () => {
    expect(diffPermissions(empty, empty)).toEqual({
      network: { added: [], removed: [] },
      filesystem: {
        read: { added: [], removed: [] },
        write: { added: [], removed: [] },
      },
    });
  });

  it("computes added network hosts", () => {
    const before: SandboxPermissions = { network: ["a.com"], filesystem: { read: [], write: [] } };
    const after: SandboxPermissions = {
      network: ["a.com", "b.com"],
      filesystem: { read: [], write: [] },
    };
    const d = diffPermissions(before, after);
    expect(d.network.added).toEqual(["b.com"]);
    expect(d.network.removed).toEqual([]);
  });

  it("computes removed network hosts", () => {
    const before: SandboxPermissions = {
      network: ["a.com", "b.com"],
      filesystem: { read: [], write: [] },
    };
    const after: SandboxPermissions = { network: ["a.com"], filesystem: { read: [], write: [] } };
    const d = diffPermissions(before, after);
    expect(d.network.removed).toEqual(["b.com"]);
    expect(d.network.added).toEqual([]);
  });

  it("deduplicates within an axis", () => {
    const before: SandboxPermissions = {
      network: ["a.com", "a.com"],
      filesystem: { read: [], write: [] },
    };
    const after: SandboxPermissions = {
      network: ["a.com", "b.com", "b.com"],
      filesystem: { read: [], write: [] },
    };
    const d = diffPermissions(before, after);
    expect(d.network.added).toEqual(["b.com"]);
  });

  it("sorts output lexicographically", () => {
    const before: SandboxPermissions = { network: [], filesystem: { read: [], write: [] } };
    const after: SandboxPermissions = {
      network: ["z.com", "a.com", "m.com"],
      filesystem: { read: [], write: [] },
    };
    const d = diffPermissions(before, after);
    expect(d.network.added).toEqual(["a.com", "m.com", "z.com"]);
  });

  it("handles filesystem read + write axes independently", () => {
    const before: SandboxPermissions = {
      network: [],
      filesystem: { read: ["/a"], write: ["/x"] },
    };
    const after: SandboxPermissions = {
      network: [],
      filesystem: { read: ["/a", "/b"], write: [] },
    };
    const d = diffPermissions(before, after);
    expect(d.filesystem.read.added).toEqual(["/b"]);
    expect(d.filesystem.read.removed).toEqual([]);
    expect(d.filesystem.write.added).toEqual([]);
    expect(d.filesystem.write.removed).toEqual(["/x"]);
  });
});

describe("isWidened", () => {
  it("is false when no axis added anything", () => {
    expect(
      isWidened({
        network: { added: [], removed: ["a.com"] },
        filesystem: {
          read: { added: [], removed: [] },
          write: { added: [], removed: [] },
        },
      }),
    ).toBe(false);
  });

  it("is true when network adds a host", () => {
    expect(
      isWidened({
        network: { added: ["a.com"], removed: [] },
        filesystem: {
          read: { added: [], removed: [] },
          write: { added: [], removed: [] },
        },
      }),
    ).toBe(true);
  });

  it("is true when filesystem.write adds a path", () => {
    expect(
      isWidened({
        network: { added: [], removed: [] },
        filesystem: {
          read: { added: [], removed: [] },
          write: { added: ["/x"], removed: [] },
        },
      }),
    ).toBe(true);
  });
});
