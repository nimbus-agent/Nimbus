import { describe, expect, it } from "bun:test";

import {
  type LazyMeshToolMap,
  listLazyMeshClientTools,
  mcpClientToolKey,
  mergeToolMapsOrThrow,
  resolveServerTool,
  serviceIdForToolKey,
} from "./tool-map.ts";

describe("mergeToolMapsOrThrow", () => {
  it("merges two disjoint tool maps", () => {
    const a: LazyMeshToolMap = { tool_a: { execute: async () => "a" } };
    const b: LazyMeshToolMap = { tool_b: { execute: async () => "b" } };
    const merged = mergeToolMapsOrThrow([
      { map: a, name: "server_a" },
      { map: b, name: "server_b" },
    ]);
    expect(Object.keys(merged).sort((a, b) => a.localeCompare(b))).toEqual(["tool_a", "tool_b"]);
  });

  it("throws with owner names on a collision", () => {
    const a: LazyMeshToolMap = { dup: { execute: async () => 1 } };
    const b: LazyMeshToolMap = { dup: { execute: async () => 2 } };
    expect(() =>
      mergeToolMapsOrThrow([
        { map: a, name: "first_server" },
        { map: b, name: "second_server" },
      ]),
    ).toThrow(/dup.*first_server.*second_server/);
  });

  it("returns an empty map when given no sources", () => {
    expect(mergeToolMapsOrThrow([])).toEqual({});
  });
});

describe("listLazyMeshClientTools", () => {
  it("returns empty map when client is undefined", async () => {
    const out = await listLazyMeshClientTools(undefined);
    expect(out).toEqual({});
  });

  it("delegates to client.listTools when client is provided", async () => {
    const fakeMap: LazyMeshToolMap = { foo: { execute: async () => "ok" } };
    const fakeClient = { listTools: async () => fakeMap } as unknown as Parameters<
      typeof listLazyMeshClientTools
    >[0];
    const out = await listLazyMeshClientTools(fakeClient);
    expect(out).toBe(fakeMap);
  });
});

/** A tool whose result names the key it was listed under, so a test sees WHICH tool resolved. */
function tool(key: string): LazyMeshToolMap[string] {
  return { execute: async () => key };
}

/** A map keyed exactly as `MCPClient.listTools()` keys it: `<server>_<tool>` for every listed tool. */
function listedAs(servers: Readonly<Record<string, readonly string[]>>): LazyMeshToolMap {
  const out: LazyMeshToolMap = {};
  for (const [server, names] of Object.entries(servers)) {
    for (const name of names) {
      const key = mcpClientToolKey(server, name);
      out[key] = tool(key);
    }
  }
  return out;
}

/** The key the resolved tool was listed under, or null when nothing resolved. */
async function resolvedKey(
  tools: LazyMeshToolMap,
  server: string,
  toolId: string,
): Promise<string | null> {
  const found = resolveServerTool(tools, server, toolId);
  return found?.execute === undefined ? null : ((await found.execute({})) as string);
}

describe("mcpClientToolKey", () => {
  it("joins server and tool with one underscore, both halves verbatim", () => {
    expect(mcpClientToolKey("snowflake", "snowflake_list")).toBe("snowflake_snowflake_list");
    expect(mcpClientToolKey("github_actions", "gha_run_list")).toBe("github_actions_gha_run_list");
  });
});

describe("serviceIdForToolKey", () => {
  it("attributes a key to the LONGEST service id it starts with", () => {
    expect(serviceIdForToolKey("github_github_pr_list")).toBe("github");
    expect(serviceIdForToolKey("github_actions_gha_run_list")).toBe("github_actions");
    expect(serviceIdForToolKey("google_drive_gdrive_file_list")).toBe("google_drive");
  });

  it("matches a bare service id and refuses a key no first-party connector owns", () => {
    expect(serviceIdForToolKey("github")).toBe("github");
    expect(serviceIdForToolKey("filesystem_read_file")).toBeUndefined();
    expect(serviceIdForToolKey("mcp_mine_tool")).toBeUndefined();
    // A prefix that is not followed by the separator is not ownership.
    expect(serviceIdForToolKey("githubber_x")).toBeUndefined();
  });
});

