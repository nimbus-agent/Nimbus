import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_WORKDAY_TOML, parseNimbusWorkdayToml } from "./nimbus-toml-workday.ts";

describe("parseNimbusWorkdayToml", () => {
  test("defaults when section absent", () => {
    expect(parseNimbusWorkdayToml("")).toEqual(DEFAULT_NIMBUS_WORKDAY_TOML);
  });

  test("parses time_off_history_days + an array of reports", () => {
    const src = [
      "[connectors.workday]",
      "time_off_history_days = 90",
      "[[connectors.workday.reports]]",
      'label = "headcount"',
      'url = "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Headcount?format=json"',
      'key_field = "employee_id"',
      'fields = ["employee_id", "org"]',
      "[[connectors.workday.reports]]",
      'label = "open-positions"',
      'url = "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Open?format=json"',
    ].join("\n");
    const cfg = parseNimbusWorkdayToml(src);
    expect(cfg.timeOffHistoryDays).toBe(90);
    expect(cfg.reports).toHaveLength(2);
    expect(cfg.reports[0]).toEqual({
      label: "headcount",
      url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Headcount?format=json",
      keyField: "employee_id",
      fields: ["employee_id", "org"],
    });
    expect(cfg.reports[1]).toEqual({
      label: "open-positions",
      url: "https://wd5.workday.com/ccx/service/customreport2/acme/ISU/Open?format=json",
    });
  });

  test("drops a report missing label or url", () => {
    const src = ["[[connectors.workday.reports]]", 'label = "no-url"'].join("\n");
    expect(parseNimbusWorkdayToml(src).reports).toEqual([]);
  });

  test("preserves a present-but-empty fields array (fail-closed, not dropped to undefined)", () => {
    // A config that supplies an explicit empty `fields = []` must round-trip as `fields: []`
    // so applyReportFieldPolicy fails closed (emits nothing) rather than widening to the denylist.
    const src = [
      "[[connectors.workday.reports]]",
      'label = "empty-fields"',
      'url = "https://wd5.workday.com/x"',
      "fields = []",
    ].join("\n");
    const cfg = parseNimbusWorkdayToml(src);
    expect(cfg.reports).toHaveLength(1);
    expect(cfg.reports[0]).toEqual({
      label: "empty-fields",
      url: "https://wd5.workday.com/x",
      fields: [],
    });
    expect(Object.hasOwn(cfg.reports[0] as object, "fields")).toBe(true);
  });

  test("a malformed fields value parses to an empty list (parse-failure catch arm, fail-closed)", () => {
    // An unparseable `fields` value must not throw and must not drop to undefined; the catch
    // arm sets it to [] so the report stays fail-closed.
    const src = [
      "[[connectors.workday.reports]]",
      'label = "bad-fields"',
      'url = "https://wd5.workday.com/y"',
      "fields = [unterminated",
    ].join("\n");
    const cfg = parseNimbusWorkdayToml(src);
    expect(cfg.reports).toHaveLength(1);
    expect(cfg.reports[0]?.fields).toEqual([]);
  });

  test("omits keyField when key_field is present but empty", () => {
    const src = [
      "[[connectors.workday.reports]]",
      'label = "blank-key"',
      'url = "https://wd5.workday.com/z"',
      'key_field = ""',
    ].join("\n");
    const cfg = parseNimbusWorkdayToml(src);
    expect(cfg.reports[0]).toEqual({
      label: "blank-key",
      url: "https://wd5.workday.com/z",
    });
    expect(cfg.reports[0]).not.toHaveProperty("keyField");
  });
});
