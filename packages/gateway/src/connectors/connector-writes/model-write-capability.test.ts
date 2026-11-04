import { describe, expect, test } from "bun:test";

import { parsePolicyToml } from "../../policy/policy-toml.ts";
import { AI_V2_CAPABILITIES } from "../../policy/types.ts";
import {
  CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY,
  isConnectorWriteModelAccessEnabled,
} from "./model-write-capability.ts";

describe("isConnectorWriteModelAccessEnabled", () => {
  test("an absent accessor is locked off (fail-closed)", () => {
    expect(isConnectorWriteModelAccessEnabled(undefined)).toBe(false);
  });

  test("a policy that disables it locks it off; an open policy allows it", () => {
    expect(
      isConnectorWriteModelAccessEnabled({
        capabilitiesDisabled: new Set(["connector_write_model_access"]),
      }),
    ).toBe(false);
    expect(isConnectorWriteModelAccessEnabled({ capabilitiesDisabled: new Set() })).toBe(true);
  });

  test("the name is an AI v2 capability that parses to a lock-off", () => {
    expect([...AI_V2_CAPABILITIES]).toContain(CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY);
    const parsed = parsePolicyToml(
      `[policy]\nversion=1\norg="x"\n[policy.capabilities.ai_v2]\nconnector_write_model_access=false\n`,
    );
    expect(parsed.capabilities.disabled).toContain("connector_write_model_access");
  });
});
