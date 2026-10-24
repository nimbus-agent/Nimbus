import { describe, expect, test } from "bun:test";
import { ROLE_PACK_ID_RE } from "@nimbus-dev/registry-format";

import { PACK_ID_RE } from "../config/pack-settable.ts";

describe("pack id format parity", () => {
  test("registry-format ROLE_PACK_ID_RE equals the gateway PACK_ID_RE", () => {
    expect(ROLE_PACK_ID_RE.source).toBe(PACK_ID_RE.source);
    expect(ROLE_PACK_ID_RE.flags).toBe(PACK_ID_RE.flags);
  });
});
