import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEMO_CONNECTOR_READS, demoRefusal } from "./demo-gate.ts";
import { RpcMethodError } from "./rpc-error.ts";

/** Every `connector.<x>` literal the IPC layer handles — DERIVED from source, never hand-listed. */
function connectorMethodsInSource(): string[] {
  const root = join(import.meta.dir, "..");
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/"(connector\.[A-Za-z]+)"/g)) {
          if (m[1] !== undefined) found.add(m[1]);
        }
      }
    }
  };
  walk(root);
  return [...found].sort();
}

describe("demoRefusal", () => {
  test("the derived connector method set is non-trivial (premise)", () => {
    const all = connectorMethodsInSource();
    expect(all).toContain("connector.auth");
    expect(all).toContain("connector.sync");
    expect(all).toContain("connector.listStatus");
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  test("every connector method outside the read allow-list is refused", () => {
    for (const method of connectorMethodsInSource()) {
      const r = demoRefusal(method);
      if (DEMO_CONNECTOR_READS.has(method)) expect(r).toBeUndefined();
      else {
        expect(r).toBeInstanceOf(RpcMethodError);
        expect(r?.message).toContain("ERR_DEMO_FORBIDDEN");
      }
    }
  });

  test("a connector method that does not exist yet is refused (allow-list, not deny-list)", () => {
    expect(demoRefusal("connector.someFutureWrite")).toBeInstanceOf(RpcMethodError);
  });

  test.each(["vault.set", "vault.delete", "data.import", "extension.install"])(
    "%s is refused",
    (m) => {
      expect(demoRefusal(m)?.rpcCode).toBe(-32000);
    },
  );

  test.each([
    "gateway.ping",
    "agents.oncall",
    "vault.get",
    "diag.snapshot",
    "connector.listStatus",
  ])("%s is allowed", (m) => {
    expect(demoRefusal(m)).toBeUndefined();
  });
});
