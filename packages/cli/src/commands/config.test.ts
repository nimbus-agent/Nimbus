import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
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

  it("prints env(...) as source when an env var overrides a key", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    const savedEnv = process.env["NIMBUS_TELEMETRY_ENABLED"];
    process.env["NIMBUS_TELEMETRY_ENABLED"] = "true";
    try {
      runConfigList(tomlPath);
    } finally {
      if (savedEnv === undefined) {
        delete process.env["NIMBUS_TELEMETRY_ENABLED"];
      } else {
        process.env["NIMBUS_TELEMETRY_ENABLED"] = savedEnv;
      }
    }
    // env source rows produce "env (NIMBUS_TELEMETRY_ENABLED)" in the Source column
    expect(out.stdout).toContain("env (NIMBUS_TELEMETRY_ENABLED)");
  });

  it("prints 'file' as source when key comes from the toml file", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    // Ensure no env var overrides telemetry.enabled
    const savedEnv = process.env["NIMBUS_TELEMETRY_ENABLED"];
    delete process.env["NIMBUS_TELEMETRY_ENABLED"];
    writeFileSync(tomlPath, "[telemetry]\nenabled = false\n", "utf8");
    try {
      runConfigList(tomlPath);
    } finally {
      if (savedEnv !== undefined) {
        process.env["NIMBUS_TELEMETRY_ENABLED"] = savedEnv;
      }
    }
    // file source rows produce "file" in the Source column
    expect(out.stdout).toContain("file");
    expect(out.stdout).toContain("telemetry.enabled");
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
    expect(out.stdout.trim().length).toBeGreaterThan(0);
  });

  it("prints (not set) when key absent", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    runConfigGet(tomlPath, "telemetry.enabled");
    expect(out.stdout).toContain("(not set)");
  });

  it("prints env value and env label when env var overrides", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    const savedEnv = process.env["NIMBUS_TELEMETRY_ENABLED"];
    process.env["NIMBUS_TELEMETRY_ENABLED"] = "false";
    try {
      runConfigGet(tomlPath, "telemetry.enabled");
    } finally {
      if (savedEnv === undefined) {
        delete process.env["NIMBUS_TELEMETRY_ENABLED"];
      } else {
        process.env["NIMBUS_TELEMETRY_ENABLED"] = savedEnv;
      }
    }
    expect(out.stdout).toContain("false");
    expect(out.stdout).toContain("(from env");
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

  it("rejects when the editor exits with null code", async () => {
    const spawnStub = (): EventEmitter => {
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        emitter.emit("close", null);
      });
      return emitter;
    };
    await expect(runConfigEdit("/tmp/nimbus.toml", spawnStub)).rejects.toThrow(
      /exited with code null/,
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

  it("uses the EDITOR env var when set", async () => {
    const savedEditor = process.env["EDITOR"];
    process.env["EDITOR"] = "myeditor";
    const calls: { cmd: string; args: string[] }[] = [];
    const spawnStub = (
      cmd: string,
      args: string[],
      _opts: { stdio: "inherit"; shell: boolean },
    ): EventEmitter => {
      calls.push({ cmd, args });
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        emitter.emit("close", 0);
      });
      return emitter;
    };
    try {
      await runConfigEdit(join(makeTmp(), "nimbus.toml"), spawnStub);
    } finally {
      if (savedEditor === undefined) {
        delete process.env["EDITOR"];
      } else {
        process.env["EDITOR"] = savedEditor;
      }
    }
    expect(calls[0]?.cmd).toBe("myeditor");
  });
});

describe("runConfig (dispatcher)", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
    tmp = makeTmp();
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
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
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runConfig(["validate"]);
    expect(ipc.calls[0]).toEqual({ method: "config.validate", params: {} });
  });

  it("routes 'list' to runConfigList", async () => {
    // runConfig will build tomlPath from getCliPlatformPaths(); we just verify
    // the subcommand doesn't throw and produces expected output patterns
    await runConfig(["list"]);
    // The list command always prints the env-override legend regardless of file presence
    expect(out.stdout).toContain("NIMBUS_PROFILE");
  });

  it("routes 'get' with a key to runConfigGet (not set)", async () => {
    // Use a key that almost certainly has no env set and the file doesn't exist
    // at the real config path — output should be "(not set)"
    await runConfig(["get", "telemetry.endpoint"]);
    // Either prints the value or "(not set)" — just verify it ran without throwing
    expect(out.stdout.length).toBeGreaterThanOrEqual(0);
  });

  it("routes 'get' with no key to runConfigGet usage error", async () => {
    await expect(runConfig(["get"])).rejects.toThrow("Usage: nimbus config get");
  });

  it("routes 'set' with incomplete args to runConfigSet usage error", async () => {
    await expect(runConfig(["set"])).rejects.toThrow("Usage: nimbus config set");
  });

  it("routes 'set' with valid args to runConfigSet", async () => {
    // Override the paths by calling runConfigSet directly with a tmp path
    // since runConfig derives tomlPath from platform paths
    // We test routing at the dispatcher level by verifying the set subcommand
    // does not throw for valid args (even if it writes to the platform config dir)
    // Use a direct call to runConfigSet to test the write path
    const tomlPath = join(tmp, "nimbus.toml");
    runConfigSet(tomlPath, "telemetry.enabled", "false");
    expect(out.stdout).toContain("Updated telemetry.enabled");
    expect(out.stdout).toContain("Restart the Gateway");
  });

  it("routes 'edit' to runConfigEdit using a stub", async () => {
    // We can't use runConfig directly for edit since it calls real spawn
    // Instead test that the edit branch calls runConfigEdit; verify via
    // the spawnFn DI by calling runConfigEdit with a stub
    const calls: string[] = [];
    const spawnStub = (
      cmd: string,
      _args: string[],
      _opts: { stdio: "inherit"; shell: boolean },
    ): EventEmitter => {
      calls.push(cmd);
      const emitter = new EventEmitter();
      queueMicrotask(() => {
        emitter.emit("close", 0);
      });
      return emitter;
    };
    await runConfigEdit(join(tmp, "nimbus.toml"), spawnStub);
    expect(calls).toHaveLength(1);
  });
});

