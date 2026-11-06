import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { pagerdutyEnvExtras } from "./connector-spawns.ts";

describe("pagerdutyEnvExtras (C1: the From e-mail PagerDuty needs on every write)", () => {
  test("carries the token and, when stored, the trimmed From e-mail", () => {
    const env = pagerdutyEnvExtras(" tok ", " oncall@example.com ");
    expect(env["PAGERDUTY_API_TOKEN"]).toBe("tok");
    expect(env["PAGERDUTY_FROM_EMAIL"]).toBe("oncall@example.com");
  });

  test("an absent or blank e-mail leaves the variable out entirely (reads still work)", () => {
    for (const email of [null, "", "   "]) {
      const env = pagerdutyEnvExtras("tok", email);
      expect(env["PAGERDUTY_API_TOKEN"], String(email)).toBe("tok");
      expect(Object.hasOwn(env, "PAGERDUTY_FROM_EMAIL"), String(email)).toBe(false);
    }
  });

  test("a stored e-mail that is not a valid From address is left out too", () => {
    for (const email of ["nope", "a@b", "a b@c.co", "a@@b.co"]) {
      const env = pagerdutyEnvExtras("tok", email);
      expect(Object.hasOwn(env, "PAGERDUTY_FROM_EMAIL"), email).toBe(false);
      expect(env["PAGERDUTY_API_TOKEN"]).toBe("tok");
    }
  });

  test("ensurePagerdutyMcp reads the Vault key pagerduty.from_email into that helper", () => {
    const src = stripComments(readFileSync(join(import.meta.dir, "connector-spawns.ts"), "utf8"));
    const body = src.slice(src.indexOf("export async function ensurePagerdutyMcp"));
    const fn = body.slice(0, body.indexOf("export async function", 10));
    expect(fn).toMatch(
      /const fromEmail = await readConnectorSecret\(ctx\.vault, "pagerduty", "from_email"\)/,
    );
    expect(fn).toMatch(
      /env:\s*extensionProcessEnv\(\s*pagerdutyEnvExtras\(\s*tok,\s*fromEmail\s*\)\s*\)/,
    );
  });
});
