// Phase 10 SA2 (spec § 5.1): `provenance` on a PlannedAction is constructed ONLY in
// `automation/workflow-write-step.ts`. This source pin is the check until the standing-approval
// static rule (D44(a), SA3) takes it over: no IPC method, door, ChatOps path, LAN, HTTP or payload
// builder names the provenance shape, so none can supply one. The two other files that name it
// only READ it (the type, and the audit row's trimmed copy).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { stripComments } from "../../../../scripts/structure-audit/lib.ts";

const SRC = join(import.meta.dir, "..");
const CONSTRUCTOR = "automation/workflow-write-step.ts";
const READERS = ["engine/types.ts", "engine/executor.ts"];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.includes(".test-helpers")
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return relative(SRC, file).replaceAll("\\", "/");
}

describe("provenance is constructed only by the workflow write step", () => {
  const files = sources(SRC).map((f) => ({
    rel: rel(f),
    code: stripComments(readFileSync(f, "utf8")),
  }));

  test("the sources are found", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.rel === CONSTRUCTOR)).toBe(true);
  });

  test('the literal kind "owner_workflow" appears only in the constructor and the type', () => {
    const named = files.filter((f) => /["']owner_workflow["']/.test(f.code)).map((f) => f.rel);
    expect(named.sort()).toEqual([CONSTRUCTOR, "engine/types.ts"].sort());
  });

  test("the WorkflowProvenance type is named only by the constructor and the two readers", () => {
    const named = files.filter((f) => /\bWorkflowProvenance\b/.test(f.code)).map((f) => f.rel);
    expect(named.filter((r) => ![CONSTRUCTOR, ...READERS].includes(r))).toEqual([]);
  });

  test("the field-source map (the shape's unique member) is built only by the constructor", () => {
    const named = files.filter((f) => /\bfieldSources\b/.test(f.code)).map((f) => f.rel);
    expect(named.filter((r) => ![CONSTRUCTOR, ...READERS].includes(r))).toEqual([]);
    const ctor = files.find((f) => f.rel === CONSTRUCTOR)?.code ?? "";
    expect(/\bprovenance\s*=\s*\{|\.provenance\s*=/.test(ctor)).toBe(true);
  });

  test("the model door and the MCP act door build their actions without the owner-workflow shape", () => {
    for (const door of ["engine/connector-write-agent-tools.ts", "mcp-sink/capture-act.ts"]) {
      const code = files.find((f) => f.rel === door)?.code;
      expect(code, door).toBeDefined();
      expect(/\bWorkflowProvenance\b|owner_workflow|\bfieldSources\b/.test(code ?? ""), door).toBe(
        false,
      );
    }
  });
});