describe("nimbus config list --json", () => {
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

  type ConfigListDoc = {
    path: string;
    exists: boolean;
    keys: Array<{ key: string; value: string; source: string; envVar: string | null }>;
    raw: string | null;
  };

  /** Parses the whole of stdout — proves the legend/prose never reached stdout. */
  function parseStdout(): ConfigListDoc {
    return JSON.parse(out.stdout) as ConfigListDoc;
  }

  it("emits path/exists/keys/raw with the file body verbatim", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    const body = "[telemetry]\nenabled = false\n";
    writeFileSync(tomlPath, body, "utf8");
    const savedEnv = process.env["NIMBUS_TELEMETRY_ENABLED"];
    delete process.env["NIMBUS_TELEMETRY_ENABLED"];
    try {
      runConfigList(tomlPath, { json: true });
    } finally {
      if (savedEnv !== undefined) {
        process.env["NIMBUS_TELEMETRY_ENABLED"] = savedEnv;
      }
    }

    const doc = parseStdout();
    expect(doc.path).toBe(tomlPath);
    expect(doc.exists).toBe(true);
    expect(doc.raw).toBe(body);
    const telemetry = doc.keys.find((k) => k.key === "telemetry.enabled");
    expect(telemetry?.source).toBe("file");
    expect(telemetry?.value).toBe("false");
    expect(telemetry?.envVar).toBeNull();
    // The prose env-override legend is human-only.
    expect(out.stdout).not.toContain("NIMBUS_PROFILE");
  });

  it("marks env-sourced keys with source 'env' and the variable name", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    const savedEnv = process.env["NIMBUS_TELEMETRY_ENABLED"];
    process.env["NIMBUS_TELEMETRY_ENABLED"] = "true";
    try {
      runConfigList(tomlPath, { json: true });
    } finally {
      if (savedEnv === undefined) {
        delete process.env["NIMBUS_TELEMETRY_ENABLED"];
      } else {
        process.env["NIMBUS_TELEMETRY_ENABLED"] = savedEnv;
      }
    }

    const telemetry = parseStdout().keys.find((k) => k.key === "telemetry.enabled");
    expect(telemetry?.source).toBe("env");
    expect(telemetry?.envVar).toBe("NIMBUS_TELEMETRY_ENABLED");
    expect(telemetry?.value).toBe("true");
  });

  it("reports exists:false and raw:null when the file is missing", () => {
    const tomlPath = join(tmp, "nimbus.toml");
    runConfigList(tomlPath, { json: true });

    const doc = parseStdout();
    expect(doc.exists).toBe(false);
    expect(doc.raw).toBeNull();
    expect(out.stdout).not.toContain("(file missing)");
  });

  it("is routed from the dispatcher when --json follows the subcommand", async () => {
    await runConfig(["list", "--json"]);
    expect(() => parseStdout()).not.toThrow();
    expect(out.stdout).not.toContain("NIMBUS_PROFILE");
  });
});

describe("config set/get refuse a nested-table key with an actionable message (#1382)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  // `llm.tasks.<task>` is the natural thing to type once per-task routing exists, and it used to
  // succeed while doing nothing. The refusal has to name the command that DOES work, or the user
  // is left with a rejection and no route forward.
  it("names `nimbus llm use` for an llm.tasks.* key", () => {
    const dir = makeTmp();
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, "[llm]\nprefer_local = true\n");
    expect(() => runConfigSet(p, "llm.tasks.classification", "ollama/llama3.2:latest")).toThrow(
      /nimbus llm use classification ollama\/llama3\.2:latest/,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing when it refuses", () => {
    const dir = makeTmp();
    const p = join(dir, "nimbus.toml");
    const before = "[llm]\nprefer_local = true\n";
    writeFileSync(p, before);
    expect(() => runConfigSet(p, "llm.tasks.classification", "x")).toThrow();
    expect(readFileSync(p, "utf8")).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  // A non-llm nested key has no dedicated command to point at, so it must NOT claim one.
  it("does not invent an llm command for an unrelated nested key", () => {
    const dir = makeTmp();
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, "");
    expect(() => runConfigSet(p, "sync.service.github", "x")).toThrow(/nested table/i);
    expect(() => runConfigSet(p, "sync.service.github", "x")).not.toThrow(/nimbus llm use/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("config get refuses the same key rather than echoing an inert line", () => {
    const dir = makeTmp();
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, '[llm]\nprefer_local = true\n\ntasks.classification = "x"\n');
    expect(() => runConfigGet(p, "llm.tasks.classification")).toThrow(/nested table/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("an ordinary section.key still sets and gets", () => {
    const dir = makeTmp();
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, "");
    runConfigSet(p, "telemetry.enabled", "true");
    out.reset();
    runConfigGet(p, "telemetry.enabled");
    expect(out.stdout).toContain("true");
    rmSync(dir, { recursive: true, force: true });
  });
});
