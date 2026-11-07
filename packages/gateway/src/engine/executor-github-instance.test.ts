/**
 * The consent prompt names the instance of the credential that WILL RUN (I2/I19): the owner's GHES for
 * a personal write, the pinned TEAM entry's base for a team write (never the owner's), read fresh at
 * prompt time, and a present-but-invalid base refuses the write before any prompt.
 */
import { describe, expect, test } from "bun:test";

import { previewCredentialResolver } from "../connectors/connector-writes/preview-credential.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { createMockVault } from "../vault/mock.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

const write: PlannedAction = {
  type: "github.issue.comment.create",
  origin: "model",
  payload: {
    mcpToolId: "github_issue_comment_create",
    input: { owner: "acme", repo: "web", issueNumber: 7, body: "hello" },
  },
};

async function setup(
  pin: { credential: "personal" | "team"; teamEntry?: string },
  vaultEntries: Record<string, string>,
  meshInstance?: string,
) {
  const vault = createMockVault();
  for (const [k, v] of Object.entries(vaultEntries)) await vault.set(k, v);
  const prompts: string[] = [];
  const dispatched: string[] = [];
  const consent: ConsentChannel = {
    requestApproval: async (p: string) => {
      prompts.push(p);
      return true;
    },
  };
  const audit: AuditSink = { recordAudit: () => {} };
  const connectors: ConnectorDispatcher = {
    dispatch: async (a) => {
      dispatched.push(a.type);
      return { ok: true };
    },
  };
  const sink: EgressSink = { append: () => {} };
  const resolver = previewCredentialResolver(
    { credentialFor: () => pin, vault },
    { githubInstance: () => meshInstance },
  );
  const exec = new ToolExecutor(
    consent,
    audit,
    connectors,
    undefined,
    sink,
    NO_POLICY_OVERLAY,
    resolver,
  );
  return { exec, vault, prompts, dispatched };
}

describe("the github consent prompt names the instance that will run", () => {
  test("personal: the owner's GHES base, read fresh, even when the snapshot is stale", async () => {
    const h = await setup(
      { credential: "personal" },
      { "github.api_base": "https://b.example.com" },
      "a.example.com",
    );
    await h.exec.execute(write);
    expect(h.prompts[0]).toContain("Instance: b.example.com");
    expect(h.prompts[0]).not.toContain("a.example.com");
  });

  test("a base change is shown by the very next prompt", async () => {
    const h = await setup(
      { credential: "personal" },
      { "github.api_base": "https://a.example.com" },
    );
    await h.exec.execute(write);
    await h.vault.set("github.api_base", "https://b.example.com");
    await h.exec.execute(write);
    expect(h.prompts[0]).toContain("Instance: a.example.com");
    expect(h.prompts[1]).toContain("Instance: b.example.com");
  });

  test("team entry on github.com while the owner is on GHES A: no owner host, no Instance line", async () => {
    const h = await setup(
      { credential: "team", teamEntry: "prod" },
      { "github.api_base": "https://a.example.com", "teamvault.prod.github.pat": "T" },
      "a.example.com",
    );
    await h.exec.execute(write);
    expect(h.prompts[0]).toContain("Credential: team");
    expect(h.prompts[0]).not.toContain("a.example.com");
    expect(h.prompts[0]).not.toContain("Instance:");
  });

  test("team entry on GHES B while the owner is on GHES A: names B", async () => {
    const h = await setup(
      { credential: "team", teamEntry: "prod" },
      {
        "github.api_base": "https://a.example.com",
        "teamvault.prod.github.pat": "T",
        "teamvault.prod.github.api_base": "https://b.example.com:8443",
      },
      "a.example.com",
    );
    await h.exec.execute(write);
    expect(h.prompts[0]).toContain("Instance: b.example.com:8443");
    expect(h.prompts[0]).not.toContain("a.example.com");
  });

  test("a team entry with an invalid base is refused before any prompt, nothing dispatched", async () => {
    const h = await setup(
      { credential: "team", teamEntry: "prod" },
      {
        "teamvault.prod.github.pat": "T",
        "teamvault.prod.github.api_base": "http://evil.example.com",
      },
    );
    const r = await h.exec.execute(write);
    expect(h.prompts).toEqual([]);
    expect(h.dispatched).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("evil.example.com");
  });
});
