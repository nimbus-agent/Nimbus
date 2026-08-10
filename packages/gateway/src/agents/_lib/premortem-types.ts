import type { GapNote } from "@nimbus-dev/sdk";

import type { CohortResult } from "../../premortem/cohort.ts";
import type { Risk } from "../../premortem/risks.ts";
import type { PremortemTheme } from "../../premortem/theme-store.ts";
import type { WatcherProposal } from "../../premortem/watcher-proposals.ts";

/** Request params. `--service` (repeatable) overrides derivation entirely — see premortem.ts. */
export type PremortemInput = {
  readonly epicRef: string;
  readonly serviceOverrides?: string[];
  /**
   * `nimbus pre-mortem <ref> --repropose` (Task 5): clear this epic's watcher-proposal
   * tombstones BEFORE the proposal path runs, so a deliberately-deleted proposal is
   * re-created fresh (paused) instead of staying `suppressed`. See
   * `premortem/watcher-proposals.ts`'s `clearProposalTombstones`.
   */
  readonly repropose?: boolean;
};

export type PremortemEpicView = {
  readonly itemId: string;
  readonly key: string;
  readonly title: string;
};

export type PremortemBrief = {
  readonly kind: "premortem";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: { readonly epicRef: string; readonly serviceOverrides: string[] | null };
  /** Null when the ref could not be resolved to a Jira epic (a non-Jira tracker prefix). */
  readonly epic: PremortemEpicView | null;
  /** `serviceOverrides` verbatim when given, else `affectedServicesForEpic`'s derivation. */
  readonly services: string[];
  readonly cohort: CohortResult;
  /** Empty when `services` is empty or the cohort has no members — never a fallback cohort. */
  readonly risks: Risk[];
  readonly themes: PremortemTheme[];
  readonly watchers: WatcherProposal[];
};
