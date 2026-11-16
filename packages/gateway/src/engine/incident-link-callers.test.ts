// Phase 10 IC4 task 4: nothing a caller sends can become an incident link. The link is a top-level field
// of an in-process PlannedAction that only `incident/incident-link-mint.ts` constructs (static D46(e)).
//
// Census of the sites that build a PlannedAction from caller input (recorded in the PR description): the
// IPC and ChatOps sites name ONLY `type` and `payload` (`ipc/server/dispatchers.ts` tribal capture and the
// plan runner, `platform/assemble.ts` in-chat tribal capture, `chatops/chatops-boot.ts`), the model door
// and the MCP act door build the action field by field (`engine/connector-write-agent-tools.ts`,
// `mcp-sink/capture-act.ts` through `ipc/capture-rpc.ts` and `ipc/approvals-rpc.ts`), the workflow step
// builds it from the owner's saved workflow (`automation/workflow-write-step.ts`), and the planner's
// actions are hard-coded. None copies an unknown top-level key from a request, so there is no method to
// refuse an `incident` param on (a refusal would be dead code); a payload-nested `incident` is inert
// (executor-incident-link.test.ts 2.7 and 4.4). These pins keep it that way.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.includes("test-helpers"))
      out.push(p);
  }
  return out;
}

const read = (rel: string): string => strip(readFileSync(join(SRC, rel), "utf8"));

describe("4.3 the doors never build an action with an incident link", () => {
  for (const rel of [
    "engine/connector-write-agent-tools.ts",
    "ipc/capture-rpc.ts",
    "ipc/approvals-rpc.ts",
    "mcp-sink/capture-act.ts",
    "automation/workflow-write-step.ts",
    "engine/user-mcp-agent-tools.ts",
    "chatops/chatops-boot.ts",
  ]) {
    test(`${rel} names no incident link`, () => {
      expect(read(rel)).not.toMatch(/\bincident\s*:|\.incident\b|incidentLink|IncidentLink/);
    });
  }
});

describe("4.1 census: only three files touch an action's incident link", () => {
  test("a non-test source file that mentions both PlannedAction and an incident link is on the list", () => {
    const hits = walk(SRC)
      .filter((f) => {
        const s = strip(readFileSync(f, "utf8"));
        return /\bPlannedAction\b/.test(s) && /\bIncidentLink\b|\bincident\s*:|\.incident\b/.test(s);
      })
      .map((f) => relative(SRC, f).split("\\").join("/"))
      .sort();
    expect(hits).toEqual([
      "egress/egress-record.ts",
      "engine/executor.ts",
      "engine/types.ts",
    ]);
  });
});
