import { describe, expect, test } from "bun:test";

import type { PlannedAction } from "../engine/types.ts";
import {
  createConnectorDispatcher,
  type McpToolListingClient,
  meshDispatcherClient,
} from "./registry.ts";

describe("createConnectorDispatcher", () => {
  test("dispatches by action.type when mcpToolId is absent", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          filesystem_list_directory: {
            async execute(input: unknown) {
              return { echoed: input };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    const action: PlannedAction = {
      type: "filesystem_list_directory",
      payload: { path: "/tmp" },
    };
    await expect(d.dispatch(action)).resolves.toEqual({ echoed: { path: "/tmp" } });
  });

  test("dispatches by payload.mcpToolId and uses payload.input", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          filesystem_read_file: {
            async execute(input: unknown) {
              return { file: input };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    const action: PlannedAction = {
      type: "ignored",
      payload: { mcpToolId: "filesystem_read_file", input: { path: "a.txt" } },
    };
    await expect(d.dispatch(action)).resolves.toEqual({ file: { path: "a.txt" } });
  });

  test("lists tools once (cached)", async () => {
    let calls = 0;
    const client: McpToolListingClient = {
      async listTools() {
        calls += 1;
        return {
          t: {
            async execute() {
              return 1;
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    await d.dispatch({ type: "t" });
    await d.dispatch({ type: "t" });
    expect(calls).toBe(1);
  });

  test("throws when tool is missing", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {};
      },
    };
    const d = createConnectorDispatcher(client);
    await expect(d.dispatch({ type: "missing_tool" })).rejects.toThrow(/Tool not found/);
  });
});

// The mesh lists every connector tool as `<server>_<tool>` (each server named by its service id),
// so the notion connector's `notion_kb_append` reaches the dispatcher as `notion_notion_kb_append`.
describe("createConnectorDispatcher — a bare mcpToolId against a mesh-keyed tool map", () => {
  function meshListing(ran: string[]): McpToolListingClient {
    const listed = (key: string) => ({
      async execute(input: unknown) {
        ran.push(key);
        return { key, input };
      },
    });
    return {
      async listTools() {
        return {
          notion_notion_kb_append: listed("notion_notion_kb_append"),
          confluence_confluence_kb_append: listed("confluence_confluence_kb_append"),
          github_github_pr_list: listed("github_github_pr_list"),
          github_actions_gha_run_trigger: listed("github_actions_gha_run_trigger"),
        };
      },
    };
  }

  test("resolves the bare id on the server of the action type the gate approved", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(meshListing(ran));
    const out = await d.dispatch({
      type: "notion.knowledge.write",
      payload: { mcpToolId: "notion_kb_append", input: { databaseId: "db" } },
    });
    expect(out).toEqual({ key: "notion_notion_kb_append", input: { databaseId: "db" } });
    expect(ran).toEqual(["notion_notion_kb_append"]);
  });

  test("never resolves a bare id onto a different connector than the action type's", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(meshListing(ran));
    // A notion action naming confluence's KB tool: `notion_confluence_kb_append` is no tool.
    await expect(
      d.dispatch({
        type: "notion.knowledge.write",
        payload: { mcpToolId: "confluence_kb_append", input: {} },
      }),
    ).rejects.toThrow(/Tool not found/);
    // `github_` + `actions_gha_run_trigger` spells github_actions' trigger: refused, not run.
    await expect(
      d.dispatch({ type: "github.pr.list", payload: { mcpToolId: "actions_gha_run_trigger" } }),
    ).rejects.toThrow(/Tool not found/);
    expect(ran).toEqual([]);
  });

  test("an exact mesh key still dispatches as before, whatever the action type", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(meshListing(ran));
    await d.dispatch({ type: "github_github_pr_list", payload: {} });
    expect(ran).toEqual(["github_github_pr_list"]);
  });
});

describe("createConnectorDispatcher G8 — size cap + timeout", () => {
  test("rejects oversized tool result (S8-F5)", async () => {
    const big = "x".repeat(5 * 1024 * 1024);
    const client: McpToolListingClient = {
      async listTools() {
        return {
          big_tool: {
            async execute() {
              return { content: big };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client);
    await expect(d.dispatch({ type: "big_tool" })).rejects.toThrow(/result size/);
  });

  test("aborts a tool call that exceeds the timeout (S8-F5)", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          slow_tool: {
            execute: () => new Promise(() => {}),
          },
        };
      },
    };
    const d = createConnectorDispatcher(client, { toolTimeoutMs: 200 });
    await expect(d.dispatch({ type: "slow_tool" })).rejects.toThrow(/exceeded.*200ms/);
  });

  test("permits result under cap and within timeout", async () => {
    const client: McpToolListingClient = {
      async listTools() {
        return {
          small_tool: {
            async execute() {
              return { ok: true };
            },
          },
        };
      },
    };
    const d = createConnectorDispatcher(client, {
      maxResultBytes: 1024,
      toolTimeoutMs: 5000,
    });
    await expect(d.dispatch({ type: "small_tool" })).resolves.toEqual({ ok: true });
  });
});

// I42: a user-MCP tool needs the LOCAL owner's approval on every call, and the gate decides that
// from `action.type` alone (I3). So the dispatcher must never let a payload's `mcpToolId` run a
// user-MCP tool under any action type but that tool's own — otherwise an action of another type
// (approved by a delegate, or needing no approval at all) could smuggle the call through.
describe("createConnectorDispatcher — user-MCP keys dispatch only under their own action type (I42)", () => {
  function listing(ran: string[]): McpToolListingClient {
    const listed = (key: string) => ({
      async execute() {
        ran.push(key);
        return { key };
      },
    });
    return {
      async listTools() {
        return {
          mcp_x_echo: listed("mcp_x_echo"),
          mcp_x_y_echo: listed("mcp_x_y_echo"),
          github_github_pr_list: listed("github_github_pr_list"),
        };
      },
    };
  }

  test("a user-MCP key smuggled under a first-party action type is refused and never runs", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "mcp_x_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    // A bare user-MCP key as the action type itself is no user-MCP action type either.
    await expect(d.dispatch({ type: "mcp_x_echo", payload: {} })).rejects.toThrow(
      /ERR_USER_MCP_ACTION_MISMATCH/,
    );
    expect(ran).toEqual([]);
  });

  test("a user-MCP key under ANOTHER user-MCP server's action type is refused", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "mcp_x.y_echo", payload: { mcpToolId: "mcp_x_y_echo" } }),
    ).resolves.toEqual({ key: "mcp_x_y_echo" });
    // ...but the owner approved `mcp_x.echo`; running `mcp_x_y_echo` under it is refused.
    await expect(
      d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_y_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(ran).toEqual(["mcp_x_y_echo"]);
  });

  test("a user-MCP action type cannot dispatch a first-party tool through mcpToolId", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "github_github_pr_list" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(ran).toEqual([]);
  });

  test("the user-MCP key under its own action type still dispatches", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await expect(
      d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_echo" } }),
    ).resolves.toEqual({ key: "mcp_x_echo" });
    expect(ran).toEqual(["mcp_x_echo"]);
  });

  test("a model-requested user-MCP call hands the tool exactly payload.input — requestedBy never reaches the server", async () => {
    const received: unknown[] = [];
    const d = createConnectorDispatcher({
      listTools: async () => ({
        mcp_x_echo: {
          execute: async (input: unknown) => {
            received.push(input);
            return {};
          },
        },
      }),
    });
    await d.dispatch({
      type: "mcp_x.echo",
      payload: { mcpToolId: "mcp_x_echo", input: { q: "hi" }, requestedBy: "model" },
    });
    expect(received).toEqual([{ q: "hi" }]);
  });
});

