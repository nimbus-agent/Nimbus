import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newCaptureId } from "./capture-id.ts";

test("newCaptureId is cap_ plus 32 hex digits (128 random bits)", () => {
  expect(newCaptureId()).toMatch(/^cap_[0-9a-f]{32}$/);
});

test("10,000 draws are distinct", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) seen.add(newCaptureId());
  expect(seen.size).toBe(10_000);
});

test("the source draws 16 bytes from node:crypto, not a UUID v4 (122 bits)", () => {
  const src = readFileSync(join(import.meta.dir, "capture-id.ts"), "utf8");
  expect(src).toContain("node:crypto");
  expect(src).toContain("randomBytes(16)");
  expect(src).not.toContain("randomUUID");
});
