import type { DependencyConflict } from "./dependency-types.ts";

export class DependencyConflictError extends Error {
  readonly conflict: DependencyConflict;

  constructor(conflict: DependencyConflict) {
    super(`dependency_conflict:${conflict.kind}:${conflict.id}`);
    this.name = "DependencyConflictError";
    this.conflict = conflict;
  }
}

export class OfflineDependencyResolutionError extends Error {
  readonly missingId: string;
  readonly parent: string;

  constructor(opts: { missingId: string; parent: string }) {
    super(`offline_dependency_resolution:${opts.missingId} (required by ${opts.parent})`);
    this.name = "OfflineDependencyResolutionError";
    this.missingId = opts.missingId;
    this.parent = opts.parent;
  }
}

export class ReverseDepBlockedError extends Error {
  readonly target: string;
  readonly blockers: ReadonlyArray<{ id: string; range: string }>;

  constructor(opts: { target: string; blockers: ReadonlyArray<{ id: string; range: string }> }) {
    super(`reverse_dep_blocked:${opts.target}:${opts.blockers.length}`);
    this.name = "ReverseDepBlockedError";
    this.target = opts.target;
    this.blockers = opts.blockers;
  }
}

export function isDependencyConflictError(e: unknown): e is DependencyConflictError {
  return e instanceof Error && e.name === "DependencyConflictError";
}

export function isOfflineDependencyResolutionError(
  e: unknown,
): e is OfflineDependencyResolutionError {
  return e instanceof Error && e.name === "OfflineDependencyResolutionError";
}

export function isReverseDepBlockedError(e: unknown): e is ReverseDepBlockedError {
  return e instanceof Error && e.name === "ReverseDepBlockedError";
}

/** One line saying why a solve refused, for a list or a refusal message. */
export function describeDependencyConflict(conflict: DependencyConflict): string {
  const constraints = (conflict.constraints ?? []).map((c) => `${c.range} (from ${c.from})`);
  switch (conflict.kind) {
    case "cycle":
      return `dependency cycle: ${(conflict.chain ?? [conflict.id]).join(" -> ")}`;
    case "range_invalid":
      return `${conflict.id}: invalid range ${constraints.join(", ")}`;
    case "unsatisfiable": {
      const available = conflict.availableVersions ?? [];
      return `${conflict.id}: no version satisfies ${constraints.join(", ")}; available: ${
        available.length === 0 ? "none" : available.join(", ")
      }`;
    }
  }
}
