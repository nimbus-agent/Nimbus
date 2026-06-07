import { describe, expect, it } from "bun:test";
import { parseTeamArgs, runTeamCommand, type TeamRpcClient } from "./team.ts";

function fakeClient(): {
  client: TeamRpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: TeamRpcClient = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return { ok: true } as never;
    },
  };
  return { client, calls };
}

describe("nimbus team vault (Task 18)", () => {
  it("vault grant calls teamvault.grant with parsed args", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["vault", "grant", "prod-aws", "peer:abc", "aws.ec2.instance.stop"], {
      client,
    });
    expect(calls[0]).toEqual({
      method: "teamvault.grant",
      params: { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
    });
  });

  it("vault put parses repeated --secret key=value", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(
      [
        "vault",
        "put",
        "prod-aws",
        "aws",
        "--secret",
        "aws.access_key_id=AKIA",
        "--secret",
        "aws.secret_access_key=shh",
      ],
      { client },
    );
    expect(calls[0]).toEqual({
      method: "teamvault.put",
      params: {
        entry: "prod-aws",
        service: "aws",
        secrets: { "aws.access_key_id": "AKIA", "aws.secret_access_key": "shh" },
      },
    });
  });

  it("vault list calls teamvault.list", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["vault", "list"], { client });
    expect(calls[0]?.method).toBe("teamvault.list");
  });
});

describe("nimbus team invoke (Task 19)", () => {
  it("invoke calls federation.askInvoke with peer/entry/tool/purpose", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(
      ["invoke", "peer:abc", "prod-aws", "aws.ec2.instance.stop", "--purpose", "stop idle"],
      { client },
    );
    expect(calls[0]?.method).toBe("federation.askInvoke");
    expect(calls[0]?.params).toMatchObject({
      peerId: "peer:abc",
      entry: "prod-aws",
      toolId: "aws.ec2.instance.stop",
      purpose: "stop idle",
    });
  });

  it("parses --args as JSON", () => {
    const cmd = parseTeamArgs([
      "invoke",
      "p",
      "e",
      "t",
      "--purpose",
      "x",
      "--args",
      '{"id":"i-1"}',
    ]);
    expect(cmd).toMatchObject({ kind: "invoke", args: { id: "i-1" } });
  });
});

describe("nimbus team delegate/approve (Task 20)", () => {
  it("delegate calls hitl.delegate with a future absolute expiresAt", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["delegate", "peer:bob", "--scope", "service:aws", "--expires", "3600"], {
      client,
    });
    expect(calls[0]?.method).toBe("hitl.delegate");
    const params = calls[0]?.params as { scopeKind: string; scopeValue: string; expiresAt: number };
    expect(params.scopeKind).toBe("service");
    expect(params.scopeValue).toBe("aws");
    expect(params.expiresAt).toBeGreaterThan(Date.now());
  });

  it("approve routes to both approvalRespond and quorumRespond", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["approve", "req-123"], { client });
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("federation.approvalRespond");
    expect(methods).toContain("federation.quorumRespond");
  });

  it("delegations calls hitl.listDelegations", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["delegations"], { client });
    expect(calls[0]?.method).toBe("hitl.listDelegations");
  });
});
