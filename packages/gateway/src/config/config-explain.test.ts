import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainConfig } from "./config-explain.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "./layered-config.ts";

let dir: string;

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-explain-"));
});

afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

function writeBase(text: string): void {
  writeFileSync(join(dir, "nimbus.toml"), text);
}

function writeProfile(name: string, text: string): void {
  writeFileSync(join(dir, `nimbus.${name}.toml`), text);
}

const noEnv = (): string | undefined => undefined;

describe("explainConfig", () => {
  test("names the winning layer and the shadowed value", () => {
    writeBase("[decisions]\nmin_confidence = 0.3\n");
    writeProfile("work", "[decisions]\nmin_confidence = 0.6\n");
    const reader = initLayeredConfig(dir, { explicitProfile: "work" });
    const r = explainConfig(reader, "decisions.min_confidence", noEnv);
    expect(r.runningProfile).toBe("work");
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0];
    expect(e?.value).toBe("0.6");
    expect(e?.source.kind === "layer" && e.source.layer.kind).toBe("profile");
    expect(e?.shadowed[0]?.value).toBe("0.3");
    expect(r.policyMayRestrict).toBe(false);
  });

  test("multi-segment table path", () => {
    writeBase('[connectors.github]\ndepth = "full"\n');
    const r = explainConfig(initLayeredConfig(dir), "connectors.github.depth", noEnv);
    expect(r.entries.map((e) => e.value)).toEqual(['"full"']);
    expect(r.policyMayRestrict).toBe(true);
  });

  test("fleet job by name", () => {
    writeBase('[[fleet.job]]\nname = "a"\nagent = "janitor"\n\n[[fleet.job]]\nname = "b"\n');
    const r = explainConfig(initLayeredConfig(dir), "fleet.job.a", noEnv);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks?.[0]?.layer.kind).toBe("base");
    expect(r.blocks?.[0]?.entries.map((e) => e.path)).toContain("fleet.job.agent");
  });

  test("env override is the top source", () => {
    writeBase("[lan]\nport = 7475\n");
    const env = (k: string) => (k === "NIMBUS_LAN_PORT" ? "9999" : undefined);
    const r = explainConfig(initLayeredConfig(dir), "lan.port", env);
    const e = r.entries[0];
    expect(e?.source).toEqual({ kind: "env", envVar: "NIMBUS_LAN_PORT" });
    expect(e?.value).toBe("9999");
    expect(e?.shadowed[0]?.value).toBe("7475");
  });

  test("ignored env value is not a source", () => {
    writeBase("[updater]\nenabled = true\n");
    const env = (k: string) => (k === "NIMBUS_UPDATER_DISABLE" ? "0" : undefined);
    const r = explainConfig(initLayeredConfig(dir), "updater.enabled", env);
    expect(r.entries[0]?.source.kind).toBe("layer");
    expect(r.notes).toContain(
      'NIMBUS_UPDATER_DISABLE is set to "0" but does not override this value',
    );
  });

  test("policy flag", () => {
    writeBase("[decisions]\nmin_confidence = 0.3\n");
    const reader = initLayeredConfig(dir);
    for (const p of [
      "audit.tool_call_log_retention_days",
      "fleet.retention_days",
      "code_execution.enabled",
      "computer_use.enabled",
      "tool_generation.enabled",
      "multimodal.enabled",
      "fleet.enabled",
      "mcp_sink.enabled",
      'hitl.quorum."x".approvers',
      "hitl.quorum.y.approvers",
      "connectors.github.depth",
    ]) {
      expect(explainConfig(reader, p, noEnv).policyMayRestrict).toBe(true);
    }
    expect(explainConfig(reader, "decisions.min_confidence", noEnv).policyMayRestrict).toBe(false);
  });

  test("no path lists a repeated key once, last value winning", () => {
    writeBase("[a]\nb = 1\nb = 2\n");
    const r = explainConfig(initLayeredConfig(dir), undefined, noEnv);
    const hits = r.entries.filter((e) => e.path === "a.b");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe("2");
    expect(hits[0]?.shadowed[0]?.value).toBe("1");
    expect(hits[0]?.shadowed[0]?.source).toEqual(hits[0]?.source);
  });

  test("ignored env value with no file value still notes", () => {
    writeBase("[a]\nb = 1\n");
    const env = (k: string) => (k === "NIMBUS_UPDATER_DISABLE" ? "0" : undefined);
    const r = explainConfig(initLayeredConfig(dir), "updater.enabled", env);
    expect(r.entries).toHaveLength(0);
    expect(r.notes).toContain(
      'NIMBUS_UPDATER_DISABLE is set to "0" but does not override this value',
    );
  });

  test("quoted sub-table path", () => {
    writeBase('[hitl.quorum."slack.post_message"]\napprovers = 2\n');
    const reader = initLayeredConfig(dir);
    for (const p of [
      'hitl.quorum."slack.post_message".approvers',
      "hitl.quorum.slack.post_message.approvers",
    ]) {
      const r = explainConfig(reader, p, noEnv);
      expect(r.entries.map((e) => e.value)).toEqual(["2"]);
    }
  });

  test("root key matches a one-segment path", () => {
    writeBase('profile_note = "x"\n[a]\nb = 1\n');
    const r = explainConfig(initLayeredConfig(dir), "profile_note", noEnv);
    expect(r.entries.map((e) => e.value)).toEqual(['"x"']);
  });

  test("no path lists blocks", () => {
    writeBase('[a]\nb = 1\n[[filesystem.roots]]\npath = "/x"\n[[filesystem.roots]]\npath = "/y"\n');
    const r = explainConfig(initLayeredConfig(dir), undefined, noEnv);
    expect(r.blocks).toHaveLength(2);
    expect(r.entries.map((e) => e.path)).toContain("a.b");
    const only = explainConfig(initLayeredConfig(dir), "filesystem.roots", noEnv);
    expect(only.blocks).toHaveLength(2);
  });

  test("marker differs note", () => {
    writeProfile("work", "[a]\nb = 1\n");
    writeProfile("home", "[a]\nb = 2\n");
    writeFileSync(join(dir, ".nimbus-profile"), "work\n");
    const reader = initLayeredConfig(dir);
    writeFileSync(join(dir, ".nimbus-profile"), "home\n");
    const r = explainConfig(reader, "a.b", noEnv);
    expect(r.runningProfile).toBe("work");
    expect(r.markerProfile).toBe("home");
    expect(r.notes).toContain('profile switched to "home" on disk; restart the gateway to apply');
  });

  test("unknown path note", () => {
    writeBase("[a]\nb = 1\n");
    const r = explainConfig(initLayeredConfig(dir), "a.zzz", noEnv);
    expect(r.entries).toHaveLength(0);
    expect(r.notes).toContain("no layer sets a.zzz; the code default applies");
  });
});
