import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCliOkThrowing } from "../shared/run-cli-json.ts";

describe("terraform CLI mock (argv)", () => {
  test("mock terraform plan and apply succeed", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "nimbus-tf-mock-bin-"));
    const workDir = mkdtempSync(join(tmpdir(), "nimbus-tf-mock-work-"));
    mkdirSync(workDir, { recursive: true });

    if (process.platform === "win32") {
      writeFileSync(join(binDir, "terraform.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8");
    } else {
      const tf = join(binDir, "terraform");
      writeFileSync(tf, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(tf, 0o755);
    }

    const tfBin = join(binDir, process.platform === "win32" ? "terraform.cmd" : "terraform");
    const env: Record<string, string | undefined> = { ...process.env };

    await runCliOkThrowing([tfBin, "-chdir", workDir, "plan", "-input=false"], env);
    await runCliOkThrowing(
      [tfBin, "-chdir", workDir, "apply", "-auto-approve", "-input=false"],
      env,
    );
    expect(true).toBe(true);
  });
});
