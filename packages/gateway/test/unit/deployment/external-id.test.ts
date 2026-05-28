import { describe, expect, test } from "bun:test";
import { computeDeploymentExternalId } from "../../../src/deployment/external-id.ts";
import type { DeploymentAnnotateInput } from "../../../src/deployment/types.ts";

const base: DeploymentAnnotateInput = {
  service: "payment-service",
  provider: "github-actions",
  environment: "prod",
  sha: "a1b2c3d",
  ref: "refs/heads/main",
  status: "success",
  started_at_ms: 1747142400000,
};

describe("computeDeploymentExternalId", () => {
  test("returns provider:run-X:job-Y when both run_id and job_id present", () => {
    expect(computeDeploymentExternalId({ ...base, run_id: "12345", job_id: "67890" })).toBe(
      "github-actions:run-12345:job-67890",
    );
  });

  test("returns provider:run-X when only run_id present", () => {
    expect(computeDeploymentExternalId({ ...base, run_id: "12345" })).toBe(
      "github-actions:run-12345",
    );
  });

  test("returns service:env:sha when neither run_id nor job_id present (drops started_at_ms)", () => {
    expect(computeDeploymentExternalId(base)).toBe("payment-service:prod:a1b2c3d");
  });

  test("job_id alone (without run_id) falls through to fallback tier", () => {
    expect(computeDeploymentExternalId({ ...base, job_id: "67890" })).toBe(
      "payment-service:prod:a1b2c3d",
    );
  });

  test("helper trusts the caller for sha case — does not lowercase", () => {
    expect(computeDeploymentExternalId({ ...base, sha: "A1B2C3D" })).toBe(
      "payment-service:prod:A1B2C3D",
    );
  });

  test("retries of the same shell-script deploy collapse onto one id", () => {
    const first = computeDeploymentExternalId({ ...base, started_at_ms: 1000 });
    const retry = computeDeploymentExternalId({ ...base, started_at_ms: 2000 });
    expect(first).toBe(retry);
  });
});
