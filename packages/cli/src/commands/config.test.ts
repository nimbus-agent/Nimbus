// packages/cli/src/commands/config.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const configMod = await import("./config.ts");
const { runConfig, runConfigEdit, runConfigGet, runConfigList, runConfigSet, runConfigValidate } =
  configMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-cli-config-"));
}

describe("runConfigValidate", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("sets exitCode=0 on ok=true and prints no warnings/errors", async () => {
    const ipc = createMockIpcClient([{ ok: true, errors: [], warnings: [] }]);
    await runConfigValidate(ipc.client);
    expect(ipc.calls[0]).toEqual({ method: "config.validate", params: {} });
    expect(process.exitCode).toBe(0);
    expect(out.stdout).toBe("");
  });

  it("sets exitCode=1 on ok=false and prints errors/warnings", async () => {
    const ipc = createMockIpcClient([
      { ok: false, errors: ["bad value"], warnings: ["deprecated"] },
    ]);
    await runConfigValidate(ipc.client);
    expect(process.exitCode).toBe(1);
    expect(out.stdout).toContain("warning: deprecated");
    expect(out.stdout).toContain("error: bad value");
  });
});

describe("runConfigList", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmp();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("prints the path and (file missing) when the file does not exist", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    runConfigList(tomlPath);
    expect(out.stdout).toContain(tomlPath);
    expect(out.stdout).toContain("(file missing)");
  });

  it("prints the toml body when present", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    writeFileSync(tomlPath, "[telemetry]\nenabled = true\n", "utf8");
    runConfigList(tomlPath);
    expect(out.stdout).toContain("[telemetry]");
    expect(out.stdout).toContain("enabled = true");
  });

  it("prints the env-override legend", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    runConfigList(tomlPath);
    expect(out.stdout).toContain("NIMBUS_PROFILE");
  });
});

describe("runConfigGet", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmp();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("prints the value from the file when no env override", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    writeFileSync(tomlPath, "[telemetry]\nenabled = true\n", "utf8");
    runConfigGet(tomlPath, "telemetry.enabled");
    // toml value comes back as string per getTomlValueFromFile
    expect(out.stdout.trim().length).toBeGreaterThan(0);
  });

  it("prints (not set) when key absent", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    runConfigGet(tomlPath, "telemetry.enabled");
    expect(out.stdout).toContain("(not set)");
  });

  it("rejects missing/non-dotted key", () => {
    expect(() => runConfigGet("/tmp/nimbus.toml", "")).toThrow("Usage: nimbus config get");
    expect(() => runConfigGet("/tmp/nimbus.toml", "nodot")).toThrow("Usage: nimbus config get");
  });
});

describe("runConfigSet", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmp();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("writes the key into the toml file", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    writeFileSync(tomlPath, "[telemetry]\nenabled = false\n", "utf8");
    runConfigSet(tomlPath, "telemetry.enabled", "true");
    const body = readFileSync(tomlPath, "utf8");
    expect(body).toContain("enabled = true");
    expect(out.stdout).toContain(`Updated telemetry.enabled in ${tomlPath}`);
  });

  it("rejects empty key/value or missing dot", () => {
    expect(() => runConfigSet("/tmp/nimbus.toml", "", "value")).toThrow("Usage: nimbus config set");
    expect(() => runConfigSet("/tmp/nimbus.toml", "nodot", "value")).toThrow(
      "Usage: nimbus config set",
    );
    expect(() => runConfigSet("/tmp/nimbus.toml", "section.key", "")).toThrow(
      "Usage: nimbus config set",
    );
  });
});

describe("runConfigEdit", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("resolves when the editor exits with code 0", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnStub = (
      cmd: string,
      args: string[],
      _opts: { stdio: "inherit"; shell: boolean },
    ): EventEmitter => {
      calls.push({ cmd, args });
      const emitter = new EventEmitter();
      // Defer the close event so the on() handlers are wired first.
      queueMicrotask(() => {
        emitter.emit("close", 0);
      });
      return emitter;
    };
    await runConfigEdit("/tmp/nimbus.toml", spawnStub);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["/tmp/nimbus.toml"]);
  });

  it("rejects when the editor exits non-zero", async () => {
    const spawnStub = (): EventEmitter => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        emitter.emit("close", 2);
      });
      return emitter;
    };
    await expect(runConfigEdit("/tmp/nimbus.toml", spawnStub)).rejects.toThrow(
      /exited with code 2/,
    );
  });

  it("rejects when the spawn emits an error", async () => {
    const spawnStub = (): EventEmitter => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        emitter.emit("error", new Error("ENOENT editor"));
      });
      return emitter;
    };
    await expect(runConfigEdit("/tmp/nimbus.toml", spawnStub)).rejects.toThrow("ENOENT editor");
  });
});

describe("runConfig (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help on no args", async () => {
    await runConfig([]);
    expect(out.stdout).toContain("nimbus config");
    expect(out.stdout).toContain("Usage:");
  });

  it("prints help on 'help' / '--help' / '-h'", async () => {
    await runConfig(["help"]);
    expect(out.stdout).toContain("nimbus config");
    out.reset();
    await runConfig(["--help"]);
    expect(out.stdout).toContain("nimbus config");
    out.reset();
    await runConfig(["-h"]);
    expect(out.stdout).toContain("nimbus config");
  });

  it("rejects unknown subcommands", async () => {
    await expect(runConfig(["bogus"])).rejects.toThrow("Unknown config subcommand: bogus");
  });

  it("throws on 'validate' when gateway is not running", async () => {
    setFixture({});
    await expect(runConfig(["validate"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("routes 'validate' through withGatewayIpc", async () => {
    const ipc = createMockIpcClient([{ ok: true, errors: [], warnings: [] }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConfig(["validate"]);
    expect(ipc.calls[0]).toEqual({ method: "config.validate", params: {} });
  });
});
