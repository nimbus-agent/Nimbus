import { describe, expect, test } from "bun:test";
import { parsePolicyToml } from "./policy-toml.ts";
import { AI_V2_CAPABILITIES } from "./types.ts";

describe("AI_V2_CAPABILITIES", () => {
  test("agent_fleet is a lockoff-able ai_v2 capability", () => {
    expect([...AI_V2_CAPABILITIES]).toContain("agent_fleet");
    expect(AI_V2_CAPABILITIES).toHaveLength(7);
  });

  test("user_mcp_model_access is a lockoff-able ai_v2 capability that parses to a lockoff", () => {
    expect([...AI_V2_CAPABILITIES]).toContain("user_mcp_model_access");
    const parsed = parsePolicyToml(
      `[policy]\nversion=1\norg="x"\n[policy.capabilities.ai_v2]\nuser_mcp_model_access=false\n`,
    );
    expect(parsed.capabilities.disabled).toContain("user_mcp_model_access");
  });

  /**
   * The membership assertion above proves the NAME is spelled the same in the constant; this
   * proves the constant is the thing the PARSER consults. `policy-toml.ts` drops any
   * `[policy.capabilities.ai_v2]` key that is not a member, so a capability added to the enum but
   * not reaching the parser would be a lockoff an admin can sign, see verify, and never get —
   * the failure mode the constant's own doc comment exists to prevent.
   */
  test("an `[policy.capabilities.ai_v2] agent_fleet = false` block actually parses to a lockoff", () => {
    const parsed = parsePolicyToml(
      `[policy]\nversion=1\norg="x"\n[policy.capabilities.ai_v2]\nagent_fleet=false\n`,
    );
    expect(parsed.capabilities.disabled).toContain("agent_fleet");
  });

  test("a typo next to it is still ignored rather than carried", () => {
    const parsed = parsePolicyToml(
      `[policy]\nversion=1\norg="x"\n[policy.capabilities.ai_v2]\nagent_fleets=false\n`,
    );
    expect(parsed.capabilities.disabled).toEqual([]);
  });
});
