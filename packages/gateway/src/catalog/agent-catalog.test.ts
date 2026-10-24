import { describe, expect, test } from "bun:test";
import { AGENT_PARAM_KINDS } from "../ipc/agent-param-kinds.ts";
import { FLEET_ELIGIBILITY } from "../ipc/agents-rpc.ts";
import {
  AGENT_CATALOG,
  CATALOG_AGENT_NAMES,
  type CatalogParam,
  listCatalogAgents,
} from "./agent-catalog.ts";

function agentByName(name: string) {
  const agent = listCatalogAgents().find((a) => a.name === name);
  if (agent === undefined) throw new Error(`no catalog agent named ${name}`);
  return agent;
}

describe("agent catalog", () => {
  test("covers exactly the 17 brief methods", () => {
    const expected = Object.keys(FLEET_ELIGIBILITY)
      .filter((m) => m !== "agents.whyPeek")
      .sort();
    expect(Object.keys(AGENT_CATALOG).sort()).toEqual(expected);
    expect(Object.keys(AGENT_CATALOG)).toHaveLength(17);
    expect(CATALOG_AGENT_NAMES).toHaveLength(17);
    expect(listCatalogAgents().map((a) => a.name)).toEqual([...CATALOG_AGENT_NAMES]);
    expect([...CATALOG_AGENT_NAMES]).toEqual([...CATALOG_AGENT_NAMES].sort());
  });

  test("every external agent's descriptors agree with AGENT_PARAM_KINDS", () => {
    for (const [agent, fields] of Object.entries(AGENT_PARAM_KINDS)) {
      const params = agentByName(agent).params;
      for (const [field, kind] of Object.entries(fields)) {
        const param = params.find((p) => p.name === field);
        expect({ agent, field, kind: param?.kind }).toEqual({ agent, field, kind });
      }
    }
  });

  test("surfaces derive from the existing tables", () => {
    expect(agentByName("standup").surfaces).toEqual({ external: false, fleet: true });
    expect(agentByName("decisions").surfaces).toEqual({ external: true, fleet: true });
    expect(agentByName("preflight").surfaces).toEqual({ external: false, fleet: false });
    expect(agentByName("decisions").method).toBe("agents.decisions");
  });

  test("oneOf groups are well formed", () => {
    let groupsSeen = 0;
    for (const agent of listCatalogAgents()) {
      const groups = new Map<string, CatalogParam[]>();
      for (const p of agent.params) {
        if (p.oneOf === undefined) continue;
        expect({ agent: agent.name, param: p.name, required: p.required }).toEqual({
          agent: agent.name,
          param: p.name,
          required: false,
        });
        const members = groups.get(p.oneOf.group) ?? [];
        members.push(p);
        groups.set(p.oneOf.group, members);
      }
      for (const [group, members] of groups) {
        groupsSeen++;
        const arms = new Set(members.map((m) => m.oneOf?.arm));
        expect(arms.size).toBeGreaterThanOrEqual(2);
        for (const arm of arms) {
          const armMembers = members.filter((m) => m.oneOf?.arm === arm);
          expect({
            agent: agent.name,
            group,
            arm,
            hasRequired: armMembers.some((m) => m.oneOf?.armRequired === true),
          }).toEqual({ agent: agent.name, group, arm, hasRequired: true });
        }
        const groupRequired = new Set(members.map((m) => m.oneOf?.required));
        expect(groupRequired.size).toBe(1);
      }
    }
    // A table with no groups at all would pass every assertion above vacuously.
    expect(groupsSeen).toBeGreaterThan(0);
  });

  test("why's ref arm requires ref but not line", () => {
    const params = agentByName("why").params;
    const ref = params.find((p) => p.name === "ref");
    const line = params.find((p) => p.name === "line");
    expect(ref?.oneOf).toEqual({ group: "subject", arm: "ref", required: true, armRequired: true });
    expect(line?.oneOf).toEqual({
      group: "subject",
      arm: "ref",
      required: true,
      armRequired: false,
    });
  });

  test("display names and descriptions are short and single-line", () => {
    for (const agent of listCatalogAgents()) {
      expect(agent.displayName.length).toBeLessThanOrEqual(40);
      expect(agent.description.length).toBeLessThanOrEqual(120);
      expect(agent.displayName).not.toContain("\n");
      expect(agent.description).not.toContain("\n");
      expect(agent.roles.length).toBeGreaterThan(0);
      for (const p of agent.params) {
        expect(p.label.length).toBeLessThanOrEqual(40);
        expect(p.label).not.toContain("\n");
      }
    }
  });
});