describe("resolveServerTool", () => {
  it("resolves a bare id to the key a real session lists it under, <server>_<tool>", async () => {
    const tools = listedAs({ snowflake: ["snowflake_list", "snowflake_tag_set"] });
    expect(await resolvedKey(tools, "snowflake", "snowflake_list")).toBe(
      "snowflake_snowflake_list",
    );
    expect(await resolvedKey(tools, "snowflake", "snowflake_tag_set")).toBe(
      "snowflake_snowflake_tag_set",
    );
  });

  it("answers an exact key verbatim, before trying the namespaced form", async () => {
    // A caller holding the listed key, and a map keyed by bare ids, both keep working as before.
    const listed = listedAs({ snowflake: ["snowflake_list"] });
    expect(await resolvedKey(listed, "snowflake", "snowflake_snowflake_list")).toBe(
      "snowflake_snowflake_list",
    );
    const both: LazyMeshToolMap = {
      snowflake_list: tool("bare"),
      snowflake_snowflake_list: tool("namespaced"),
    };
    expect(await resolvedKey(both, "snowflake", "snowflake_list")).toBe("bare");
  });

  it("never resolves a bare id onto another server the same client carries", async () => {
    // The github spawner registers `github` AND `github_actions` in ONE client, so
    // `github_` + `actions_gha_run_trigger` is exactly github_actions' `gha_run_trigger` key.
    const tools = listedAs({
      github: ["github_pr_list", "github_pr_merge"],
      github_actions: ["gha_run_list", "gha_run_trigger"],
    });
    expect(tools["github_actions_gha_run_trigger"]).toBeDefined(); // the key the spelling forms
    expect(await resolvedKey(tools, "github", "actions_gha_run_trigger")).toBeNull();
    expect(await resolvedKey(tools, "github", "actions_gha_run_list")).toBeNull();
    // A sibling's own tool name is not the session server's tool either.
    expect(await resolvedKey(tools, "github", "gha_run_trigger")).toBeNull();
    // Control: the session server's own tools resolve, and the sibling's resolve on ITS server.
    expect(await resolvedKey(tools, "github", "github_pr_merge")).toBe("github_github_pr_merge");
    expect(await resolvedKey(tools, "github_actions", "gha_run_trigger")).toBe(
      "github_actions_gha_run_trigger",
    );
  });

  it("does not cross to an unrelated server's tool of the same family", async () => {
    // The phase-3 bundle can carry the whole AWS family in one client.
    const tools = listedAs({ aws: ["aws_ec2_list"], athena: ["athena_query"] });
    expect(await resolvedKey(tools, "aws", "athena_query")).toBeNull();
    expect(await resolvedKey(tools, "athena", "athena_query")).toBe("athena_athena_query");
  });

  it("offers no namespaced step to a server no first-party connector owns", async () => {
    const tools: LazyMeshToolMap = { mcp_mine_lookup: tool("mcp_mine_lookup") };
    expect(await resolvedKey(tools, "mcp_mine", "lookup")).toBeNull();
    expect(await resolvedKey(tools, "mcp_mine", "mcp_mine_lookup")).toBe("mcp_mine_lookup");
  });

  it("returns undefined for an absent tool and never for a prototype member", () => {
    const tools = listedAs({ snowflake: ["snowflake_list"] });
    expect(resolveServerTool(tools, "snowflake", "snowflake_get")).toBeUndefined();
    expect(resolveServerTool(tools, "snowflake", "constructor")).toBeUndefined();
    expect(resolveServerTool(tools, "snowflake", "toString")).toBeUndefined();
  });

  it("falls through an exact key whose value is missing to the namespaced form", async () => {
    const tools: LazyMeshToolMap = {
      snowflake_list: undefined as unknown as LazyMeshToolMap[string],
      snowflake_snowflake_list: tool("snowflake_snowflake_list"),
    };
    expect(await resolvedKey(tools, "snowflake", "snowflake_list")).toBe(
      "snowflake_snowflake_list",
    );
  });
});
