import { describe, expect, it } from "bun:test";

import { type ConnectorEvidence, classifyConnector, summarize } from "./connector-verification.ts";

describe("classifyConnector", () => {
  it("rates a connector with tools, outbound calls, and tests as tier1", () => {
    const row = classifyConnector({
      id: "github",
      files: ["server.ts", "server.test.ts"],
      sources: ["const r = await fetch(url); registerTool('gh_x', h);"],
    });
    expect(row.tier).toBe("tier1");
    expect(row.hasTools).toBe(true);
    expect(row.hasTests).toBe(true);
    expect(row.makesOutboundCalls).toBe(true);
  });

  it("rates an untested but working connector as implemented", () => {
    const row = classifyConnector({
      id: "bigeye",
      files: ["server.ts", "tools.ts"],
      sources: ["await fetchWithTimeout(url); reg.tool('bigeye_issues', h);"],
    });
    expect(row.tier).toBe("implemented");
    expect(row.hasTests).toBe(false);
  });

  it("counts a CLI-backed connector reached via the shared helper", () => {
    // Real shape: kubernetes/src/server.ts never calls fetch — it routes
    // through shared/run-cli-json.ts to shell out to kubectl.
    const row = classifyConnector({
      id: "kubernetes",
      files: ["server.ts"],
      sources: ["const out = await runCliJson(kubectlBase(), kubeEnv()); reg.tool('k8s', h);"],
    });
    expect(row.makesOutboundCalls).toBe(true);
    expect(row.tier).toBe("implemented");
  });

  it("counts a connector using the shared REST fetcher factory", () => {
    // Real shape: github/src/server.ts builds its client via makeRestFetcher.
    const row = classifyConnector({
      id: "github",
      files: ["server.ts"],
      sources: ["const f = makeRestFetcher({ apiBase: GH_API }); reg.tool('gh', h);"],
    });
    expect(row.makesOutboundCalls).toBe(true);
  });

  // The four cases below are the registration idioms that actually dominate
  // `packages/mcp-connectors/`. The first draft of TOOL_REGISTRATION matched
  // only the method form (`reg.tool(`), which no connector in the tree uses —
  // it filed 61 of 94 as `unknown`, including the kubernetes reference case.
  it("counts the curried registrar returned by createZodToolRegistrar", () => {
    // Real shape: kubernetes, slack, jira, sentry, obsidian — a bare `reg(...)`
    // call, NOT `reg.tool(...)`.
    const row = classifyConnector({
      id: "kubernetes",
      files: ["server.ts"],
      sources: [
        "const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));\n" +
          "reg('k8s_pod_list', 'List pods.', schema, (p) => runCliJson(cmd));",
      ],
    });
    expect(row.hasTools).toBe(true);
    expect(row.tier).toBe("implemented");
  });

  it("counts the runReadOnlyMcpConnector bootstrap helper", () => {
    // Real shape: storybook/localdb/dataprofile — server.ts is a 4-line
    // bootstrap and the `reg(...)` calls live in a sibling tools.ts.
    const row = classifyConnector({
      id: "storybook",
      files: ["server.ts", "tools.ts"],
      sources: [
        "await runReadOnlyMcpConnector('nimbus-storybook', (reg) => { registerStorybookTools(reg); });",
        "export function registerStorybookTools(reg) { reg('sb_list', d, s, h); }",
      ],
    });
    expect(row.hasTools).toBe(true);
  });

  it("counts a per-connector register<X>Tool helper", () => {
    // Real shape: github (registerGithubTool), gitlab, outlook, drive, gmail.
    const row = classifyConnector({
      id: "github",
      files: ["server.ts"],
      sources: ["registerGithubTool('gh_pr_list', schema, handler); await fetchWithTimeout(u);"],
    });
    expect(row.hasTools).toBe(true);
    expect(row.tier).toBe("implemented");
  });

  it("counts the shared registerSimpleTool / registerZodTool primitives", () => {
    const row = classifyConnector({
      id: "misc",
      files: ["server.ts"],
      sources: ["registerSimpleTool('x', d, h); const r = await fetch(u);"],
    });
    expect(row.hasTools).toBe(true);
  });

  it("does not mistake an unrelated three-letter call for a registrar", () => {
    // Guards the bare-call pattern against matching e.g. `req(` or `log(`.
    const row = classifyConnector({
      id: "decoy",
      files: ["server.ts"],
      sources: ["req('GET', url); log('hello'); const r = await fetch(u);"],
    });
    expect(row.hasTools).toBe(false);
    expect(row.tier).toBe("unknown");
  });

  it("rates a connector with no tool registration as unknown", () => {
    const row = classifyConnector({
      id: "empty",
      files: ["server.ts"],
      sources: ["export const nothing = 1;"],
    });
    expect(row.tier).toBe("unknown");
  });

  it("summarizes counts by tier", () => {
    const rows: readonly ConnectorEvidence[] = [
      classifyConnector({
        id: "a",
        files: ["server.test.ts"],
        sources: ["fetch(u); reg.tool('a', h)"],
      }),
      classifyConnector({ id: "b", files: [], sources: ["fetch(u); reg.tool('b', h)"] }),
      classifyConnector({ id: "c", files: [], sources: ["nothing"] }),
    ];
    expect(summarize(rows)).toEqual({ tier1: 1, implemented: 1, unknown: 1, total: 3 });
  });
});
