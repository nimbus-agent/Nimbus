import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { pagerdutyChildEnv } from "./connector-spawns.ts";

describe("pagerdutyChildEnv (C1: the From e-mail PagerDuty needs on every write)", () => {
  test("carries the token and, when stored, the trimmed From e-mail", () => {
    const env = pagerdutyChildEnv(" tok ", " oncall@example.com ");
    expect(env["PAGERDUTY_API_TOKEN"]).toBe("tok");
    expect(env["PAGERDUTY_FROM_EMAIL"]).toBe("oncall@example.com");
  });

  test("an absent or blank e-mail leaves the variable out entirely (reads still work)", () => {
    for (const email of [null, "", "   "]) {
      const env = pagerdutyChildEnv("tok", email);
      expect(env["PAGERDUTY_API_TOKEN"], String(email)).toBe("tok");
      expect(Object.hasOwn(env, "PAGERDUTY_FROM_EMAIL"), String(email)).toBe(false);
    }
  });

  test("ensurePagerdutyMcp reads the Vault key pagerduty.from_email into that helper", () => {
    const src = stripComments(readFileSync(join(import.meta.dir, "connector-spawns.ts"), "utf8"));
    const body = src.slice(src.indexOf("export async function ensurePagerdutyMcp"));
    const fn = body.slice(0, body.indexOf("export async function", 10));
    expect(fn).toMatch(
      /const fromEmail = await readConnectorSecret\(ctx\.vault, "pagerduty", "from_email"\)/,
    );
    expect(fn).toMatch(/pagerdutyChildEnv\(\s*tok,\s*fromEmail\s*\)/);
  });
});
