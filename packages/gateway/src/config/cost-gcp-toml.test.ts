import { describe, expect, test } from "bun:test";

import { chooseGcpExportTable, DEFAULT_COST_GCP_CONFIG } from "./cost-gcp-toml.ts";
import { resolveCostConfig } from "./cost-toml.ts";
import { mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

const base = (text: string) =>
  resolveCostConfig(
    mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: "/x/0" }, text)]).sections,
  );
const gcp = (body: string) => base(`[cost.gcp]\n${body}\n`);
const DETAILED = "my-proj.billing.gcp_billing_export_resource_v1_01AB23_CD45EF_6789AB";
const STANDARD = "my-proj.billing.gcp_billing_export_v1_01AB23_CD45EF_6789AB";

describe("[cost.gcp]", () => {
  test("absent: nothing configured, the default byte cap", () => {
    expect(base("").gcp).toEqual(DEFAULT_COST_GCP_CONFIG);
    expect(DEFAULT_COST_GCP_CONFIG.maxBytesBilled).toBe(53_687_091_200);
  });

  test("one table, or two; the detailed one is preferred", () => {
    expect(gcp(`export_table = "${STANDARD}"`).gcp.exportTables).toEqual([STANDARD]);
    const two = gcp(`export_table = ["${STANDARD}", "${DETAILED}"]`);
    expect(two.error).toBeNull();
    expect(chooseGcpExportTable(two.gcp.exportTables)).toBe(DETAILED);
    expect(chooseGcpExportTable([STANDARD])).toBe(STANDARD);
    expect(chooseGcpExportTable([])).toBeNull();
  });

  test("max_bytes_billed within 1 GiB to 10 TiB", () => {
    expect(gcp("max_bytes_billed = 1073741824").gcp.maxBytesBilled).toBe(1_073_741_824);
    expect(gcp("max_bytes_billed = 10995116277760").error).toBeNull();
    expect(gcp("max_bytes_billed = 1073741823").error).toContain("max_bytes_billed");
    expect(gcp("max_bytes_billed = 10995116277761").error).toContain("max_bytes_billed");
    expect(gcp("max_bytes_billed = 2147483648.5").error).toContain("max_bytes_billed");
    expect(gcp('max_bytes_billed = "big"').error).toContain("max_bytes_billed");
  });

  test("refusals: names that could break out of the SQL, counts, duplicates, unknown keys", () => {
    for (const bad of [
      '"a.b.c`; DROP"',
      '"a.b"',
      '"a.b.c.d"',
      '"a b.c.d"',
      "5",
      "[]",
      `["${STANDARD}", "${STANDARD}"]`,
      '["a.b.c", "d.e.f", "g.h.i"]',
    ]) {
      expect(gcp(`export_table = ${bad}`).error).toContain("[cost.gcp].export_table");
    }
    expect(gcp("colour = 1").error).toContain('unknown key "colour"');
  });
});
