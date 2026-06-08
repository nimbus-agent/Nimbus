import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { type PolicyIpc, parsePolicyArgs, runPolicyCommand } from "./policy.ts";

function fakeClient(responses: ReadonlyArray<unknown> = []): {
  client: PolicyIpc;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let idx = 0;
  const client: PolicyIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      const r = idx < responses.length ? responses[idx] : { ok: true };
      idx += 1;
      return r as T;
    },
  };
  return { client, calls };
}

describe("parsePolicyArgs", () => {
  it("defaults to show when no subcommand is given", () => {
    expect(parsePolicyArgs([])).toEqual({ kind: "show" });
  });

  it("parses show", () => {
    expect(parsePolicyArgs(["show"])).toEqual({ kind: "show" });
  });

  it("parses verify", () => {
    expect(parsePolicyArgs(["verify"])).toEqual({ kind: "verify" });
  });

  it("parses sign with a file arg", () => {
    expect(parsePolicyArgs(["sign", "org.toml"])).toEqual({ kind: "sign", file: "org.toml" });
  });

  it("parses push with a file arg (alias of sign)", () => {
    expect(parsePolicyArgs(["push", "org.toml"])).toEqual({ kind: "sign", file: "org.toml" });
  });

  it("parses trust with a pubkey", () => {
    expect(parsePolicyArgs(["trust", "BASE64KEY"])).toEqual({ kind: "trust", pubkey: "BASE64KEY" });
  });

  it("parses refetch", () => {
    expect(parsePolicyArgs(["refetch"])).toEqual({ kind: "refetch" });
  });

  it("throws when sign is given without a file", () => {
    expect(() => parsePolicyArgs(["sign"])).toThrow("Usage: nimbus policy sign <file.toml>");
  });

  it("throws when push is given without a file", () => {
    expect(() => parsePolicyArgs(["push"])).toThrow("Usage: nimbus policy push <file.toml>");
  });

  it("throws when trust is given without a pubkey", () => {
    expect(() => parsePolicyArgs(["trust"])).toThrow("Usage: nimbus policy trust <pubkeyBase64>");
  });

  it("throws on an unknown subcommand", () => {
    expect(() => parsePolicyArgs(["bogus"])).toThrow("Unknown subcommand: bogus");
  });
});

describe("runPolicyCommand", () => {
  const cap = createStreamCapture();

  beforeEach(() => {
    cap.install();
  });
  afterEach(() => {
    cap.restore();
    cap.stdoutChunks.length = 0;
    cap.stderrChunks.length = 0;
  });
  afterAll(() => {
    cap.restore();
  });

  it("show calls policy.show and prints the result", async () => {
    const { client, calls } = fakeClient([{ version: 3, signer: "org" }]);
    await runPolicyCommand(client, { kind: "show" });
    expect(calls[0]).toEqual({ method: "policy.show", params: {} });
    expect(cap.stdoutChunks.join("")).toContain('"version": 3');
  });

  it("verify calls policy.verify and prints the result", async () => {
    const { client, calls } = fakeClient([{ valid: true }]);
    await runPolicyCommand(client, { kind: "verify" });
    expect(calls[0]).toEqual({ method: "policy.verify", params: {} });
    expect(cap.stdoutChunks.join("")).toContain('"valid": true');
  });

  it("sign reads the toml file and calls policy.sign with its content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbus-policy-test-"));
    try {
      const file = join(dir, "org.toml");
      const tomlBody = '[policy]\nname = "acme"\nmax_risk = 2\n';
      await writeFile(file, tomlBody, "utf8");

      const { client, calls } = fakeClient([{ applied: true }]);
      await runPolicyCommand(client, { kind: "sign", file });

      expect(calls[0]?.method).toBe("policy.sign");
      expect(calls[0]?.params).toEqual({ toml: tomlBody });
      const out = cap.stdoutChunks.join("");
      expect(out).toContain("Signed + applied policy:");
      expect(out).toContain('"applied": true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trust calls policy.trust with the pubkey and prints a confirmation", async () => {
    const { client, calls } = fakeClient([undefined]);
    await runPolicyCommand(client, { kind: "trust", pubkey: "BASE64KEY" });
    expect(calls[0]).toEqual({ method: "policy.trust", params: { pubkey: "BASE64KEY" } });
    expect(cap.stdoutChunks.join("")).toContain("Pinned org policy anchor pubkey BASE64KEY");
  });

  it("refetch calls policy.refetch and prints the result", async () => {
    const { client, calls } = fakeClient([{ refetched: true }]);
    await runPolicyCommand(client, { kind: "refetch" });
    expect(calls[0]).toEqual({ method: "policy.refetch", params: {} });
    expect(cap.stdoutChunks.join("")).toContain('"refetched": true');
  });
});
