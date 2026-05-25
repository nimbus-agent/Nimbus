// Sandbox contract test — verifies the declared manifest permissions match
// runtime enforcement when this connector is spawned under the gateway's
// sandbox runner.
//
// Gated on NIMBUS_TEST_HARNESS because `runSandboxContractTests` expects the
// probe to run inside a sandbox-wrapped process. dbt Cloud joins the same
// deferred-harness queue as Snyk / SonarQube / Semgrep / Wiz / LaunchDarkly /
// Flagsmith.

import { describe, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await runSandboxContractTests(manifestPath);
  });
});
