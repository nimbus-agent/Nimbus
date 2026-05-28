import { describe, expect, test } from "bun:test";

import { NimbusClient } from "../src/nimbus-client.ts";

describe("NimbusClient typed surface", () => {
  test("instance exposes new methods", () => {
    expect(typeof (NimbusClient.prototype as unknown as Record<string, unknown>).askStream).toBe(
      "function",
    );
    expect(
      typeof (NimbusClient.prototype as unknown as Record<string, unknown>).subscribeHitl,
    ).toBe("function");
    expect(
      typeof (NimbusClient.prototype as unknown as Record<string, unknown>).getSessionTranscript,
    ).toBe("function");
    expect(typeof (NimbusClient.prototype as unknown as Record<string, unknown>).cancelStream).toBe(
      "function",
    );
  });
});
