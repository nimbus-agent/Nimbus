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
  // Explicit byte-order compare. Default sort orders by UTF-16 code unit too,
  // but Sonar S2871 demands an explicit comparator. Stay locale-independent —
  // the diff is consumed by the HITL prompt and must look identical across hosts.
  const byByteOrder = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
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