// Running one user-MCP tool must not list (and so spawn) the whole mesh: the dispatcher resolves a
// user-MCP action against that server's own listing only, keeping the I42 pairing check.
describe("createConnectorDispatcher — a user-MCP action lists only its own server", () => {
  function perServer(ran: string[]): {
    client: McpToolListingClient;
    calls: { whole: number; perServer: string[] };
  } {
    const calls = { whole: 0, perServer: [] as string[] };
    const listed = (key: string) => ({
      async execute() {
        ran.push(key);
        return { key };
      },
    });
    const servers: Record<string, Record<string, ReturnType<typeof listed>>> = {
      mcp_a: { mcp_a_x: listed("mcp_a_x") },
      mcp_b: { mcp_b_x: listed("mcp_b_x") },
    };
    return {
      calls,
      client: {
        async listTools() {
          calls.whole += 1;
          return {
            mcp_a_x: listed("mcp_a_x"),
            mcp_b_x: listed("mcp_b_x"),
            github_github_pr_list: listed("github_github_pr_list"),
          };
        },
        async listUserMcpTools(serviceId: string) {
          calls.perServer.push(serviceId);
          return servers[serviceId];
        },
      },
    };
  }

  test("mcp_a.x lists mcp_a exactly once and the whole mesh zero times", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "mcp_a.x", payload: { mcpToolId: "mcp_a_x", input: { q: 1 } } }),
    ).resolves.toEqual({ key: "mcp_a_x" });
    expect(calls.perServer).toEqual(["mcp_a"]);
    expect(calls.whole).toBe(0);
    expect(ran).toEqual(["mcp_a_x"]);
  });

  test("an unknown tool on the server still fails with Tool not found", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "mcp_a.nope", payload: { mcpToolId: "mcp_a_nope" } }),
    ).rejects.toThrow(/Tool not found/);
    expect(calls.perServer).toEqual(["mcp_a"]);
    expect(calls.whole).toBe(0);
    expect(ran).toEqual([]);
  });

  test("an unregistered server lists nothing and fails with Tool not found", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "mcp_zz.x", payload: { mcpToolId: "mcp_zz_x" } }),
    ).rejects.toThrow(/Tool not found/);
    expect(calls.whole).toBe(0);
  });

  test("I42 pairing is still refused on the per-server path, before any listing", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    // Another server's key under mcp_a's action type.
    await expect(
      d.dispatch({ type: "mcp_a.x", payload: { mcpToolId: "mcp_b_x" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    // A first-party key under a user-MCP action type.
    await expect(
      d.dispatch({ type: "mcp_a.x", payload: { mcpToolId: "github_github_pr_list" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(calls.perServer).toEqual([]);
    expect(calls.whole).toBe(0);
    expect(ran).toEqual([]);
  });

  test("a first-party action still uses the whole-mesh listing (and the smuggle refusal)", async () => {
    const ran: string[] = [];
    const { client, calls } = perServer(ran);
    const d = createConnectorDispatcher(client);
    await expect(
      d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "mcp_a_x" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(calls.whole).toBe(1);
    expect(calls.perServer).toEqual([]);
    expect(ran).toEqual([]);
  });
});

describe("meshDispatcherClient", () => {
  test("routes each listing to the matching mesh method", async () => {
    const seen: string[] = [];
    const client = meshDispatcherClient({
      async listToolsForDispatcher() {
        seen.push("whole");
        return {};
      },
      getToolsEpoch: () => 7,
      async listOwnerCodeServerToolsForDispatcher(serviceId: string) {
        seen.push(`one:${serviceId}`);
        return undefined;
      },
    });
    await client.listTools();
    expect(await client.listUserMcpTools?.("mcp_a")).toBeUndefined();
    expect(client.getToolsEpoch?.()).toBe(7);
    expect(seen).toEqual(["whole", "one:mcp_a"]);
  });
});

describe("createConnectorDispatcher — a connector-write tool dispatches only under its own action type (I53)", () => {
  function listing(ran: string[]): McpToolListingClient {
    const listed = (key: string) => ({
      async execute() {
        ran.push(key);
        return { key };
      },
    });
    return {
      async listTools() {
        return {
          github_github_pr_merge: listed("github_github_pr_merge"),
          jenkins_jenkins_build_trigger: listed("jenkins_jenkins_build_trigger"),
          github_actions_gha_run_trigger: listed("github_actions_gha_run_trigger"),
          github_github_pr_list: listed("github_github_pr_list"),
        };
      },
    };
  }

  test("a write tool under another action type is refused in every spelling and never runs", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    for (const [type, mcpToolId] of [
      ["pipeline.trigger", "jenkins_jenkins_build_trigger"],
      ["jenkins.build.abort", "jenkins_build_trigger"],
      ["search.run", "github_github_pr_merge"],
      ["github.pr.merge", "github_actions_gha_run_trigger"],
    ] as const) {
      await expect(d.dispatch({ type, payload: { mcpToolId } })).rejects.toThrow(
        /ERR_WRITE_TOOL_ACTION_MISMATCH/,
      );
    }
    expect(ran).toEqual([]);
  });

  test("a write tool under its own action type, and a read tool under any type, still dispatch", async () => {
    const ran: string[] = [];
    const d = createConnectorDispatcher(listing(ran));
    await d.dispatch({ type: "github.pr.merge", payload: { mcpToolId: "github_github_pr_merge" } });
    await d.dispatch({
      type: "jenkins.build.trigger",
      payload: { mcpToolId: "jenkins_build_trigger" },
    });
    await d.dispatch({
      type: "github_actions.run.trigger",
      payload: { mcpToolId: "github_actions_gha_run_trigger" },
    });
    await d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "github_github_pr_list" } });
    expect(ran).toEqual([
      "github_github_pr_merge",
      "jenkins_jenkins_build_trigger",
      "github_actions_gha_run_trigger",
      "github_github_pr_list",
    ]);
  });
});

describe("createConnectorDispatcher — an owner-code tool named like a write row id (I53)", () => {
  test("an mcp_ or ext_ key ending in a row id dispatches under its own type; a first-party mismatch is still refused", async () => {
    const ran: string[] = [];
    const t = (k: string) => ({
      async execute() {
        ran.push(k);
        return {};
      },
    });
    const d = createConnectorDispatcher({
      async listTools() {
        return {
          mcp_foo_slack_message_post: t("mcp_foo_slack_message_post"),
          ext_bar_github_pr_merge: t("ext_bar_github_pr_merge"),
          github_github_pr_merge: t("github_github_pr_merge"),
        };
      },
    });
    await d.dispatch({
      type: "mcp_foo.slack_message_post",
      payload: { mcpToolId: "mcp_foo_slack_message_post" },
    });
    await d.dispatch({
      type: "ext_bar.github_pr_merge",
      payload: { mcpToolId: "ext_bar_github_pr_merge" },
    });
    expect(ran).toEqual(["mcp_foo_slack_message_post", "ext_bar_github_pr_merge"]);
    await expect(
      d.dispatch({ type: "search.run", payload: { mcpToolId: "github_github_pr_merge" } }),
    ).rejects.toThrow(/ERR_WRITE_TOOL_ACTION_MISMATCH/);
  });
});

describe("createConnectorDispatcher — a before-state read dispatches only a read of its own service (spec § 5.4)", () => {
  /** Every tool a test map holds, each recording that it ran. */
  function mapOf(keys: readonly string[]) {
    const ran: string[] = [];
    const tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> = {};
    for (const k of keys) {
      tools[k] = {
        execute: async () => {
          ran.push(k);
          return { from: k };
        },
      };
    }
    const client: McpToolListingClient = { listTools: async () => tools };
    return { d: createConnectorDispatcher(client), ran };
  }
  const read = (type: string, mcpToolId: string): PlannedAction => ({
    type,
    payload: { mcpToolId, input: { issueKey: "NIM-1" } },
  });

  test("the control: a read tool of its own service dispatches", async () => {
    const { d, ran } = mapOf(["jira_jira_issue_get"]);
    await expect(d.dispatch(read("jira.before.read", "jira_jira_issue_get"))).resolves.toEqual({
      from: "jira_jira_issue_get",
    });
    expect(ran).toEqual(["jira_jira_issue_get"]);
  });

  test("a write key under a before-read type throws and runs nothing", async () => {
    const { d, ran } = mapOf(["jira_jira_issue_update", "jira_jira_comment_add"]);
    for (const key of ["jira_jira_issue_update", "jira_jira_comment_add"]) {
      await expect(d.dispatch(read("jira.before.read", key))).rejects.toThrow(
        `ERR_BEFORE_READ_NOT_A_READ: action type "jira.before.read" may not dispatch tool "${key}"`,
      );
    }
    expect(ran).toEqual([]);
  });

  test("a non-read verb (and the bare-id spelling) is refused too", async () => {
    const { d, ran } = mapOf(["jira_jira_issue_frobnicate"]);
    await expect(d.dispatch(read("jira.before.read", "jira_issue_frobnicate"))).rejects.toThrow(
      "ERR_BEFORE_READ_NOT_A_READ",
    );
    expect(ran).toEqual([]);
  });

  test("a read of ANOTHER connector is refused: ERR_BEFORE_READ_SERVICE_MISMATCH", async () => {
    const { d, ran } = mapOf(["github_github_issue_get", "github_actions_gha_run_get"]);
    await expect(d.dispatch(read("jira.before.read", "github_github_issue_get"))).rejects.toThrow(
      `ERR_BEFORE_READ_SERVICE_MISMATCH: action type "jira.before.read" may not dispatch tool "github_github_issue_get"`,
    );
    // A sibling server whose name extends the service's is another service.
    await expect(
      d.dispatch(read("github.before.read", "github_actions_gha_run_get")),
    ).rejects.toThrow("ERR_BEFORE_READ_SERVICE_MISMATCH");
    expect(ran).toEqual([]);
  });

  test("the same keys under an ordinary type are untouched by the guard", async () => {
    const { d, ran } = mapOf(["jira_jira_issue_update"]);
    await d.dispatch(read("jira.issue.update", "jira_jira_issue_update"));
    expect(ran).toEqual(["jira_jira_issue_update"]);
  });
});

describe("createConnectorDispatcher — a prepare tool runs only inside the prepare step, and only its own service's (I54)", () => {
  const IDS = new Set(["synth_plan"]);
  function mapOf(keys: readonly string[]) {
    const ran: string[] = [];
    const tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> = {};
    for (const k of keys) {
      tools[k] = {
        execute: async () => {
          ran.push(k);
          return { from: k };
        },
      };
    }
    const client: McpToolListingClient = { listTools: async () => tools };
    return { d: createConnectorDispatcher(client, { prepareToolIds: IDS }), ran };
  }
  const call = (type: string, mcpToolId: string): PlannedAction => ({
    type,
    payload: { mcpToolId, input: { dir: "prod" } },
  });

  test("the control: a prepare tool of its own service dispatches under its prepare type", async () => {
    const { d, ran } = mapOf(["iac_synth_plan"]);
    await expect(d.dispatch(call("iac.write.prepare", "iac_synth_plan"))).resolves.toEqual({
      from: "iac_synth_plan",
    });
    expect(ran).toEqual(["iac_synth_plan"]);
  });

  test("a prepare tool under any other action type is ERR_PREPARE_OUTSIDE_STEP and runs nothing", async () => {
    const { d, ran } = mapOf(["iac_synth_plan"]);
    for (const type of ["iac.terraform.apply", "search.run", "iac.plan"]) {
      await expect(d.dispatch(call(type, "iac_synth_plan"))).rejects.toThrow(
        `ERR_PREPARE_OUTSIDE_STEP: action type ${JSON.stringify(type)} may not dispatch tool "iac_synth_plan"`,
      );
    }
    expect(ran).toEqual([]);
  });

  test("a prepare type resolving to ANOTHER service's tool is ERR_PREPARE_SERVICE_MISMATCH", async () => {
    const { d, ran } = mapOf(["github_github_issue_get", "github_synth_plan"]);
    await expect(d.dispatch(call("iac.write.prepare", "github_github_issue_get"))).rejects.toThrow(
      "ERR_PREPARE_SERVICE_MISMATCH",
    );
    await expect(d.dispatch(call("iac.write.prepare", "github_synth_plan"))).rejects.toThrow(
      "ERR_PREPARE_SERVICE_MISMATCH",
    );
    expect(ran).toEqual([]);
  });

  test("a prepare type resolving to a read, a write, or an undeclared tool is ERR_PREPARE_NOT_A_PREPARE_TOOL", async () => {
    const { d, ran } = mapOf(["iac_iac_terraform_plan", "iac_iac_terraform_apply", "iac_other"]);
    for (const key of ["iac_iac_terraform_plan", "iac_iac_terraform_apply", "iac_other"]) {
      await expect(d.dispatch(call("iac.write.prepare", key))).rejects.toThrow(
        "ERR_PREPARE_NOT_A_PREPARE_TOOL",
      );
    }
    expect(ran).toEqual([]);
  });

  test("a prepare type naming a connector WRITE that is also (wrongly) declared as a prepare tool is refused", async () => {
    const client: McpToolListingClient = {
      listTools: async () => ({ iac_iac_terraform_apply: { execute: async () => "ran" } }),
    };
    const d = createConnectorDispatcher(client, {
      prepareToolIds: new Set(["iac_terraform_apply"]),
    });
    await expect(d.dispatch(call("iac.write.prepare", "iac_iac_terraform_apply"))).rejects.toThrow(
      "ERR_PREPARE_NOT_A_PREPARE_TOOL",
    );
  });

  test("with the production (empty) set, ordinary types are untouched", async () => {
    const client: McpToolListingClient = {
      listTools: async () => ({ jira_jira_issue_update: { execute: async () => "ok" } }),
    };
    const d = createConnectorDispatcher(client);
    await expect(d.dispatch(call("jira.issue.update", "jira_jira_issue_update"))).resolves.toBe(
      "ok",
    );
    await expect(d.dispatch(call("jira.write.prepare", "jira_jira_issue_update"))).rejects.toThrow(
      "ERR_PREPARE_NOT_A_PREPARE_TOOL",
    );
  });
});

describe("the dispatcher and the REAL commit prepare tools (D1c, I54)", () => {
  const listing = (keys: readonly string[]) => {
    const ran: string[] = [];
    const tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> = {};
    for (const k of keys) {
      tools[k] = {
        execute: async () => {
          ran.push(k);
          return { headSha: "x" };
        },
      };
    }
    const client: McpToolListingClient = { listTools: async () => tools };
    return { d: createConnectorDispatcher(client), ran };
  };
  const call = (type: string, mcpToolId: string): PlannedAction => ({
    type,
    payload: { mcpToolId, input: {} },
  });

  test("the control: each real prepare tool dispatches under its own service's prepare type", async () => {
    const { d, ran } = listing(["github_github_commit_prepare", "gitlab_gitlab_commit_prepare"]);
    await d.dispatch(call("github.write.prepare", "github_github_commit_prepare"));
    await d.dispatch(call("gitlab.write.prepare", "gitlab_gitlab_commit_prepare"));
    expect(ran).toEqual(["github_github_commit_prepare", "gitlab_gitlab_commit_prepare"]);
  });

  test("under a write or read action type a real prepare tool is ERR_PREPARE_OUTSIDE_STEP and runs nothing", async () => {
    const { d, ran } = listing(["github_github_commit_prepare", "gitlab_gitlab_commit_prepare"]);
    const cases: Array<[string, string]> = [
      ["github.file.commit", "github_github_commit_prepare"],
      ["gitlab.commit.create", "gitlab_gitlab_commit_prepare"],
      ["github.issue.get", "github_github_commit_prepare"],
      ["search.run", "gitlab_gitlab_commit_prepare"],
    ];
    for (const [type, key] of cases) {
      await expect(d.dispatch(call(type, key))).rejects.toThrow("ERR_PREPARE_OUTSIDE_STEP");
    }
    expect(ran).toEqual([]);
  });

  test("a before-state read cannot reach a prepare tool either (it is not a read verb)", async () => {
    const { d, ran } = listing(["github_github_commit_prepare"]);
    await expect(
      d.dispatch(call("github.before.read", "github_github_commit_prepare")),
    ).rejects.toThrow("ERR_BEFORE_READ_NOT_A_READ");
    expect(ran).toEqual([]);
  });

  test("github.write.prepare resolving to gitlab_commit_prepare is ERR_PREPARE_SERVICE_MISMATCH", async () => {
    const { d, ran } = listing(["gitlab_gitlab_commit_prepare", "github_github_commit_prepare"]);
    await expect(
      d.dispatch(call("github.write.prepare", "gitlab_gitlab_commit_prepare")),
    ).rejects.toThrow("ERR_PREPARE_SERVICE_MISMATCH");
    await expect(
      d.dispatch(call("gitlab.write.prepare", "github_github_commit_prepare")),
    ).rejects.toThrow("ERR_PREPARE_SERVICE_MISMATCH");
    expect(ran).toEqual([]);
  });

  test("a prepare type never reaches the plain files read or the write", async () => {
    const { d, ran } = listing(["github_github_files_get", "github_github_file_commit"]);
    for (const key of ["github_github_files_get", "github_github_file_commit"]) {
      await expect(d.dispatch(call("github.write.prepare", key))).rejects.toThrow(
        "ERR_PREPARE_NOT_A_PREPARE_TOOL",
      );
    }
    expect(ran).toEqual([]);
  });
});
