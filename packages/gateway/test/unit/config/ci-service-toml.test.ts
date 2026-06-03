import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadNimbusServiceConfigsFromConfigDir,
  parseNimbusCiServiceToml,
  parseNimbusDoraToml,
} from "../../../src/config/nimbus-toml.ts";

describe("[ci.service.<id>] alias parser", () => {
  it("parses one service entry with all keys", () => {
    const raw = `
[ci.service.payment-service]
repos = ["github:nimbus-agent/payments"]
pagerduty_services = ["P12ABCD"]
deploy_workflow_pattern = "^Release"
incident_window_minutes = 90
exclude_pr_labels = ["revert", "rollback"]
`;
    const parsed = parseNimbusCiServiceToml(raw);
    expect(parsed.size).toBe(1);
    const cfg = parsed.get("payment-service");
    if (cfg === undefined) throw new Error("payment-service missing");
    expect(cfg.repos.map((r) => `${r.provider}:${r.providerId}`)).toEqual([
      "github:nimbus-agent/payments",
    ]);
    expect(cfg.pagerdutyServices).toEqual(["P12ABCD"]);
    expect(cfg.incidentWindowMinutes).toBe(90);
  });

  it("returns an empty Map when no [ci.service.*] tables present", () => {
    expect(parseNimbusCiServiceToml('[user]\nme_person_id = "alice"\n').size).toBe(0);
  });

  it("rejects an unknown key", () => {
    const raw = `
[ci.service.bad]
repos = ["github:org/svc"]
mystery = "yes"
`;
    expect(() => parseNimbusCiServiceToml(raw)).toThrow(/unknown key/i);
  });

  it("rejects an empty service id in [ci.service.]", () => {
    expect(() => parseNimbusCiServiceToml(`[ci.service.]\nrepos = ["github:org/x"]\n`)).toThrow(
      /empty service id/i,
    );
  });

  it("rejects an invalid deploy_workflow_pattern regex via the CI parser path", () => {
    const raw = `
[ci.service.bad-regex]
repos = ["github:org/svc"]
deploy_workflow_pattern = "["
`;
    expect(() => parseNimbusCiServiceToml(raw)).toThrow(/deploy_workflow_pattern/);
  });

  it("rejects an out-of-range incident_window_minutes via the CI parser path", () => {
    const raw = `
[ci.service.bad-window]
repos = ["github:org/svc"]
incident_window_minutes = 1441
`;
    expect(() => parseNimbusCiServiceToml(raw)).toThrow(/incident_window_minutes/);
  });

  it("fills in all defaults when only 'repos' is set", () => {
    const raw = `
[ci.service.defaults]
repos = ["github:org/d"]
`;
    const parsed = parseNimbusCiServiceToml(raw);
    const cfg = parsed.get("defaults");
    if (cfg === undefined) throw new Error("defaults missing");
    expect(cfg.pagerdutyServices).toEqual([]);
    expect(cfg.incidentWindowMinutes).toBe(60);
    expect(cfg.excludePrLabels).toEqual(["revert"]);
    expect("Deploy production".match(cfg.deployWorkflowPattern)).not.toBeNull();
  });
});

describe("loadNimbusServiceConfigsFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-cfg-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("unions [metrics.dora.<id>] and [ci.service.<id>] blocks", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[metrics.dora.svc-a]
repos = ["github:org/a"]

[ci.service.svc-b]
repos = ["gitlab:org/b"]
`,
    );
    const merged = loadNimbusServiceConfigsFromConfigDir(dir);
    expect(merged.size).toBe(2);
    expect(merged.get("svc-a")?.repos[0]?.provider).toBe("github");
    expect(merged.get("svc-b")?.repos[0]?.provider).toBe("gitlab");
  });

  it("on same id, [ci.service.<id>] wins and a warning is written to stderr", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[metrics.dora.svc-a]
repos = ["github:org/dora-version"]

[ci.service.svc-a]
repos = ["gitlab:org/ci-version"]
`,
    );
    const warnings: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const merged = loadNimbusServiceConfigsFromConfigDir(dir);
      expect(merged.get("svc-a")?.repos[0]?.provider).toBe("gitlab");
    } finally {
      process.stderr.write = orig;
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/svc-a/);
    expect(warnings[0]).toMatch(/ci\.service/);
  });

  it("returns empty Map when nimbus.toml is missing", () => {
    expect(loadNimbusServiceConfigsFromConfigDir(dir).size).toBe(0);
  });
});

describe("ServiceConfig shape parsed from dora blocks", () => {
  it("parses dora blocks through the ServiceConfig shape", () => {
    const raw = `
[metrics.dora.svc-c]
repos = ["github:org/c"]
`;
    const parsed = parseNimbusDoraToml(raw);
    const cfg = parsed.get("svc-c");
    if (cfg === undefined) throw new Error("svc-c missing");
    expect(cfg.serviceId).toBe("svc-c");
  });
});
