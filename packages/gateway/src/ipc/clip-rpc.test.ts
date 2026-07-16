import { describe, expect, test } from "bun:test";
import { PairingWindowController } from "../clips/pairing-window.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchClipRpc } from "./clip-rpc.ts";

function fakeVault(seed: Record<string, string> = {}): NimbusVault {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async () => [...store.keys()],
  };
}

function deps() {
  return {
    pairing: new PairingWindowController({ nowMs: () => 1000, genCode: () => "654321" }),
    vault: fakeVault(),
  };
}

describe("dispatchClipRpc", () => {
  test("clip.pair opens a window and returns the code + label", async () => {
    const d = deps();
    const out = await dispatchClipRpc("clip.pair", { label: "chrome" }, d);
    expect(out).toEqual({
      kind: "hit",
      value: { code: "654321", expiresAtMs: 1000 + 120_000, label: "chrome" },
    });
    expect(d.pairing.isOpen()).toBe(true);
  });

  test("clip.pair echoes the gatewayUrl when httpBaseUrl is wired", async () => {
    const d = { ...deps(), httpBaseUrl: "http://127.0.0.1:7474" };
    const out = await dispatchClipRpc("clip.pair", { label: "chrome" }, d);
    expect(out).toEqual({
      kind: "hit",
      value: {
        code: "654321",
        expiresAtMs: 1000 + 120_000,
        label: "chrome",
        gatewayUrl: "http://127.0.0.1:7474",
      },
    });
  });

  test("clip.pair omits gatewayUrl when httpBaseUrl is absent", async () => {
    const out = await dispatchClipRpc("clip.pair", { label: "chrome" }, deps());
    expect((out as { value: Record<string, unknown> }).value).not.toHaveProperty("gatewayUrl");
  });

  test("clip.pair defaults the label when omitted", async () => {
    const out = await dispatchClipRpc("clip.pair", {}, deps());
    expect(out).toMatchObject({ kind: "hit" });
    expect((out as { value: { label: string } }).value.label).toMatch(/^device-/);
  });

  test("clip.status lists fingerprints, never raw tokens", async () => {
    const d = {
      ...deps(),
      vault: fakeVault({ "http_api.web_clipper_tokens": '{"chrome":"secret-tok"}' }),
    };
    const out = await dispatchClipRpc("clip.status", {}, d);
    const value = (out as { value: { devices: Array<{ label: string; fingerprint: string }> } })
      .value;
    expect(value.devices[0]?.label).toBe("chrome");
    expect(JSON.stringify(value)).not.toContain("secret-tok");
  });

  test("clip.revoke removes a label", async () => {
    const d = { ...deps(), vault: fakeVault({ "http_api.web_clipper_tokens": '{"chrome":"t"}' }) };
    const out = await dispatchClipRpc("clip.revoke", { label: "chrome" }, d);
    expect(out).toEqual({ kind: "hit", value: { revoked: 1 } });
  });

  test("clip.pair with an empty-string label falls back to a generated device label", async () => {
    const out = await dispatchClipRpc("clip.pair", { label: "" }, deps());
    expect((out as { value: { label: string } }).value.label).toMatch(/^device-[0-9a-f]{6}$/);
  });

  test("clip.revoke with no label → revoked 0 (no vault touch)", async () => {
    const out = await dispatchClipRpc("clip.revoke", {}, deps());
    expect(out).toEqual({ kind: "hit", value: { revoked: 0 } });
  });

  test("non-object params are tolerated (asRecord → {})", async () => {
    const out = await dispatchClipRpc("clip.status", null, deps());
    expect(out).toMatchObject({ kind: "hit" });
  });

  test("unknown method → miss", async () => {
    expect(await dispatchClipRpc("clip.nope", {}, deps())).toEqual({ kind: "miss" });
  });
});
