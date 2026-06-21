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
});
