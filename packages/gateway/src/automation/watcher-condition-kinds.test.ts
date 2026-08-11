import { describe, expect, test } from "bun:test";
import {
  isKnownWatcherConditionType,
  supportsAffectedServiceFilter,
  WATCHER_CONDITION_KINDS,
  watcherConditionKind,
} from "./watcher-condition-kinds.ts";

describe("watcher-condition-kinds", () => {
  test("the table holds exactly the three supported condition types", () => {
    expect(WATCHER_CONDITION_KINDS.map((k) => k.conditionType).sort()).toEqual([
      "alert_fired",
      "deploy_failed",
      "incident_opened",
    ]);
  });

  test("each kind names the item type it matches", () => {
    expect(watcherConditionKind("alert_fired")?.itemType).toBe("alert");
    expect(watcherConditionKind("incident_opened")?.itemType).toBe("incident");
    expect(watcherConditionKind("deploy_failed")?.itemType).toBe("deployment");
  });

  test("alert_fired carries no extra predicate", () => {
    expect(watcherConditionKind("alert_fired")?.extraSql).toBe("");
  });

  test("incident_opened narrows to a triggered incident, and it is json_valid-guarded", () => {
    // Without this clause the condition also fires when an incident is acknowledged or resolved:
    // pagerduty-sync re-indexes on every `updated_at` change, not only on open.
    expect(watcherConditionKind("incident_opened")?.extraSql).toContain(
      "json_extract(metadata, '$.status') = 'triggered'",
    );
    expect(watcherConditionKind("incident_opened")?.extraSql).toContain("json_valid(metadata)");
  });

  test("deploy_failed narrows to a failed conclusion, and it is json_valid-guarded", () => {
    expect(watcherConditionKind("deploy_failed")?.extraSql).toContain("conclusion");
    // Pinned deliberately: without json_valid, a single non-JSON metadata row makes json_extract
    // raise and takes down evaluation for every watcher.
    expect(watcherConditionKind("deploy_failed")?.extraSql).toContain("json_valid(metadata)");
  });

  test("only the timeline-entity kinds support a filter.affectedService", () => {
    // `graph-populator.ts`'s `syncTimelineEventGraph` writes `metadata.affectedService` for
    // exactly these two entity types. `alert` has no populator branch at all, so accepting the
    // filter there would store a watcher that can never fire.
    expect(watcherConditionKind("incident_opened")?.affectedServiceEntityType).toBe("incident");
    expect(watcherConditionKind("deploy_failed")?.affectedServiceEntityType).toBe("deployment");
    expect(watcherConditionKind("alert_fired")?.affectedServiceEntityType).toBeNull();
  });

  test("supportsAffectedServiceFilter agrees with the entity-type column", () => {
    for (const kind of WATCHER_CONDITION_KINDS) {
      expect(supportsAffectedServiceFilter(kind)).toBe(kind.affectedServiceEntityType !== null);
    }
  });

  test("every affectedServiceEntityType names a real graph entity type, never an item type alias", () => {
    // Pinned because the two vocabularies coincide TODAY (`item.type` and the graph entity type
    // are both `incident`/`deployment`), which would let a future kind quietly reuse `itemType`
    // where a distinct entity type is required.
    for (const kind of WATCHER_CONDITION_KINDS) {
      if (kind.affectedServiceEntityType !== null) {
        expect(["incident", "deployment"]).toContain(kind.affectedServiceEntityType);
      }
    }
  });

  test("no extraSql fragment contains a bind placeholder", () => {
    // The engine binds exactly four positional parameters around this fragment. A `?` inside an
    // extraSql would consume one of them and silently misbind all four.
    for (const kind of WATCHER_CONDITION_KINDS) {
      expect(kind.extraSql).not.toContain("?");
    }
  });

  test("an unknown condition type resolves to undefined and is not known", () => {
    expect(watcherConditionKind("schedule")).toBeUndefined();
    expect(isKnownWatcherConditionType("schedule")).toBe(false);
    expect(isKnownWatcherConditionType("incident_opened")).toBe(true);
  });
});
