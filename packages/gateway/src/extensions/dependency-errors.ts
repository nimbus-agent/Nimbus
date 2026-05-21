import type { DependencyConflict } from "./dependency-types.ts";

/** Thrown by the solver when the closure cannot be satisfied (cycle / unsatisfiable / range_invalid). */
export class DependencyConflictError extends Error {
  readonly conflict: DependencyConflict;

  constructor(conflict: DependencyConflict) {
    super(`dependency_conflict:${conflict.kind}:${conflict.id}`);
    this.name = "DependencyConflictError";
    this.conflict = conflict;
  }
}

/** Thrown when the solver cannot reach the registry to resolve a missing dep. */
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

/** Thrown by `extension.remove` when one or more installed extensions still depend on the target and `force` was not set. */
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

/** Type-narrowing helpers — never use `instanceof` across module boundaries. */
export function isDependencyConflictError(e: unknown): e is DependencyConflictError {
  return e instanceof Error && (e as Error).name === "DependencyConflictError";
}

export function isOfflineDependencyResolutionError(
  e: unknown,
): e is OfflineDependencyResolutionError {
  return e instanceof Error && (e as Error).name === "OfflineDependencyResolutionError";
}

export function isReverseDepBlockedError(e: unknown): e is ReverseDepBlockedError {
  return e instanceof Error && (e as Error).name === "ReverseDepBlockedError";
}
