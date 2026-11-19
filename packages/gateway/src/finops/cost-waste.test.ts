import { describe, expect, test } from "bun:test";
import { classifyWaste, isWasteKind, WASTE_KINDS } from "./cost-waste.ts";

const c = (recommendationType: string | null, category: string | null = null, title = "") =>
  classifyWaste({ recommendationType, category, title });

describe("classifyWaste", () => {
  test("each waste kind is reachable", () => {
    expect(c("aws:ebs:unattached_volume")).toBe("unattached");
    expect(c(null, null, "Release unassociated Elastic IP")).toBe("unattached");
    expect(c("idle_rds_instance")).toBe("idle");
    expect(c(null, "Unused load balancer")).toBe("idle");
    expect(c("old-ebs-snapshot")).toBe("orphaned_snapshot");
    expect(c(null, null, "Delete empty cluster in staging")).toBe("empty_environment");
  });

  test("a snapshot wins over unused, and an empty cluster over idle", () => {
    expect(c("unused_snapshot")).toBe("orphaned_snapshot");
    expect(c(null, null, "idle empty cluster")).toBe("empty_environment");
  });

  test("rightsizing and commitments are not waste even with a waste word", () => {
    expect(c("ec2_rightsizing", null, "Rightsize idle instances")).toBe("not_waste");
    expect(c("right-size", null, "idle")).toBe("not_waste");
    expect(c(null, null, "Buy a Savings Plan for unused capacity")).toBe("not_waste");
    expect(c("reserved_instance_purchase")).toBe("not_waste");
  });

  test("case, separators and empty input", () => {
    expect(c("UNATTACHED-VOLUME")).toBe("unattached");
    expect(c(null, null, "")).toBe("not_waste");
    expect(c("something_else")).toBe("not_waste");
  });

  test("isWasteKind", () => {
    for (const k of WASTE_KINDS) expect(isWasteKind(k)).toBe(true);
    expect(isWasteKind("not_waste")).toBe(false);
    expect(isWasteKind(3)).toBe(false);
  });
});
