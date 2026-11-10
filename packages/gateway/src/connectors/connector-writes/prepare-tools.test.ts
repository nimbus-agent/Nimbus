// packages/gateway/src/connectors/connector-writes/prepare-tools.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadOnlyToolId } from "../../share/read-tool-registry.ts";
import { isConnectorWriteToolId } from "../connector-write-registry.ts";
import { installedConnectorsPackageRoot } from "../testing/connector-write-registrations.ts";
import { isPrepareToolId, PREPARE_TOOL_IDS } from "./prepare-tools.ts";

const COMMIT_PREPARE_IDS = [
  "github_commit_prepare",
  "gitlab_commit_prepare",
  "iac_cloudformation_changeset_create",
  "iac_terraform_destroy_plan",
  "iac_terraform_plan",
  "iac_terraform_show_json",
  "k8s_manifest_plan",
] as const;

/** The connector directory (= mesh server) each prepare id is registered in. */
function serverOf(id: string): string {
  const head = id.split("_")[0] as string;
  return head === "k8s" ? "kubernetes" : head;
}

describe("PREPARE_TOOL_IDS (D0b, D1c)", () => {
  test("is exactly the seven prepare tools: two commits, four iac, and D3's manifest plan", () => {
    expect(PREPARE_TOOL_IDS.size).toBe(7);
    expect([...PREPARE_TOOL_IDS].sort()).toEqual([...COMMIT_PREPARE_IDS]);
  });

  test("is immutable: add, delete and clear throw", () => {
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).add("x_plan")).toThrow(TypeError);
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).delete("x")).toThrow(TypeError);
    expect(() => (PREPARE_TOOL_IDS as unknown as Set<string>).clear()).toThrow(TypeError);
    expect(PREPARE_TOOL_IDS.size).toBe(7);
  });

  test("the set interface answers like a seven-member set", () => {
    const seen: string[] = [];
    PREPARE_TOOL_IDS.forEach((v, v2, set) => {
      expect(v2).toBe(v);
      expect(set).toBe(PREPARE_TOOL_IDS);
      seen.push(v);
    });
    expect(seen.sort()).toEqual([...COMMIT_PREPARE_IDS]);
    expect([...PREPARE_TOOL_IDS.entries()].map(([a, b]) => [a, b]).sort()).toEqual(
      COMMIT_PREPARE_IDS.map((i) => [i, i]),
    );
    expect([...PREPARE_TOOL_IDS.keys()].sort()).toEqual([...COMMIT_PREPARE_IDS]);
    expect([...PREPARE_TOOL_IDS.values()].sort()).toEqual([...COMMIT_PREPARE_IDS]);
    expect(PREPARE_TOOL_IDS.has("github_commit_prepare")).toBe(true);
    expect(PREPARE_TOOL_IDS.has("github_files_get")).toBe(false);
    expect(PREPARE_TOOL_IDS.has("anything")).toBe(false);
  });

  test("every declared id is not a connector write id and not a read verb", () => {
    for (const id of PREPARE_TOOL_IDS) {
      expect(isConnectorWriteToolId(id), id).toBe(false);
      expect(isReadOnlyToolId(id), id).toBe(false);
    }
  });
});

describe("PREPARE_TOOL_IDS against the installed connectors package", () => {
  const root = installedConnectorsPackageRoot();
  const read = (...rel: string[]): string => readFileSync(join(root, ...rel), "utf8");

  test("equals the connector's own list (a third prepare tool fails the gateway until classified)", () => {
    const text = read("shared", "prepare-tool-ids.ts");
    const m = /export const PREPARE_TOOL_IDS = \[([^\]]*)\] as const;/.exec(text);
    expect(m).not.toBeNull();
    const ids = [...(m?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1] as string);
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual([...PREPARE_TOOL_IDS].sort());
  });

  test("each id is registered through the prepare registrar in its connector's server source", () => {
    const src: Record<string, string> = {
      github: read("connectors", "github", "src", "tools.ts"),
      gitlab: read("connectors", "gitlab", "src", "tools.ts"),
      iac: read("connectors", "iac", "src", "tools.ts"),
      kubernetes: read("connectors", "kubernetes", "src", "tools.ts"),
    };
    for (const id of PREPARE_TOOL_IDS) {
      const server = serverOf(id);
      const text = src[server];
      expect(text, id).toBeDefined();
      expect(text, id).toMatch(new RegExp(String.raw`registerPrepareTool\(\s*"${id}"`));
      // Registered once, and never also as a plain tool or a write.
      expect(text?.split(`"${id}"`).length, id).toBeLessThanOrEqual(3);
      expect(text, id).not.toMatch(new RegExp(String.raw`registerWriteTool\(\s*"${id}"`));
    }
  });
});

describe("isPrepareToolId", () => {
  const ids = new Set(["svc_plan"]);
  test("matches the bare id and the mesh key tail, and nothing else", () => {
    expect(isPrepareToolId("svc_plan", ids)).toBe(true);
    expect(isPrepareToolId("srv_svc_plan", ids)).toBe(true);
    expect(isPrepareToolId("svc_planner", ids)).toBe(false);
    expect(isPrepareToolId("svc_plan", PREPARE_TOOL_IDS)).toBe(false);
  });

  test("the real ids match bare and as the mesh key tail, and nothing longer", () => {
    for (const id of COMMIT_PREPARE_IDS) {
      const server = serverOf(id);
      expect(isPrepareToolId(id)).toBe(true);
      expect(isPrepareToolId(`${server}_${id}`)).toBe(true);
      expect(isPrepareToolId(`${id}s`)).toBe(false);
      expect(isPrepareToolId(`${id.replace(/_(prepare|plan|json|create)$/, "_get")}`)).toBe(false);
    }
    expect(isPrepareToolId("github_files_get")).toBe(false);
  });

  test("a mixed set: the iteration reaches every member", () => {
    const set = new Set(["a_one", "b_two"]);
    expect(isPrepareToolId("x_b_two", set)).toBe(true);
  });
});
