import { describe, expect, it } from "bun:test";
import { platform } from "node:os";
import { createSandboxRunner } from "./sandbox-runner.ts";

describe("createSandboxRunner", () => {
  it("returns a runner matching the current platform", async () => {
    const runner = await createSandboxRunner();
    expect(runner.platform).toBe(platform() as "linux" | "darwin" | "win32");
  });

  it("exposes the SandboxRunner shape", async () => {
    const runner = await createSandboxRunner();
    expect(typeof runner.spawn).toBe("function");
    expect(typeof runner.isFullyActive).toBe("function");
    expect(typeof runner.degradedReason).toBe("function");
  });
});
