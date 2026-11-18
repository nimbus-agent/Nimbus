import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadRunbooks,
  parseRunbookText,
  RUNBOOK_MAX_FILES,
  RunbookRefusal,
} from "./runbook-loader.ts";

const GOOD = `
name = "pay-rollback"
description = "Roll back the payments app"

[match]
services = ["payments"]
sources = ["pagerduty"]
title = "latency|errors"

[[steps]]
kind = "check"
text = "Open the payments dashboard"

[[steps]]
kind = "read"
service = "argocd"
tool = "argocd_get"
params = { name = "{binding.argocd_app}" }

[[steps]]
kind = "action"
tool = "argocd_app_rollback"
params = { name = "{binding.argocd_app}", id = 6 }
`;

function refusalOf(text: string, file = "x.toml"): string {
  try {
    parseRunbookText(file, text);
  } catch (e) {
    if (e instanceof RunbookRefusal) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

const step = (body: string): string => `[[steps]]\n${body}\n`;

describe("parseRunbookText", () => {
  test("a good runbook parses into its steps with a content hash", () => {
    const rb = parseRunbookText("pay.toml", GOOD);
    expect(rb.name).toBe("pay-rollback");
    expect(rb.description).toBe("Roll back the payments app");
    expect(rb.match).toEqual({
      services: ["payments"],
      sources: ["pagerduty"],
      title: "latency|errors",
    });
    expect(rb.steps.map((s) => s.kind)).toEqual(["check", "read", "action"]);
    expect(rb.steps[2]).toEqual({
      kind: "action",
      tool: "argocd_app_rollback",
      params: { name: "{binding.argocd_app}", id: 6 },
    });
    expect(rb.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the name defaults to the file stem and match and params are optional", () => {
    const rb = parseRunbookText("db-check.toml", step(`kind = "check"\ntext = "Look"`));
    expect(rb.name).toBe("db-check");
    expect(rb.match).toEqual({ services: [], sources: [], title: null });
    const rb2 = parseRunbookText("r.toml", step(`kind = "action"\ntool = "slack_message_post"`));
    expect(rb2.steps[0]).toEqual({ kind: "action", tool: "slack_message_post", params: {} });
  });

  test("invalid TOML, a non-table root and an unknown key are refused", () => {
    expect(refusalOf("= =")).toBe("the file is not valid TOML");
    expect(refusalOf(`owner = "me"\n${step(`kind = "check"\ntext = "x"`)}`)).toBe(
      'runbook: unknown key "owner"',
    );
  });

  test("a runbook cannot set approval behaviour, at the top, in a step or in params", () => {
    expect(refusalOf(`auto_approve = true\n${step(`kind = "check"\ntext = "x"`)}`)).toContain(
      '"auto_approve" would set approval behaviour',
    );
    expect(refusalOf(step(`kind = "check"\ntext = "x"\nyes = true`))).toContain(
      '"yes" would set approval',
    );
    expect(
      refusalOf(step(`kind = "action"\ntool = "slack_message_post"\nparams = { confirm = "x" }`)),
    ).toContain('"confirm" would set approval');
  });

  test("names, descriptions and texts are checked", () => {
    expect(refusalOf(`name = "Bad Name"\n${step(`kind = "check"\ntext = "x"`)}`)).toContain(
      "name must be",
    );
    expect(refusalOf(`description = ""\n${step(`kind = "check"\ntext = "x"`)}`)).toContain(
      "description must be a non-empty string",
    );
    expect(refusalOf(step(`kind = "check"\ntext = "a\\tb"`))).toBe(
      "steps[1].text may not hold control characters",
    );
  });

  test("steps must be a list of 1 to 50 tables of a known kind", () => {
    expect(refusalOf(`name = "a"`)).toContain("steps must be a list of 1 to 50");
    expect(refusalOf(step(`kind = "check"\ntext = "x"`).repeat(51))).toContain(
      "steps must be a list of 1 to 50",
    );
    expect(refusalOf(`steps = [1]`)).toBe("steps[1] must be a table");
    expect(refusalOf(step(`kind = "shell"`))).toBe(
      'steps[1].kind must be "check", "read" or "action"',
    );
  });

  test("match is validated: lists, trigger sources and the title regex", () => {
    const m = (body: string): string => refusalOf(`${body}\n${step(`kind = "check"\ntext = "x"`)}`);
    expect(m(`match = 3`)).toBe("match must be a table");
    expect(m(`[match]\nowner = "x"`)).toBe('match: unknown key "owner"');
    expect(m(`[match]\nservices = "payments"`)).toContain("must be a list of at most 50 strings");
    expect(m(`[match]\nservices = ["Bad Id"]`)).toContain('"Bad Id" is not allowed');
    expect(m(`[match]\nsources = ["slack"]`)).toBe(
      'match.sources: "slack" is not a trigger source',
    );
    expect(m(`[match]\ntitle = "("`)).toBe("match.title is not a valid regular expression");
  });

  test("an action must name a connector write row that is neither bound nor refused", () => {
    expect(refusalOf(step(`kind = "action"\ntool = "nope_tool"`))).toContain(
      "is not a connector write row",
    );
    expect(refusalOf(step(`kind = "action"\ntool = "github_file_commit"`))).toContain(
      "is a bound write",
    );
    expect(refusalOf(step(`kind = "action"\ntool = "iac_pulumi_up"`))).toContain(
      "is refused on every door",
    );
  });

  test("a read must be a read tool of a connector Nimbus runs", () => {
    const r = (svc: string, tool: string): string =>
      refusalOf(step(`kind = "read"\nservice = "${svc}"\ntool = "${tool}"`));
    expect(r("argocd", "argocd_app_rollback")).toBe(
      "steps[1]: argocd_app_rollback is not a read tool",
    );
    expect(r("argocd", "argocd_frobnicate")).toBe("steps[1]: argocd_frobnicate is not a read tool");
    expect(r("nosuchsvc", "nosuchsvc_get")).toBe(
      "steps[1]: nosuchsvc is not a connector Nimbus runs",
    );
    expect(r("Bad", "x_get")).toBe("steps[1].service is not a connector id");
    expect(r("argocd", "Bad-Tool")).toBe("steps[1].tool is not a tool id");
  });

  test("params are plain data, bounded, and interpolate only typed fields (I57 (c))", () => {
    const a = (params: string): string =>
      refusalOf(step(`kind = "action"\ntool = "slack_message_post"\nparams = ${params}`));
    expect(a(`3`)).toBe("steps[1].params must be a table");
    // Bun's TOML reader mis-reads an unquoted date, so it is refused before parsing; a quoted one is a string.
    expect(a(`{ at = 1979-05-27T07:32:00Z }`)).toBe(
      "an unquoted date or time is not supported; write it as a quoted string",
    );
    expect(a(`{ at = 07:32:00 }`)).toContain("unquoted date or time");
    expect(
      refusalOf(`description = """
x
"""
${step(`kind = "check"
text = "x"`)}`),
    ).toBe("multi-line strings are not supported");
    expect(a(`{ a = { b = { c = { d = { e = 1 } } } } }`)).toContain("nested more than 4 deep");
    expect(a(`{ text = "${"x".repeat(5000)}" }`)).toContain("is longer than 4096 characters");
    expect(a(`{ text = "{trigger.title}" }`)).toContain(
      "{trigger.title} is not a typed record field",
    );
    const ok = parseRunbookText(
      "r.toml",
      step(
        `kind = "action"\ntool = "slack_message_post"\nparams = { channel = "C1", list = ["{service}", 2, true] }`,
      ),
    );
    expect(ok.steps[0]).toMatchObject({ params: { channel: "C1", list: ["{service}", 2, true] } });
  });
});

describe("loadRunbooks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-runbooks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an absent directory is no runbooks and no errors", () => {
    expect(loadRunbooks(dir)).toEqual({ runbooks: [], errors: [] });
  });

  test("good files load in name order; a bad, a duplicate and a non-file entry are reported by name", () => {
    const rb = join(dir, "runbooks");
    mkdirSync(rb);
    writeFileSync(join(rb, "b.toml"), GOOD);
    writeFileSync(join(rb, "a.toml"), step(`kind = "check"\ntext = "x"`));
    writeFileSync(join(rb, "c.toml"), GOOD);
    writeFileSync(join(rb, "d.toml"), "= =");
    writeFileSync(join(rb, "notes.txt"), "ignored");
    mkdirSync(join(rb, "e.toml"));
    const out = loadRunbooks(dir);
    expect(out.runbooks.map((r) => r.name)).toEqual(["a", "pay-rollback"]);
    expect(out.errors).toEqual([
      { file: "c.toml", reason: "another runbook is already named pay-rollback" },
      { file: "d.toml", reason: "the file is not valid TOML" },
      { file: "e.toml", reason: "not a regular file (a link or a directory is not read)" },
    ]);
  });

  test("a file over the size cap is refused and the file count is capped", () => {
    const rb = join(dir, "runbooks");
    mkdirSync(rb);
    writeFileSync(
      join(rb, "big.toml"),
      `# ${"x".repeat(70_000)}\n${step(`kind = "check"\ntext = "x"`)}`,
    );
    const out = loadRunbooks(dir);
    expect(out.errors).toEqual([{ file: "big.toml", reason: "larger than 65536 bytes" }]);
    rmSync(join(rb, "big.toml"));
    for (let i = 0; i <= RUNBOOK_MAX_FILES; i++) {
      writeFileSync(
        join(rb, `r${String(i).padStart(3, "0")}.toml`),
        step(`kind = "check"\ntext = "x"`),
      );
    }
    const many = loadRunbooks(dir);
    expect(many.runbooks).toHaveLength(RUNBOOK_MAX_FILES);
    expect(many.errors[0]?.reason).toContain("more than 100 runbooks");
  });

  test.skipIf(process.platform === "win32")("a link is not followed", () => {
    const rb = join(dir, "runbooks");
    mkdirSync(rb);
    writeFileSync(join(dir, "elsewhere.toml"), GOOD);
    symlinkSync(join(dir, "elsewhere.toml"), join(rb, "link.toml"));
    expect(loadRunbooks(dir).errors).toEqual([
      { file: "link.toml", reason: "not a regular file (a link or a directory is not read)" },
    ]);
  });
});
