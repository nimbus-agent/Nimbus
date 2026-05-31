import type { PermissionDiff } from "./auto-update-types.ts";
import type { SandboxPermissions } from "./permissions-validator.ts";

function diffArrays(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const v of a) if (!b.has(v)) added.push(v);
  for (const v of b) if (!a.has(v)) removed.push(v);
  const byByteOrder = (x: string, y: string): number => {
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  };
  added.sort(byByteOrder);
  removed.sort(byByteOrder);
  return { added, removed };
}

export function diffPermissions(
  before: SandboxPermissions,
  after: SandboxPermissions,
): PermissionDiff {
  return {
    network: diffArrays(before.network, after.network),
    filesystem: {
      read: diffArrays(before.filesystem.read, after.filesystem.read),
      write: diffArrays(before.filesystem.write, after.filesystem.write),
    },
  };
}

export function isWidened(diff: PermissionDiff): boolean {
  return (
    diff.network.added.length > 0 ||
    diff.filesystem.read.added.length > 0 ||
    diff.filesystem.write.added.length > 0
  );
}
