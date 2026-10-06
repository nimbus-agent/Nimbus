import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { parseAddMcpArgs } from "./connector-add-mcp-args.ts";

const C = resolve("some-cwd");
const USAGE = /Usage: nimbus connector add --mcp/;

describe("parseAddMcpArgs", () => {
  it("parses grants and a relative command after --", () => {
    const req = parseAddMcpArgs(
      ["mcp_x", "--read", "data", "--net", "api.x.com", "--model", "--", "./dist/x", "--flag"],
      C,
    );
    expect(req).toEqual({
      serviceId: "mcp_x",
      argv: [resolve(C, "./dist/x"), "--flag"],
      readPaths: [resolve(C, "data")],
      netHosts: ["api.x.com"],
      modelAccess: true,
    });
  });

  it("keeps the legacy form working and leaves a bare command bare", () => {
    expect(parseAddMcpArgs(["mcp_brave", "npx", "-y", "@some/mcp-server"], C)).toEqual({
      serviceId: "mcp_brave",
      argv: ["npx", "-y", "@some/mcp-server"],
      readPaths: [],
      netHosts: [],
      modelAccess: false,
    });
  });

  it("resolves relative-with-separator commands only", () => {
    expect(parseAddMcpArgs(["mcp_x", "--", "dist/x"], C).argv[0]).toBe(resolve(C, "dist/x"));
    expect(parseAddMcpArgs(["mcp_x", "--", "..\\x.exe"], C).argv[0]).toBe(resolve(C, "..\\x.exe"));
    expect(parseAddMcpArgs(["mcp_x", "--", "x"], C).argv[0]).toBe("x");
  });

  it("leaves an absolute command untouched and keeps a spaced path one token", () => {
    const abs = join(resolve("elsewhere"), "my dir", "bin");
    expect(parseAddMcpArgs(["mcp_x", "--", abs, "a b"], C).argv).toEqual([abs, "a b"]);
  });

  it("treats flag-looking tokens after -- as argv", () => {
    const req = parseAddMcpArgs(["mcp_x", "--", "npx", "--read", "foo"], C);
    expect(req.argv).toEqual(["npx", "--read", "foo"]);
    expect(req.readPaths).toEqual([]);
  });

  it("refuses malformed input with the usage text", () => {
    expect(() => parseAddMcpArgs([], C)).toThrow(USAGE);
    expect(() => parseAddMcpArgs(["mcp_x", "--read"], C)).toThrow(USAGE);
    expect(() => parseAddMcpArgs(["mcp_x", "--read", "--", "x"], C)).toThrow(USAGE);
    expect(() => parseAddMcpArgs(["mcp_x", "--bogus", "--", "x"], C)).toThrow(USAGE);
    expect(() => parseAddMcpArgs(["mcp_x", "--read", "d", "--"], C)).toThrow(USAGE);
    expect(() => parseAddMcpArgs(["mcp_x"], C)).toThrow(USAGE);
  });
});
