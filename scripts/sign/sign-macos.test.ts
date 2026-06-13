import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-sign-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("sign-macos.sh skips (exit 0 + warning) when no cert secrets are present", () => {
  const target = join(dir, "nimbus-headless-macos-x64.pkg");
  writeFileSync(target, "PKG");
  const r = spawnSync("bash", ["scripts/sign/sign-macos.sh", target], {
    encoding: "utf8",
    env: { ...process.env, APPLE_CERT_P12_BASE64: "", APPLE_TEAM_ID: "" },
  });
  expect(r.status).toBe(0);
  expect(`${r.stdout}${r.stderr}`).toContain("signing skipped");
});

test("sign-macos.sh errors on a missing target argument", () => {
  const r = spawnSync("bash", ["scripts/sign/sign-macos.sh"], { encoding: "utf8" });
  expect(r.status).not.toBe(0);
});
