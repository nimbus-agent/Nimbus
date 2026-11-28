import { describe, expect, test } from "bun:test";

import { createMockVault } from "../../vault/mock.ts";
import { hasUsableGcpCredentials } from "./gcp-auth.ts";

describe("hasUsableGcpCredentials", () => {
  test("needs credentials AND a project id", async () => {
    const v = createMockVault();
    expect(await hasUsableGcpCredentials(v)).toBe(false);
    await v.set("gcp.auth_source", "gcloud");
    expect(await hasUsableGcpCredentials(v)).toBe(false);
    await v.set("gcp.project_id", " ");
    expect(await hasUsableGcpCredentials(v)).toBe(false);
    await v.set("gcp.project_id", "acme");
    expect(await hasUsableGcpCredentials(v)).toBe(true);
  });
});
