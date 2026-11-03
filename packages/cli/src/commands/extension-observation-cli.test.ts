import { describe, expect, test } from "bun:test";

import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { doctorPrintExtensionObservation } from "./doctor-core.ts";
import { runExtensionList } from "./extension.ts";

async function capture(fn: () => Promise<unknown>): Promise<{ lines: string[]; result: unknown }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (s: string) => {
    lines.push(s);
  };
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.log = orig;
  }
}

const notFound = Object.assign(new Error("Method not found"), { code: -32601 });
const list = { extensions: [{ id: "acme.tool", version: "1.0.0", enabled: 1 }] };
const audit = (id: string, findings: unknown) => ({
  extensions: [{ id, version: "1.0.0", findings, findingCount: 2 }],
});

describe("doctorPrintExtensionObservation", () => {
  test("warns and exits 1 on a finding", async () => {
    const ipc = createMockIpcClient([audit("acme.tool", { kind: "unmatched", count: 2 })]);
    const { lines, result } = await capture(() => doctorPrintExtensionObservation(ipc.client));
    expect(result).toBe(1);
    expect(lines[0]).toContain("2 address(es) not matched to a declared host");
    expect(ipc.calls[0]?.method).toBe("extension.audit");
  });
  test("quiet on an older gateway", async () => {
    const ipc = createMockIpcClient([notFound]);
    const { lines, result } = await capture(() => doctorPrintExtensionObservation(ipc.client));
    expect(result).toBe(0);
    expect(lines).toEqual([]);
  });
  test("another failure is a warn", async () => {
    const ipc = createMockIpcClient([new Error("boom")]);
    const { lines, result } = await capture(() => doctorPrintExtensionObservation(ipc.client));
    expect(result).toBe(1);
    expect(lines[0]).toContain("network observation check failed (boom)");
  });
  test("a hostile id is printed sanitised", async () => {
    const ipc = createMockIpcClient([
      audit("a\u001b[2Jb", { kind: "refused-undeclared", count: 2 }),
    ]);
    const { lines } = await capture(() => doctorPrintExtensionObservation(ipc.client));
    expect(lines).toEqual([
      "[warn] Extensions: a??2Jb 1.0.0: 2 undeclared name(s) looked up and refused (run nimbus extension audit a??2Jb)",
    ]);
  });
});

describe("extension list findings", () => {
  test("prints a tag line after the table, calling audit with no id", async () => {
    const ipc = createMockIpcClient([list, audit("acme.tool", { kind: "unmatched", count: 2 })]);
    const { lines } = await capture(() => runExtensionList(ipc.client, []));
    expect(lines.at(-1)).toBe("  acme.tool@1.0.0 [network: 2 unmatched address(es)]");
    expect(ipc.calls.map((c) => c.method)).toEqual(["extension.list", "extension.audit"]);
    expect(ipc.calls[1]?.params).toEqual({});
  });
  test("Linux wording", async () => {
    const ipc = createMockIpcClient([
      list,
      audit("acme.tool", { kind: "refused-undeclared", count: 5 }),
    ]);
    const { lines } = await capture(() => runExtensionList(ipc.client, []));
    expect(lines.at(-1)).toBe("  acme.tool@1.0.0 [network: 5 undeclared name(s) refused]");
  });
  test("quiet on method-not-found; table unchanged", async () => {
    const ipc = createMockIpcClient([list, notFound]);
    const { lines } = await capture(() => runExtensionList(ipc.client, []));
    expect(lines.join("\n")).not.toContain("network:");
    expect(ipc.calls.map((c) => c.method)).toEqual(["extension.list", "extension.audit"]);
    expect(lines.join("\n")).toContain("acme.tool");
  });
  test("a hostile id is sanitised in the tag line", async () => {
    const ipc = createMockIpcClient([
      { extensions: [{ id: "a\u001bb", version: "1.0.0", enabled: 1 }] },
      audit("a\u001bb", { kind: "unmatched", count: 1 }),
    ]);
    const { lines } = await capture(() => runExtensionList(ipc.client, []));
    expect(lines.at(-1)).toBe("  a?b@1.0.0 [network: 1 unmatched address(es)]");
  });
  test("--json adds networkFindings per row", async () => {
    const two = {
      extensions: [
        { id: "acme.tool", version: "1.0.0", enabled: 1 },
        { id: "acme.other", version: "1.0.0", enabled: 1 },
      ],
    };
    const ipc = createMockIpcClient([two, audit("acme.tool", { kind: "unmatched", count: 2 })]);
    const { lines } = await capture(() => runExtensionList(ipc.client, ["--json"]));
    const rows = JSON.parse(lines.join("\n")).extensions;
    expect(rows[0].networkFindings).toEqual({ kind: "unmatched", count: 2 });
    expect(rows[1].networkFindings).toBeNull();
  });
});
