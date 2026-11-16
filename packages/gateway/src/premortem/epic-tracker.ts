/**
 * The per-tracker description of an "epic" for pre-mortem: which `item` rows are epics, how a child
 * issue points back at its epic, and what human reference is shown for it. Pure: no DB, no config,
 * no network.
 *
 * Every field is a SQL FRAGMENT taking compile-time alias literals (`EpicAlias`), never caller data
 * (I9, the same rule as `prRepoExpr` in `agents/premortem.ts`). The fragments come from this closed
 * table of two trackers; nothing is built from input. A statement keeps ONE SQL text with a fragment
 * interpolated, so Jira's and Linear's reads can never drift into two copies.
 *
 * THE KEY RULE: the JOIN key is always `epic.external_id`, read from the epic ROW inside SQL, never a
 * string passed from a brief. The DISPLAY key (`displayKeySql`) is only rendered.
 *
 * Census note: the metadata keys named here (`issue_type`, `parent_key`, `project_id`, `slug_id`)
 * live in fragments that are not SELECT-shaped literals, so `audit:lane-census` cannot see them.
 * `epic-tracker.writer-pins.test.ts` seeds rows through the REAL writers and pins that each key
 * appears in its writer's source.
 */

export type EpicTrackerId = "jira" | "linear";

/** The only table aliases a fragment may name. */
export type EpicAlias = "item" | "epic" | "child";

export type EpicTracker = {
  readonly id: EpicTrackerId;
  /** `item.service` of this tracker's epics and children. */
  readonly service: EpicTrackerId;
  readonly epicNoun: "epic" | "project";
  readonly label: "Jira epic" | "Linear project";
  /** A WHERE fragment: the row aliased `a` is an epic-shaped row of this tracker (carries its own `service` test). */
  isEpicSql(a: EpicAlias): string;
  /**
   * A fragment for a join against an `item epic` alias: the row aliased `child` is a child issue of
   * the epic aliased `epic`. It reads `epic.external_id`, never a caller-supplied key.
   */
  childOfSql(c: "child", e: "epic"): string;
  /** A SELECT-list expression for the HUMAN reference of the epic row aliased `a`; never a Linear UUID. */
  displayKeySql(a: EpicAlias): string;
  /** The remediation that widens this tracker's indexed history. */
  readonly reindexHint: string;
};

export const JIRA_TRACKER: EpicTracker = {
  id: "jira",
  service: "jira",
  epicNoun: "epic",
  label: "Jira epic",
  isEpicSql: (a) =>
    `${a}.service = 'jira' AND json_valid(${a}.metadata) AND json_extract(${a}.metadata, '$.issue_type') = 'Epic'`,
  childOfSql: (c, e) => `json_extract(${c}.metadata, '$.parent_key') = ${e}.external_id`,
  displayKeySql: (a) => `${a}.external_id`,
  reindexHint: "nimbus index rebody --service jira --since <days>",
};

export const LINEAR_TRACKER: EpicTracker = {
  id: "linear",
  service: "linear",
  epicNoun: "project",
  label: "Linear project",
  isEpicSql: (a) => `${a}.service = 'linear' AND ${a}.type = 'project'`,
  childOfSql: (c, e) =>
    `${c}.type = 'issue' AND json_extract(${c}.metadata, '$.project_id') = ${e}.external_id`,
  displayKeySql: (a) =>
    `COALESCE(CASE WHEN json_valid(${a}.metadata) THEN json_extract(${a}.metadata, '$.slug_id') END, ${a}.title)`,
  reindexHint: "nimbus index rebody --service linear --since <days>",
};

export const EPIC_TRACKERS: readonly EpicTracker[] = [JIRA_TRACKER, LINEAR_TRACKER];

/** The descriptor for an `item.service`, or `undefined` for a service pre-mortem does not cover. */
export function trackerForService(service: string): EpicTracker | undefined {
  return EPIC_TRACKERS.find((t) => t.service === service);
}
