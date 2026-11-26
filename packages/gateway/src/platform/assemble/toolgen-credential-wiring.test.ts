import { describe, expect, test } from "bun:test";
import { toolCredentialKey } from "../../toolgen/toolgen-credentials.ts";
import type { ToolCredentialParam } from "../../toolgen/toolgen-types.ts";
import {
  createBindToolCredentials,
  createRevokeToolCredentials,
} from "./toolgen-credential-wiring.ts";

const BINDING = { header: "authorization", scheme: "Bearer", secret: "s" } as unknown;

describe("toolgen credential wiring", () => {
  test("bind writes every host in order and returns them", async () => {
    const written: string[] = [];
    const bind = createBindToolCredentials({
      set: async (key: string) => {
        written.push(key);
      },
    } as never);
    const creds = [
      { host: "a.example.com", binding: BINDING },
      { host: "b.example.com", binding: BINDING },
    ] as unknown as ToolCredentialParam[];
    expect(await bind("t1", creds)).toEqual(["a.example.com", "b.example.com"]);
    expect(written).toEqual([
      toolCredentialKey("t1", "a.example.com"),
      toolCredentialKey("t1", "b.example.com"),
    ]);
  });

  test("bind stops at the first failure", async () => {
    const written: string[] = [];
    const bind = createBindToolCredentials({
      set: async (key: string) => {
        written.push(key);
        throw new Error("vault down");
      },
    } as never);
    const creds = [
      { host: "a.example.com", binding: BINDING },
      { host: "b.example.com", binding: BINDING },
    ] as unknown as ToolCredentialParam[];
    await expect(bind("t1", creds)).rejects.toThrow("vault down");
    expect(written).toHaveLength(1);
  });

  test("revoke attempts every host and rethrows the last error afterwards", async () => {
    const seen: string[] = [];
    const revoke = createRevokeToolCredentials({
      delete: async (key: string) => {
        seen.push(key);
        throw new Error(`fail ${key}`);
      },
    } as never);
    await expect(revoke("t1", ["a.example.com", "b.example.com"])).rejects.toThrow(
      `fail ${toolCredentialKey("t1", "b.example.com")}`,
    );
    expect(seen).toHaveLength(2);
  });

  test("revoke with nothing failing resolves", async () => {
    const revoke = createRevokeToolCredentials({ delete: async () => {} } as never);
    await revoke("t1", ["a.example.com"]);
  });
});
