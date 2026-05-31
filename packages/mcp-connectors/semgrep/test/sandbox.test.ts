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
