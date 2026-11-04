import { describe, expect, test } from "bun:test";

import { nonOsiLicenseIds, OSI_LICENSE_IDS } from "./osi-licenses.ts";

describe("nonOsiLicenseIds", () => {
  test.each([
    ["MIT", []],
    ["MIT OR Apache-2.0", []],
    ["GPL-2.0+", []],
    ["Apache-2.0 WITH LLVM-exception", []],
    ["LicenseRef-Acme-1.0", ["LicenseRef-Acme-1.0"]],
    ["MIT AND Proprietary-1", ["Proprietary-1"]],
    ["(BUSL-1.1 OR MIT)", ["BUSL-1.1"]],
    ["mit", ["mit"]],
    ["not a (valid", []],
  ])("%s", (expr, want) => {
    expect(nonOsiLicenseIds(expr)).toEqual(want);
  });

  test("the set has 43 ids", () => {
    expect(OSI_LICENSE_IDS.size).toBe(43);
  });
});
