import { basename, extname } from "node:path";
import { parse as parseYaml } from "yaml";

export type ParsedWorkflowFile = {
  name: string;
  description: string | null;
  stepsJson: string;
};

function asStepArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseWorkflowFileContent(content: string, filePath: string): ParsedWorkflowFile {
  const lower = filePath.toLowerCase();
  let root: unknown;
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    root = parseYaml(content) as unknown;
  } else {
    try {
      root = JSON.parse(content) as unknown;
    } catch {
      throw new Error("Workflow file is not valid JSON");
    }
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Workflow file must be a single object with a steps array");
  }
  const rec = root as Record<string, unknown>;
  const nameRaw = typeof rec["name"] === "string" ? rec["name"].trim() : "";
  const base = basename(filePath);
  const ext = extname(filePath);
  const stem = ext === "" ? base : base.slice(0, -ext.length);
  const name = nameRaw === "" ? stem : nameRaw;
  const description =
    typeof rec["description"] === "string" && rec["description"].trim() !== ""
      ? rec["description"].trim()
      : null;
  const steps = asStepArray(rec["steps"]);
  if (steps.length === 0) {
    throw new Error("Workflow file needs a non-empty steps array");
  }
  return { name, description, stepsJson: JSON.stringify(steps) };
}
