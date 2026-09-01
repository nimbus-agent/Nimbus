import type { GapNote } from "@nimbus-dev/sdk";

import type { OwnershipCoverage, OwnershipOwner } from "../../ownership/ownership-store.ts";

/** One ranked target — the requested path, its parent directory, or a service. */
export type OwnershipTargetView = {
  readonly kind: "source_file" | "directory" | "service";
  /** What to print: the root-relative path, `(repository root)`, or the service id. */
  readonly displayPath: string;
  readonly owners: OwnershipOwner[];
  readonly ownerCount: number | null;
  readonly ownersAboveFloor: number | null;
  readonly truncated: boolean | null;
};

/**
 * Exactly one of the three, or none for a coverage summary.
 *
 * `itemUrl` does NOT introduce a fourth target kind: the item is mapped to the service
 * it rolls up to, and answered by the SAME service lane a `service` request takes. That
 * is what keeps an item-scoped answer from ever diverging from a service-scoped one.
 */
export type OwnershipInput = {
  readonly path?: string;
  readonly service?: string;
  readonly itemUrl?: string;
};

export type OwnershipBrief = {
  readonly kind: "ownership";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: {
    readonly path: string | null;
    readonly service: string | null;
    /** The item the caller asked about, when they asked by item. A brief that cannot
     *  say what it was asked is not auditable. */
    readonly itemUrl: string | null;
  };
  /** Null in summary mode, and when a path resolved to no graph entity. */
  readonly target: OwnershipTargetView | null;
  readonly parentDirectory: OwnershipTargetView | null;
  readonly service: { readonly id: string } | null;
  readonly coverage: OwnershipCoverage;
};
