import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { captureOutput } from "../../test/helpers/cli-output.ts";

const helpMod = await import("./help.ts");
const { printHelp } = helpMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("printHelp", () => {
  beforeEach(() => {
    out.reset();
  });

  it("prints a header naming the CLI", () => {
    printHelp();
    expect(out.stdout).toContain("Nimbus CLI");
  });

  it("includes a Usage section", () => {
    printHelp();
    expect(out.stdout).toMatch(/Usage:/);
  });

  it("documents core lifecycle commands", () => {
    printHelp();
    expect(out.stdout).toContain("nimbus start");
    expect(out.stdout).toContain("nimbus stop");
    expect(out.stdout).toContain("nimbus status");
  });

  it("documents Phase 3.5 + Phase 4 commands", () => {
    printHelp();
    expect(out.stdout).toContain("nimbus config");
    expect(out.stdout).toContain("nimbus profile");
    expect(out.stdout).toContain("nimbus telemetry");
    expect(out.stdout).toContain("nimbus vault");
    expect(out.stdout).toContain("nimbus audit");
  });

  it("documents agent + CI/CD commands", () => {
    printHelp();
    expect(out.stdout).toContain("nimbus expert");
    expect(out.stdout).toContain("nimbus impact");
    expect(out.stdout).toContain("nimbus metrics dora");
    // `audit:readme-cli` only validates README→registry, so nothing else catches a command
    // that is registered and documented but missing from `nimbus help`. `nimbus stats` was.
    expect(out.stdout).toContain("nimbus stats");
    expect(out.stdout).toContain("nimbus deploy");
  });

  it("lists optional environment variables", () => {
    printHelp();
    expect(out.stdout).toContain("NIMBUS_GATEWAY_EXECUTABLE");
    expect(out.stdout).toContain("OPENAI_API_KEY");
  });

  it("writes nothing to stderr", () => {
    printHelp();
    expect(out.stderr).toBe("");
  });
});
