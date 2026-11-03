import { describe, expect, test } from "bun:test";

import {
  doctorObservationLines,
  listObservationLines,
  parseObservationFindings,
} from "./extension-observation-format.ts";

const audit = (findings: unknown, id = "acme.tool", version = "1.0.0") => ({
  extensions: [{ id, version, findings, findingCount: 1 }],
});

describe("doctorObservationLines", () => {
  test("Linux wording", () => {
    const r = doctorObservationLines(audit({ kind: "refused-undeclared", count: 3 }));
    expect(r.lines).toEqual([
      "[warn] Extensions: acme.tool 1.0.0: 3 undeclared name(s) looked up and refused (run nimbus extension audit acme.tool)",
    ]);
    expect(r.exit).toBe(1);
  });
  test("Windows/macOS wording", () => {
    const r = doctorObservationLines(audit({ kind: "unmatched", count: 2 }));
    expect(r.lines).toEqual([
      "[warn] Extensions: acme.tool 1.0.0: 2 address(es) not matched to a declared host (run nimbus extension audit acme.tool)",
    ]);
    expect(r.exit).toBe(1);
  });
  test("no findings, malformed input: quiet, exit 0", () => {
    expect(doctorObservationLines(audit(null))).toEqual({ lines: [], exit: 0 });
    expect(doctorObservationLines(undefined)).toEqual({ lines: [], exit: 0 });
    expect(doctorObservationLines({ extensions: [null, { id: 1 }] })).toEqual({
      lines: [],
      exit: 0,
    });
    expect(parseObservationFindings(audit({ kind: "unmatched", count: 0 }))).toEqual([]);
    expect(parseObservationFindings(audit({ kind: "other", count: 2 }))).toEqual([]);
  });
  test("control characters in id and version are sanitised", () => {
    const r = doctorObservationLines(
      audit({ kind: "unmatched", count: 1 }, "ac\u001b[31mme", "1\n.0"),
    );
    expect(r.lines[0]).not.toContain("\u001b");
    expect(r.lines[0]).not.toContain("\n");
    expect(r.lines[0]).toContain("ac??31mme 1?.0:");
  });
});

describe("listObservationLines", () => {
  test("both wordings, sanitised", () => {
    const lines = listObservationLines([
      ...parseObservationFindings(audit({ kind: "refused-undeclared", count: 4 })),
      ...parseObservationFindings(audit({ kind: "unmatched", count: 1 }, "b\u001bx", "2.0.0")),
    ]);
    expect(lines).toEqual([
      "  acme.tool@1.0.0 [network: 4 undeclared name(s) refused]",
      "  b?x@2.0.0 [network: 1 unmatched address(es)]",
    ]);
  });
});
