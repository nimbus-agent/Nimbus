// `nimbus connector add --mcp ... --write <dir>` (Phase 28 AD5b-2): the flag, the request, the
// output from what the gateway STORED, and the message for a gateway that knows no write directory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { ADD_MCP_USAGE, parseAddMcpArgs } from "./connector-add-mcp-args.ts";
import { runConnectorAddMcp, type UserMcpDeps } from "./connector-user-mcp.ts";

const C = resolve("some-cwd");

describe("parseAddMcpArgs: --write", () => {
  test("a directory is resolved against the cwd; the flag repeats; other grants are untouched", () => {
    const req = parseAddMcpArgs(
      ["mcp_x", "--write", "out", "--read", "data", "--write", resolve("/abs/more"), "--", "node"],
      C,
    );
    expect(req).toEqual({
      serviceId: "mcp_x",
      argv: ["node"],
      readPaths: [resolve(C, "data")],
      netHosts: [],
      modelAccess: false,
      writePaths: [resolve(C, "out"), resolve("/abs/more")],
    });
  });

  test("with no --write the request has no writePaths key at all (the request it always was)", () => {
    const req = parseAddMcpArgs(["mcp_x", "--read", "data", "--", "node"], C);
    expect("writePaths" in req).toBe(false);
  });

  test("a missing value, an empty one and a flag in its place are usage errors", () => {
    for (const tail of [
      ["mcp_x", "--write"],
      ["mcp_x", "--write", "--", "node"],
      ["mcp_x", "--write", "", "--", "node"],
      ["mcp_x", "--write", "--read", "x", "--", "node"],
    ]) {
      expect(() => parseAddMcpArgs(tail, C)).toThrow(/Usage: nimbus connector add --mcp/);
    }
  });

  test("the usage text names the flag and says what it grants", () => {
    expect(ADD_MCP_USAGE).toContain("[--write <dir>]...");
    expect(ADD_MCP_USAGE).toContain("create and change files in (at most 4)");
    expect(ADD_MCP_USAGE).toContain("checks it again every time the server starts");
  });
});

describe("nimbus connector add --mcp --write", () => {
  type Sent = { method: string; params: unknown; opts: unknown };
  let sent: Sent[];
  let out: string[];
  let err: string[];
  let priorExit: typeof process.exitCode;

  beforeEach(() => {
    sent = [];
    out = [];
    err = [];
    priorExit = process.exitCode;
    process.exitCode = 0;
  });
  afterEach(() => {
    process.exitCode = priorExit ?? 0;
  });

  function deps(respond: () => unknown): UserMcpDeps {
    return {
      call: async (method, params, opts) => {
        sent.push({ method, params, opts });
        return respond();
      },
      log: (l) => out.push(l),
      error: (l) => err.push(l),
    };
  }

  const tail = ["mcp_x", "--write", "out", "--", "node"];
  const stored = resolve("/canonical/out");

  test("the request carries writePaths, on a connection that declares itself and answers as a person", async () => {
    await runConnectorAddMcp(
      tail,
      deps(() => ({
        ok: true,
        serviceId: "mcp_x",
        readPaths: [],
        netHosts: [],
        writePaths: [stored],
        modelAccess: false,
      })),
      C,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("connector.addMcp");
    expect(sent[0]?.params).toMatchObject({ writePaths: [resolve(C, "out")] });
    expect(sent[0]?.opts).toEqual({ asPerson: true });
  });

  test("the output is what the gateway STORED (its canonical path), never what was sent", async () => {
    await runConnectorAddMcp(
      tail,
      deps(() => ({
        ok: true,
        serviceId: "mcp_x",
        readPaths: [resolve("/canonical/data")],
        netHosts: ["api.x.com"],
        writePaths: [stored],
        modelAccess: true,
      })),
      C,
    );
    expect(out[0]).toBe("Registered user MCP connector: mcp_x");
    expect(out).toContain(`  read: ${resolve("/canonical/data")}`);
    expect(out).toContain("  net:  api.x.com");
    expect(out).toContain(`  write: ${stored}`);
    expect(out.join("\n")).not.toContain(resolve(C, "out"));
    expect(out.some((l) => l.includes("checks them again every time the server starts"))).toBe(
      true,
    );
    expect(out.some((l) => l.startsWith("  model: "))).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  test("a gateway that returns no writePaths: the registration is reported as WITHOUT one, exit 1", async () => {
    await runConnectorAddMcp(
      tail,
      deps(() => ({ ok: true, serviceId: "mcp_x" })),
      C,
    );
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("does not support write directories");
    expect(err[0]).toContain("registered WITHOUT one");
    expect(err[0]).toContain("nimbus connector remove mcp_x");
    expect(process.exitCode).toBe(1);
  });

  test("a registration with no --write is sent as before, with no person-only option, and prints no write line", async () => {
    await runConnectorAddMcp(
      ["mcp_x", "--read", "notes", "--", "node"],
      deps(() => ({ ok: true, serviceId: "mcp_x" })),
      C,
    );
    expect(sent[0]?.opts).toBeUndefined();
    expect(Object.keys((sent[0]?.params ?? {}) as object)).not.toContain("writePaths");
    expect(out.some((l) => l.startsWith("  write: "))).toBe(false);
    // An older gateway returns no lists: the read line falls back to the request, as it always did.
    expect(out).toContain(`  read: ${resolve(C, "notes")}`);
    expect(process.exitCode).toBe(0);
  });

  test("a denied prompt prints Refused and exits 2, with no grant line", async () => {
    await runConnectorAddMcp(
      tail,
      deps(() => ({ status: "rejected", reason: "owner denied" })),
      C,
    );
    expect(out).toEqual(["Refused: owner denied"]);
    expect(process.exitCode).toBe(2);
  });
});
