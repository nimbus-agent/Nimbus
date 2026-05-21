import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetMissingDependencyRegistry,
  missingDependencyRegistry,
} from "./missing-dependency-registry.ts";

beforeEach(() => _resetMissingDependencyRegistry());

describe("missingDependencyRegistry", () => {
  test("mark + reasonFor round-trip", () => {
    missingDependencyRegistry.mark({
      extensionId: "com.a",
      reason: "dependency_missing",
      missingDepId: "com.b",
      requiredRange: "^1.0.0",
    });
    expect(missingDependencyRegistry.has("com.a")).toBe(true);
    expect(missingDependencyRegistry.reasonFor("com.a")?.missingDepId).toBe("com.b");
  });

  test("clear removes the entry", () => {
    missingDependencyRegistry.mark({
      extensionId: "com.a",
      reason: "dependency_missing",
      missingDepId: "com.b",
      requiredRange: "^1.0.0",
    });
    missingDependencyRegistry.clear("com.a");
    expect(missingDependencyRegistry.has("com.a")).toBe(false);
  });

  test("all() returns sorted snapshot", () => {
    missingDependencyRegistry.mark({
      extensionId: "com.z",
      reason: "dependency_missing",
      missingDepId: "x",
      requiredRange: "*",
    });
    missingDependencyRegistry.mark({
      extensionId: "com.a",
      reason: "dependency_missing",
      missingDepId: "x",
      requiredRange: "*",
    });
    expect(missingDependencyRegistry.all().map((e) => e.extensionId)).toEqual(["com.a", "com.z"]);
  });

  test("count() reflects current size", () => {
    expect(missingDependencyRegistry.count()).toBe(0);
    missingDependencyRegistry.mark({
      extensionId: "com.x",
      reason: "dependency_unsatisfied",
      missingDepId: "com.y",
      requiredRange: "^2.0.0",
      observedVersion: "1.9.0",
    });
    expect(missingDependencyRegistry.count()).toBe(1);
  });

  test("reasonFor returns undefined for unknown id", () => {
    expect(missingDependencyRegistry.reasonFor("com.unknown")).toBeUndefined();
  });

  test("observedVersion is preserved in round-trip", () => {
    missingDependencyRegistry.mark({
      extensionId: "com.b",
      reason: "dependency_unsatisfied",
      missingDepId: "com.c",
      requiredRange: "^3.0.0",
      observedVersion: "2.5.0",
    });
    const entry = missingDependencyRegistry.reasonFor("com.b");
    expect(entry?.observedVersion).toBe("2.5.0");
    expect(entry?.reason).toBe("dependency_unsatisfied");
  });

  test("reset clears all entries", () => {
    missingDependencyRegistry.mark({
      extensionId: "com.a",
      reason: "dependency_missing",
      missingDepId: "com.b",
      requiredRange: "^1.0.0",
    });
    missingDependencyRegistry.mark({
      extensionId: "com.c",
      reason: "dependency_missing",
      missingDepId: "com.d",
      requiredRange: "^1.0.0",
    });
    expect(missingDependencyRegistry.count()).toBe(2);
    _resetMissingDependencyRegistry();
    expect(missingDependencyRegistry.count()).toBe(0);
    expect(missingDependencyRegistry.all()).toHaveLength(0);
  });
});
