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

  test("only deploy_failed carries an extra predicate, and it is json_valid-guarded", () => {
    expect(watcherConditionKind("alert_fired")?.extraSql).toBe("");
    expect(watcherConditionKind("incident_opened")?.extraSql).toBe("");
    expect(watcherConditionKind("deploy_failed")?.extraSql).toContain("conclusion");
    // Pinned deliberately: without json_valid, a single non-JSON metadata row makes json_extract
    // raise and takes down evaluation for every watcher.
    expect(watcherConditionKind("deploy_failed")?.extraSql).toContain("json_valid(metadata)");
  });

  test("an unknown condition type resolves to undefined and is not known", () => {
    expect(watcherConditionKind("schedule")).toBeUndefined();
    expect(isKnownWatcherConditionType("schedule")).toBe(false);
    expect(isKnownWatcherConditionType("incident_opened")).toBe(true);
  });
});
