import { describe, expect, test } from "bun:test";
import { ToolgenConsentBroker, ToolgenSaveConsentBroker } from "./toolgen-consent-broker.ts";

describe("ToolgenConsentBroker", () => {
  test("broadcasts the VERBATIM body and the host list", async () => {
    const b = new ToolgenConsentBroker();
    let seen: Record<string, unknown> | undefined;
    b.setBroadcast((method, params) => {
      expect(method).toBe("toolgen.approvalRequest");
      seen = params as Record<string, unknown>;
      b.respond(String(seen["requestId"]), true);
    });
    await b.request(
      {
        toolId: "tg_a",
        toolName: "t",
        description: "d",
        body: "VERBATIM-BODY",
        approvedHosts: ["api.example.com"],
        credentialHosts: [],
        inputSchema: { type: "object", properties: {} },
        grounding: { kind: "description_only" },
        initiator: "owner",
      },
      1000,
    );
    expect(seen?.["body"]).toBe("VERBATIM-BODY");
    expect(seen?.["approvedHosts"]).toEqual(["api.example.com"]);
  });

  test("resolves FALSE on TTL expiry — fail-closed", async () => {
    const b = new ToolgenConsentBroker();
    b.setBroadcast(() => {});
    expect(
      await b.request(
        {
          toolId: "tg_a",
          toolName: "t",
          description: "d",
          body: "x",
          approvedHosts: [],
          credentialHosts: [],
          inputSchema: { type: "object", properties: {} },
          grounding: { kind: "description_only" },
          initiator: "owner",
        },
        10,
      ),
    ).toBe(false);
  });
});

describe("ToolgenSaveConsentBroker", () => {
  test("broadcasts under its OWN method — never the create broker's", async () => {
    const b = new ToolgenSaveConsentBroker();
    let seenMethod: string | undefined;
    let seen: Record<string, unknown> | undefined;
    b.setBroadcast((method, params) => {
      seenMethod = method;
      seen = params as Record<string, unknown>;
      b.respond(String(seen["requestId"]), true);
    });
    await b.request(
      {
        toolId: "tg_a",
        toolName: "t",
        description: "d",
        body: "VERBATIM-BODY",
        approvedHosts: ["api.example.com"],
        credentialHosts: [],
        inputSchema: { type: "object", properties: {} },
        grounding: { kind: "description_only" },
        initiator: "owner",
        persistence: true,
      },
      1000,
    );
    expect(seenMethod).toBe("toolgen.saveApprovalRequest");
    expect(seenMethod).not.toBe("toolgen.approvalRequest");
    expect(seen?.["body"]).toBe("VERBATIM-BODY");
    // The one fact create never disclosed: this grant survives every future session.
    expect(seen?.["persistence"]).toBe(true);
  });

  test("resolves FALSE on TTL expiry — fail-closed, same as the create broker", async () => {
    const b = new ToolgenSaveConsentBroker();
    b.setBroadcast(() => {});
    expect(
      await b.request(
        {
          toolId: "tg_a",
          toolName: "t",
          description: "d",
          body: "x",
          approvedHosts: [],
          credentialHosts: [],
          inputSchema: { type: "object", properties: {} },
          grounding: { kind: "description_only" },
          initiator: "owner",
          persistence: true,
        },
        10,
      ),
    ).toBe(false);
  });
});
