import { describe, expect, test } from "bun:test";
import { rolePackDigest } from "@nimbus-dev/registry-format";
import { BUNDLED_PACKS } from "./bundled-packs.ts";
import { type InstalledPackRecord, parsePackRecord, serializePackRecord } from "./pack-record.ts";

const manifest = BUNDLED_PACKS.get("pm");
if (manifest === undefined) throw new Error("pm missing");
const good: InstalledPackRecord = {
  manifest,
  digest: rolePackDigest(manifest),
  source: { kind: "bundled" },
  installedAt: "2026-10-24T00:00:00.000Z",
};

describe("pack record", () => {
  test("round-trips", () => {
    expect(parsePackRecord(serializePackRecord(good))).toEqual(good);
    const file: InstalledPackRecord = { ...good, source: { kind: "file", path: "/x/pack.json" } };
    expect(parsePackRecord(serializePackRecord(file))).toEqual(file);
  });

  test("parsePackRecord refuses", () => {
    const obj = JSON.parse(serializePackRecord(good)) as Record<string, unknown>;
    const parses = (o: unknown): boolean =>
      parsePackRecord(typeof o === "string" ? o : JSON.stringify(o)) !== undefined;
    expect(parses("{nope")).toBe(false);
    expect(parses("null")).toBe(false);
    expect(parses({ ...obj, installedAt: undefined })).toBe(false);
    expect(parses({ ...obj, installedAt: 5 })).toBe(false);
    expect(parses({ ...obj, manifest: { schema: 2 } })).toBe(false);
    expect(parses({ ...obj, digest: "0".repeat(64) })).toBe(false);
    expect(parses({ ...obj, source: { kind: "registry" } })).toBe(false);
    expect(parses({ ...obj, source: { kind: "file", path: "" } })).toBe(false);
    expect(parses({ ...obj, source: "bundled" })).toBe(false);
  });
});
