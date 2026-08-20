import { describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";

import { agentRequestContext } from "./agent-request-context.ts";
import {
  drainNegationDisclosures,
  negationDisclosureLine,
  recordNegationDisclosure,
} from "./negation-disclosure.ts";

describe("negationDisclosureLine", () => {
  test("a refusal names the tool, the reason and the remediation", () => {
    const line = negationDisclosureLine({
      kind: "refused",
      tool: "findPrsNotTouching",
      message:
        "no PR file-coverage data is indexed, so which PRs do not touch a path cannot be verified",
      remediation:
        "sync a connector that populates PR changed-file coverage (GitHub/GitLab), then retry",
    });
    expect(line).toContain("findPrsNotTouching");
    expect(line).toContain("could not be verified");
    expect(line).toContain("no PR file-coverage data is indexed");
    expect(line).toContain("sync a connector");
  });

  test("exclusions are reported per reason, never summed", () => {
    const line = negationDisclosureLine({
      kind: "excluded",
      tool: "findPrsNotTouching",
      counts: [
        { label: "no file coverage indexed", n: 12 },
        { label: "file coverage truncated", n: 3 },
      ],
    });
    expect(line).toContain("12 excluded (no file coverage indexed)");
    expect(line).toContain("3 excluded (file coverage truncated)");
    expect(line).not.toContain("15");
  });

  test("a zero-count exclusion set produces NO line — nothing was withheld", () => {
    expect(
      negationDisclosureLine({
        kind: "excluded",
        tool: "findDeploymentsWithoutIncident",
        counts: [{ label: "no graph entity of the required type", n: 0 }],
      }),
    ).toBeUndefined();
  });

  test("a zero count alongside a non-zero one is omitted, not printed as 0", () => {
    const line = negationDisclosureLine({
      kind: "excluded",
      tool: "findPrsNotTouching",
      counts: [
        { label: "no file coverage indexed", n: 4 },
        { label: "file coverage truncated", n: 0 },
      ],
    });
    expect(line).toContain("4 excluded (no file coverage indexed)");
    expect(line).not.toContain("truncated");
  });
});

describe("record / drain", () => {
  test("records inside a request scope and drains read-once", async () => {
    await agentRequestContext.run({}, async () => {
      recordNegationDisclosure("first");
      recordNegationDisclosure("second");
      expect(drainNegationDisclosures()).toEqual(["first", "second"]);
      // Read-once: a second drain in the SAME scope must not re-emit what was already shown.
      expect(drainNegationDisclosures()).toEqual([]);
    });
  });

  test("two request scopes do not see each other's disclosures", async () => {
    await agentRequestContext.run({}, async () => {
      recordNegationDisclosure("turn-A");
    });
    await agentRequestContext.run({}, async () => {
      expect(drainNegationDisclosures()).toEqual([]);
    });
  });

  test("recording with NO request scope does not throw and drains empty", () => {
    // The fail-safe path (spec § 5.1.1): the tool payload still carries the sentence, so this
    // degrades to the MCP-level guarantee rather than to silence.
    expect(() => recordNegationDisclosure("orphan")).not.toThrow();
    expect(drainNegationDisclosures()).toEqual([]);
  });
});

test("a tool retrieved from a real Mastra Agent sees the request store", async () => {
  const probe = createTool({
    id: "alsProbe",
    description: "test-only probe",
    execute: async () => {
      recordNegationDisclosure("sentinel");
      return { ok: true };
    },
  });
  const agent = new Agent({
    id: "als-probe-agent",
    name: "ALS Probe",
    instructions: "test-only",
    model: "openai/gpt-4o-mini",
    tools: { alsProbe: probe },
  });
  type ToolExecute = (input: unknown, ctx?: unknown) => Promise<unknown>;
  type ToolMap = Record<string, { execute: ToolExecute }>;
  type AgentWithListTools = { listTools: () => Promise<ToolMap> };
  const listTools = (agent as unknown as AgentWithListTools).listTools;
  if (typeof listTools !== "function") {
    throw new TypeError("Agent.listTools() not exposed (Mastra version drift?)");
  }
  const tools = await listTools.call(agent);
  const fromAgent = tools["alsProbe"];
  expect(fromAgent).toBeDefined();

  const drained = await agentRequestContext.run({}, async () => {
    await fromAgent?.execute({});
    return drainNegationDisclosures();
  });
  expect(drained).toEqual(["sentinel"]);
});
