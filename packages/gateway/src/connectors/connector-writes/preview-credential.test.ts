import { describe, expect, test } from "bun:test";

import { buildConnectorWritePreview, renderConnectorWritePreviewLines } from "./preview.ts";
import { previewCredentialResolver } from "./preview-credential.ts";

const deps = { credentialFor: () => ({ credential: "personal" as const }) };

describe("previewCredentialResolver", () => {
  test("github gets the mesh's instance; github.com (undefined) keeps today's plain string", () => {
    expect(
      previewCredentialResolver(deps, { githubInstance: () => "ghe.example.com" })("github"),
    ).toEqual({
      credential: "personal",
      instance: "ghe.example.com",
    });
    expect(previewCredentialResolver(deps, { githubInstance: () => undefined })("github")).toBe(
      "personal",
    );
  });

  test("a non-github service never gets an Instance from the github resolver", () => {
    const resolver = previewCredentialResolver(deps, { githubInstance: () => "ghe.example.com" });
    for (const service of ["gitlab", "jira", "slack", "github_actions"]) {
      expect(resolver(service)).toBe("personal");
    }
    const p = buildConnectorWritePreview(
      {
        type: "gitlab.issue.note.create",
        origin: "model",
        payload: {
          mcpToolId: "gitlab_issue_note_create",
          input: { projectPath: "g/r", issueIid: 7, body: "x" },
        },
      },
      resolver,
    );
    expect(p && renderConnectorWritePreviewLines(p).join("\n")).not.toContain("Instance:");
  });

  test("the credential pin still decides the Credential line (team)", () => {
    const resolver = previewCredentialResolver(
      { credentialFor: () => ({ credential: "team" }) },
      { githubInstance: () => "ghe.example.com" },
    );
    expect(resolver("github")).toEqual({ credential: "team", instance: "ghe.example.com" });
  });
});
