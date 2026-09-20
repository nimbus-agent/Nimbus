import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultLocalAuthHostDeps } from "./local-auth-host.ts";

describe("defaultLocalAuthHostDeps", () => {
  test("readFile returns text, or null for a missing file (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-localauth-host-"));
    try {
      const f = join(dir, "hosts.yml");
      writeFileSync(f, "github.com:\n  user: a\n");
      const deps = defaultLocalAuthHostDeps();
      expect(deps.readFile(f)).toContain("github.com");
      expect(deps.readFile(join(dir, "absent.yml"))).toBeNull();
      expect(deps.exists(f)).toBe(true);
      expect(deps.exists(join(dir, "absent.yml"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("which answers false for a binary that cannot exist", () => {
    expect(defaultLocalAuthHostDeps().which("nimbus-no-such-cli-8f3a")).toBe(false);
  });

  test("run resolves ok:false for a missing binary instead of throwing", async () => {
    const r = await defaultLocalAuthHostDeps().run(["nimbus-no-such-cli-8f3a"], {});
    expect(r.ok).toBe(false);
  });

  test("platform and homeDir come from the process", () => {
    const deps = defaultLocalAuthHostDeps();
    expect(deps.platform).toBe(process.platform);
    expect(deps.homeDir.length).toBeGreaterThan(0);
  });
});
