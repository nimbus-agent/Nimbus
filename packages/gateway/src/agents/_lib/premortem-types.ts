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
  /** The human reference: a Jira key, or a Linear project's slug id (else its name); never a Linear UUID. */
  readonly key: string;
  readonly title: string;
  /** Present only for a Linear project; absent means a Jira epic. */
  readonly tracker?: "linear";
};

export type PremortemBrief = {
  readonly kind: "premortem";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: { readonly epicRef: string; readonly serviceOverrides: string[] | null };
  /** Null when the ref names a tracker pre-mortem does not cover (a foreign prefix); an unresolvable ref of a supported tracker throws instead. */
  readonly epic: PremortemEpicView | null;
  /** `serviceOverrides` verbatim when given, else `affectedServicesForEpic`'s derivation. */
  readonly services: string[];
  readonly cohort: CohortResult;
  /** Empty when `services` is empty or the cohort has no members — never a fallback cohort. */
  readonly risks: Risk[];
  readonly themes: PremortemTheme[];
  readonly watchers: WatcherProposal[];
};
