import { describe, expect, test } from "bun:test";
import {
  IAC_CLOUD_ENV_NAMES,
  iacCfnHosts,
  iacTerraformHosts,
  isSafeIacRegion,
  isValidIacExtraHost,
} from "./iac-clouds.ts";

describe("iac clouds: the hosts and variable names an approval means", () => {
  test("each cloud grants its own hosts and nothing else", () => {
    expect(iacTerraformHosts([])).toEqual([]);
    expect(iacTerraformHosts(["aws"])).toContain("sts.amazonaws.com");
    expect(iacTerraformHosts(["aws"])).not.toContain("management.azure.com");
    expect(iacTerraformHosts(["azure"])).toEqual([
      "management.azure.com",
      "login.microsoftonline.com",
    ]);
    expect(iacTerraformHosts(["gcp"])).toEqual(["oauth2.googleapis.com", "www.googleapis.com"]);
    expect(iacTerraformHosts(["aws", "azure", "gcp"]).length).toBe(
      iacTerraformHosts(["aws"]).length + 2 + 2,
    );
  });

  test("the variable names are names, never values, and every cloud has some", () => {
    for (const cloud of ["aws", "azure", "gcp"] as const) {
      expect(IAC_CLOUD_ENV_NAMES[cloud].length).toBeGreaterThan(0);
      for (const n of IAC_CLOUD_ENV_NAMES[cloud]) expect(n).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  test("a CloudFormation region maps to its endpoints, China to its own suffix, junk to nothing", () => {
    expect(iacCfnHosts("us-east-1")).toEqual([
      "cloudformation.us-east-1.amazonaws.com",
      "sts.us-east-1.amazonaws.com",
      "sts.amazonaws.com",
    ]);
    expect(iacCfnHosts("cn-north-1")[0]).toBe("cloudformation.cn-north-1.amazonaws.com.cn");
    expect(iacCfnHosts("")).toEqual([]);
    expect(iacCfnHosts("us-east-1.evil.example")).toEqual([]);
    expect(iacCfnHosts("US-EAST-1")).toEqual([]);
  });

  test("a region is a plain lower-case name", () => {
    expect(isSafeIacRegion("eu-west-2")).toBe(true);
    expect(isSafeIacRegion("")).toBe(false);
    expect(isSafeIacRegion("-x")).toBe(false);
    expect(isSafeIacRegion("a".repeat(65))).toBe(false);
  });

  test("an extra host is a plain lower-case host with an optional port in range", () => {
    for (const ok of ["example.com", "state.example.com:8443", "a", "10.0.0.1:1", "h:65535"]) {
      expect(isValidIacExtraHost(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "Example.com",
      "*.example.com",
      "https://example.com",
      "example.com/path",
      "a..b",
      "-a.com",
      "a.com-",
      "h:0",
      "h:65536",
      "h:123456",
      "h:",
      "[::1]",
      `${"a".repeat(254)}`,
    ]) {
      expect(isValidIacExtraHost(bad), bad).toBe(false);
    }
  });
});
