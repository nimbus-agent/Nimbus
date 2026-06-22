import { describe, expect, test } from "bun:test";
import {
  applyReportFieldPolicy,
  isPiiKey,
  pickAllowed,
  WORKER_ALLOWED_FIELDS,
} from "./workday-field-allowlist.ts";

describe("workday field allowlist", () => {
  test("pickAllowed keeps only allowlisted keys", () => {
    const row = { name: "Ada", title: "Eng", salary: 200000, ssn: "x", home_address: "y" };
    const out = pickAllowed(row, WORKER_ALLOWED_FIELDS);
    expect(out["name"]).toBe("Ada");
    expect(out["title"]).toBe("Eng");
    expect(out).not.toHaveProperty("salary");
    expect(out).not.toHaveProperty("ssn");
    expect(out).not.toHaveProperty("home_address");
  });

  test("pickAllowed skips undefined values", () => {
    const row: Record<string, unknown> = { name: undefined, title: "Eng" };
    const out = pickAllowed(row, WORKER_ALLOWED_FIELDS);
    expect(out).not.toHaveProperty("name");
    expect(out["title"]).toBe("Eng");
  });

  test("pickAllowed skips null values", () => {
    const row: Record<string, unknown> = { name: null, title: "Eng" };
    const out = pickAllowed(row, WORKER_ALLOWED_FIELDS);
    expect(out).not.toHaveProperty("name");
    expect(out["title"]).toBe("Eng");
  });

  test.each([
    "ssn",
    "national_id",
    "tax_id",
    "passport",
    "salary",
    "total_comp",
    "remuneration",
    "dob",
    "date_of_birth",
    "home_address",
    "medical_note",
    "bank_account",
    "routing_number",
    "iban",
    "gender",
    "ethnicity",
    // camelCase / no-separator variants must also be caught (RaaS columns are often camelCase)
    "homeAddress",
    "dateOfBirth",
    "personalEmail",
    "personalPhone",
    "nationalId",
    "totalComp",
  ])("isPiiKey flags %s", (k) => {
    expect(isPiiKey(k)).toBe(true);
  });

  test("isPiiKey allows benign keys", () => {
    expect(isPiiKey("org")).toBe(false);
    expect(isPiiKey("headcount")).toBe(false);
    expect(isPiiKey("employee_id")).toBe(false);
  });

  test("applyReportFieldPolicy: explicit fields win, else denylist applies", () => {
    const row = { employee_id: "e1", org: "Eng", salary: 1, ssn: "x" };
    expect(applyReportFieldPolicy(row, ["employee_id", "org"])).toEqual({
      employee_id: "e1",
      org: "Eng",
    });
    expect(applyReportFieldPolicy(row)).toEqual({ employee_id: "e1", org: "Eng" }); // salary+ssn dropped by denylist
  });

  test("applyReportFieldPolicy: a present-but-empty fields list is fail-closed (emits nothing)", () => {
    const row = { employee_id: "e1", ssn: "x" };
    // An explicit (present) but empty allowlist must NOT widen to the denylist — it emits
    // nothing, so a malformed/empty `fields` config can never broaden what is indexed.
    expect(applyReportFieldPolicy(row, [])).toEqual({});
  });

  test("applyReportFieldPolicy: denylist skips null/undefined values", () => {
    const row: Record<string, unknown> = { employee_id: "e1", org: null, team: undefined };
    const out = applyReportFieldPolicy(row);
    expect(out["employee_id"]).toBe("e1");
    expect(out).not.toHaveProperty("org");
    expect(out).not.toHaveProperty("team");
  });
});
