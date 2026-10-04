import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
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

describe("nimbus team vault revoke (Task 18b)", () => {
  it("vault revoke calls teamvault.revoke with parsed args", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["vault", "revoke", "prod-aws", "peer:abc", "aws.ec2.instance.stop"], {
      client,
    });
    expect(calls[0]).toEqual({
      method: "teamvault.revoke",
      params: { entry: "prod-aws", peerId: "peer:abc", toolId: "aws.ec2.instance.stop" },
    });
  });
});

describe("nimbus team purge (Task 21)", () => {
  it("purge --yes calls team.purge without prompting", async () => {
    const { client, calls } = fakeClient();
    await runTeamCommand(["purge", "--user", "u123", "--yes"], { client });
    expect(calls[0]).toEqual({
      method: "team.purge",
      params: { externalId: "u123" },
    });
  });
});

describe("runTeamCommand -- what the operator is told", () => {
  const streams = createStreamCapture();
  beforeEach(() => {
    streams.stdoutChunks.length = 0;
    streams.stderrChunks.length = 0;
    streams.install();
  });
  afterEach(() => {
    streams.restore();
  });

  function clientReturning(result: unknown): {
    client: TeamRpcClient;
    calls: Array<{ method: string; params: unknown }>;
  } {
    const calls: Array<{ method: string; params: unknown }> = [];
    return {
      calls,
      client: {
        call: async (method: string, params?: unknown) => {
          calls.push({ method, params });
          return result as never;
        },
      },
    };
  }

  it("deny answers BOTH brokers as a denial, as the --as peer, and says denied", async () => {
    const { client, calls } = clientReturning({ ok: true });
    await runTeamCommand(["deny", "req-9", "--as", "peer:bob"], { client });
    const params = { requestId: "req-9", peerId: "peer:bob", approved: false };
    expect(calls).toEqual([
      { method: "federation.approvalRespond", params },
      { method: "federation.quorumRespond", params },
    ]);
    expect(streams.stdoutChunks.join("")).toBe("denied req-9\n");
  });

  it("purge reports the job id and the revoked-grant count the gateway returned", async () => {
    const { client } = clientReturning({ jobId: "job-7", localDeleted: 3 });
    await runTeamCommand(["purge", "--user", "u1", "--yes"], { client });
    expect(streams.stdoutChunks.join("")).toBe(
      "GDPR purge started for u1: job job-7 (3 local grant(s) revoked)\n",
    );
  });

  it("purge states placeholders, never 'undefined', when the gateway omits both", async () => {
    const { client } = clientReturning({});
    await runTeamCommand(["purge", "--user", "u1", "--force"], { client });
    expect(streams.stdoutChunks.join("")).toBe(
      "GDPR purge started for u1: job ? (0 local grant(s) revoked)\n",
    );
  });

  it("a federation subcommand is refused by name before any call, never silently dropped", async () => {
    const { client, calls } = clientReturning({ ok: true });
    await expect(runTeamCommand(["discover"], { client })).rejects.toThrow(
      "runTeamCommand does not handle subcommand: discover",
    );
    expect(calls).toEqual([]);
    expect(streams.stdoutChunks).toEqual([]);
  });
});
