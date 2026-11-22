import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I8 — Tauri renderer CSP is restrictive", () => {
  test("tauri.conf.json sets a non-null, non-unsafe CSP", async () => {
    const raw = await read("packages/ui/src-tauri/tauri.conf.json");
    const conf = JSON.parse(raw) as { app?: { security?: { csp?: string | null } } };
    const csp = conf.app?.security?.csp;
    expect(csp).toBeTypeOf("string");
    expect(csp).not.toBeNull();
    expect(csp ?? "").not.toMatch(/unsafe-inline/);
    expect(csp ?? "").not.toMatch(/unsafe-eval/);
    expect(csp ?? "").toMatch(/default-src 'self'/);
  });
});
