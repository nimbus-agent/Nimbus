import { describe, expect, test } from "bun:test";
import {
  isKnownWatcherConditionType,
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
