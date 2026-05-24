// packages/cli/src/commands/serve.test.ts
//
// Unit tests for `nimbus serve` argv parser + early-return branches. The
// gateway spawn itself is covered by `lib/spawn-gateway.test.ts`; we test
// the dispatch decision layer here.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

const mod = await import("./serve.ts");
const { parseServeArgs, runServe, takeFlag } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("takeFlag", () => {
  it("returns the value following the flag", () => {
    expect(takeFlag(["--port", "1234"], "--port")).toBe("1234");
  });
  it("returns undefined when flag absent", () => {
    expect(takeFlag(["foo"], "--port")).toBeUndefined();
  });
  it("returns undefined when flag is last arg", () => {
    expect(takeFlag(["--port"], "--port")).toBeUndefined();
  });
});

describe("parseServeArgs", () => {
  it("returns help on `help`", () => {
    expect(parseServeArgs(["help"])).toEqual({ kind: "help" });
  });
  it("returns help on `--help`", () => {
    expect(parseServeArgs(["--help"])).toEqual({ kind: "help" });
  });
  it("returns help on `-h`", () => {
    expect(parseServeArgs(["-h"])).toEqual({ kind: "help" });
  });
  it("defaults to port 7474 when no flag and no env", () => {
    expect(parseServeArgs([])).toEqual({ kind: "serve", port: 7474 });
  });
  it("--port flag overrides default", () => {
    expect(parseServeArgs(["--port", "9000"])).toEqual({ kind: "serve", port: 9000 });
  });
  it("env NIMBUS_HTTP_PORT is used when --port absent", () => {
    expect(parseServeArgs([], "8888")).toEqual({ kind: "serve", port: 8888 });
  });
  it("--port flag beats env when both supplied", () => {
    expect(parseServeArgs(["--port", "1111"], "2222")).toEqual({ kind: "serve", port: 1111 });
  });
  it("env value is trimmed", () => {
    expect(parseServeArgs([], "  9090  ")).toEqual({ kind: "serve", port: 9090 });
  });
  it("rejects non-numeric port", () => {
    expect(() => parseServeArgs(["--port", "abc"])).toThrow(/Invalid port/);
  });
  it("rejects port 0", () => {
    expect(() => parseServeArgs(["--port", "0"])).toThrow(/Invalid port/);
  });
  it("rejects port > 65535", () => {
    expect(() => parseServeArgs(["--port", "70000"])).toThrow(/Invalid port/);
  });
});

describe("runServe dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help and returns early on `--help`", async () => {
    setFixture({});
    await runServe(["--help"]);
    expect(out.stdout).toContain("nimbus serve");
    expect(out.stdout).toContain("--port");
  });

  it("throws when gateway state is present + pid alive", async () => {
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock", pid: 1234 },
      processAlive: true,
    });
    await expect(runServe(["--port", "7474"])).rejects.toThrow(/already running/i);
  });
});
