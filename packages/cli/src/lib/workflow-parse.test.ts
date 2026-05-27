// packages/cli/src/lib/workflow-parse.test.ts
import { describe, expect, it } from "bun:test";

import { parseWorkflowFileContent } from "./workflow-parse.ts";

describe("parseWorkflowFileContent — JSON path", () => {
  it("parses a minimal valid JSON workflow with name/description/steps", () => {
    const json = JSON.stringify({
      name: "My Workflow",
      description: "A test workflow",
      steps: [{ kind: "noop" }, { kind: "echo", text: "hi" }],
    });
    const result = parseWorkflowFileContent(json, "wf.json");
    expect(result.name).toBe("My Workflow");
    expect(result.description).toBe("A test workflow");
    expect(JSON.parse(result.stepsJson)).toEqual([{ kind: "noop" }, { kind: "echo", text: "hi" }]);
  });

  it("falls back to the file basename (minus extension) when name is missing or empty", () => {
    const json = JSON.stringify({ steps: [{ kind: "noop" }] });
    const result = parseWorkflowFileContent(json, "/path/to/daily-cleanup.json");
    expect(result.name).toBe("daily-cleanup");
  });

  it("falls back to the file basename when name is whitespace-only", () => {
    const json = JSON.stringify({ name: "   ", steps: [{ kind: "noop" }] });
    const result = parseWorkflowFileContent(json, "report.json");
    expect(result.name).toBe("report");
  });

  it("uses the full basename when the file has no extension", () => {
    const json = JSON.stringify({ steps: [{ kind: "noop" }] });
    const result = parseWorkflowFileContent(json, "/abs/path/Makefile");
    expect(result.name).toBe("Makefile");
  });

  it("returns description: null when missing", () => {
    const json = JSON.stringify({ name: "w", steps: [{ kind: "noop" }] });
    expect(parseWorkflowFileContent(json, "w.json").description).toBeNull();
  });

  it("returns description: null when whitespace-only", () => {
    const json = JSON.stringify({ name: "w", description: "  ", steps: [{ kind: "noop" }] });
    expect(parseWorkflowFileContent(json, "w.json").description).toBeNull();
  });

  it("returns description: null when wrong type (number)", () => {
    const json = JSON.stringify({ name: "w", description: 42, steps: [{ kind: "noop" }] });
    expect(parseWorkflowFileContent(json, "w.json").description).toBeNull();
  });

  it("trims a present description", () => {
    const json = JSON.stringify({
      name: "w",
      description: "  trim me  ",
      steps: [{ kind: "noop" }],
    });
    expect(parseWorkflowFileContent(json, "w.json").description).toBe("trim me");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseWorkflowFileContent("{ not json", "w.json")).toThrow(
      "Workflow file is not valid JSON",
    );
  });

  it("throws when root is an array", () => {
    expect(() => parseWorkflowFileContent("[1, 2, 3]", "w.json")).toThrow(
      "Workflow file must be a single object",
    );
  });

  it("throws when root is null", () => {
    expect(() => parseWorkflowFileContent("null", "w.json")).toThrow(
      "Workflow file must be a single object",
    );
  });

  it("throws when root is a primitive (number / string)", () => {
    expect(() => parseWorkflowFileContent("42", "w.json")).toThrow(
      "Workflow file must be a single object",
    );
    expect(() => parseWorkflowFileContent('"hi"', "w.json")).toThrow(
      "Workflow file must be a single object",
    );
  });

  it("throws when steps is missing", () => {
    const json = JSON.stringify({ name: "w" });
    expect(() => parseWorkflowFileContent(json, "w.json")).toThrow("non-empty steps array");
  });

  it("throws when steps is empty", () => {
    const json = JSON.stringify({ name: "w", steps: [] });
    expect(() => parseWorkflowFileContent(json, "w.json")).toThrow("non-empty steps array");
  });

  it("treats non-array steps as empty (throws non-empty steps array)", () => {
    const json = JSON.stringify({ name: "w", steps: { not: "array" } });
    expect(() => parseWorkflowFileContent(json, "w.json")).toThrow("non-empty steps array");
  });
});

describe("parseWorkflowFileContent — YAML path", () => {
  it("parses a .yaml extension via the YAML parser", () => {
    const yaml = `name: yaml-wf
description: from yaml
steps:
  - kind: noop
  - kind: echo
    text: hi
`;
    const result = parseWorkflowFileContent(yaml, "wf.yaml");
    expect(result.name).toBe("yaml-wf");
    expect(result.description).toBe("from yaml");
    expect(JSON.parse(result.stepsJson)).toEqual([{ kind: "noop" }, { kind: "echo", text: "hi" }]);
  });

  it("parses a .yml extension via the YAML parser", () => {
    const yaml = `name: yml-wf
steps:
  - kind: noop
`;
    const result = parseWorkflowFileContent(yaml, "wf.yml");
    expect(result.name).toBe("yml-wf");
    expect(result.description).toBeNull();
  });

  it("treats extension casing as case-insensitive (.YAML, .Yml)", () => {
    const yaml = "name: x\nsteps: [{kind: noop}]\n";
    expect(parseWorkflowFileContent(yaml, "wf.YAML").name).toBe("x");
    expect(parseWorkflowFileContent(yaml, "wf.Yml").name).toBe("x");
  });
});
