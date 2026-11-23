// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-tree.ts
// Removing a run's directory tree (invariant I15; static D43(d)). Split out of `iac-runner.ts` with
// no behaviour change.
import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** An approved plan directory is read-only (0500): make a tree removable before removing it. */
function makeTreeWritable(p: string): void {
  try {
    chmodSync(p, 0o700);
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) makeTreeWritable(join(p, e.name));
    }
  } catch {
    // missing or not ours to change: the removal below reports what matters
  }
}

export function defaultRemoveTree(p: string): void {
  makeTreeWritable(p);
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
