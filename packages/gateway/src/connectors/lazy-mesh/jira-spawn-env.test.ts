import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { jiraCloudIdEnv } from "./connector-spawns.ts";

const CLOUD_ID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("jiraCloudIdEnv (C3: the cloud id the Operations alert tools need)", () => {
  test("a valid stored id (trimmed) becomes JIRA_CLOUD_ID", () => {
    expect(jiraCloudIdEnv(` ${CLOUD_ID} `)).toEqual({ JIRA_CLOUD_ID: CLOUD_ID });
  });

  test("an absent, blank or malformed id leaves the variable out entirely, so discovery still works", () => {
    for (const stored of [null, "", "   ", "nope", `${CLOUD_ID}/`, "../x", `${CLOUD_ID}0`]) {
      const env = jiraCloudIdEnv(stored);
      expect(Object.hasOwn(env, "JIRA_CLOUD_ID"), String(stored)).toBe(false);
      expect(env, String(stored)).toEqual({});
    }
  });

  test("ensureJiraMcp reads jira.cloud_id null-safely and passes the extras through extensionProcessEnv", () => {
    const src = stripComments(readFileSync(join(import.meta.dir, "connector-spawns.ts"), "utf8"));
    const body = src.slice(src.indexOf("export async function ensureJiraMcp"));
    const fn = body.slice(0, body.indexOf("export async function", 10));
    expect(fn).toMatch(/await readConnectorSecret\(ctx\.vault, "jira", "cloud_id"\)/);
    expect(fn).toMatch(/\.\.\.jiraCloudIdEnv\(/);
    expect(fn).toMatch(/env:\s*extensionProcessEnv\(\{/);
    // The only credential variables the Jira child gets are these four (I1).
    const keys = [...fn.matchAll(/\bJIRA_[A-Z_]+/g)].map((m) => m[0]);
    expect(new Set(keys)).toEqual(new Set(["JIRA_API_TOKEN", "JIRA_EMAIL", "JIRA_BASE_URL"]));
  });
});
