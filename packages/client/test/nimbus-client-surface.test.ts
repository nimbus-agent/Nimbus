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

  test("instance exposes egress read methods", () => {
    const proto = NimbusClient.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.egressHead).toBe("function");
    expect(typeof proto.egressList).toBe("function");
    expect(typeof proto.egressVerify).toBe("function");
    expect(typeof proto.egressProveWindow).toBe("function");
  });
});
