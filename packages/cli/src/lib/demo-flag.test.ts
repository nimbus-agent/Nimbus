import { describe, expect, test } from "bun:test";

import { applyDemoFlag, DEMO_FLAG } from "./demo-flag.ts";
import { GatewayNotRunningError } from "./with-gateway-ipc.ts";

describe("applyDemoFlag", () => {
  test("without the flag: argv unchanged, env untouched", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["oncall", "--json"], env)).toEqual(["oncall", "--json"]);
    expect(env["NIMBUS_DEMO"]).toBeUndefined();
  });

  test("a leading --demo is stripped so the next token is the command", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag([DEMO_FLAG, "oncall"], env)).toEqual(["oncall"]);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("--demo anywhere is stripped, every occurrence", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["status", DEMO_FLAG, "--json", DEMO_FLAG], env)).toEqual([
      "status",
      "--json",
    ]);
  });

  test("the flag wins over a pre-existing NIMBUS_DEMO=0", () => {
    const env: NodeJS.ProcessEnv = { NIMBUS_DEMO: "0" };
    applyDemoFlag([DEMO_FLAG, "status"], env);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("a token that merely CONTAINS --demo is an argument, not the flag", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["ask", "what does --demo do"], env)).toEqual([
      "ask",
      "what does --demo do",
    ]);
    expect(env["NIMBUS_DEMO"]).toBeUndefined();
  });

  test("the `demo` subcommand itself implies the demo root, with no --demo flag", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["demo"], env)).toEqual(["demo"]);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("a `demo` subcommand's own arguments are preserved", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["demo", "stop"], env)).toEqual(["demo", "stop"]);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("a leading --demo before `demo` is stripped same as any other command", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["--demo", "demo"], env)).toEqual(["demo"]);
    expect(env["NIMBUS_DEMO"]).toBe("1");
  });

  test("a command that is merely named `status` does not imply the demo root", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDemoFlag(["status"], env)).toEqual(["status"]);
    expect(env["NIMBUS_DEMO"]).toBeUndefined();
  });
});

describe("GatewayNotRunningError", () => {
  test("the default message is unchanged", () => {
    expect(new GatewayNotRunningError().message).toBe(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  test("in demo mode it points at the DEMO gateway, never the real one", () => {
    const m = new GatewayNotRunningError({ demo: true }).message;
    expect(m).toContain("Gateway is not running");
    expect(m).toContain("nimbus --demo start");
    expect(m).not.toContain("Start with: nimbus start");
  });
});
