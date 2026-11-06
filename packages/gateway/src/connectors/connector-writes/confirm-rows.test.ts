// packages/gateway/src/connectors/connector-writes/confirm-rows.test.ts
// Phase 9.7 D0a: every wave 4 row declares a type-to-confirm target, and each target names only
// REQUIRED top-level keys of the tool's input schema in the installed connector source.
import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { serviceOf } from "../../engine/service-of.ts";
import {
  constStatement,
  declaredInputKeys,
  requiredInputKeys,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { renderConfirmText } from "./confirm.ts";
import { parseConfirmTemplate } from "./confirm-template.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import type { ConnectorWriteRow } from "./types.ts";

const WAVE4 = CONNECTOR_WRITE_ROWS.filter((r) => r.wave === 4);
const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

/**
 * The two GitLab pipeline writes register through a forwarding function, so the scan finds no
 * schema in their call: their input is `gitlabPipelineGetSchema`, which extends `projectPathArg`.
 */
function gitlabPipelineDeclaration(): string {
  const code = codeByFile.get("connectors/gitlab/src/tools.ts") ?? "";
  const parts = ["gitlabPipelineGetSchema", "projectPathArg"].map((n) => constStatement(code, n));
  return parts.join("\n");
}

function declaration(toolId: string): string {
  if (toolId.startsWith("gitlab_pipeline_")) return gitlabPipelineDeclaration();
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined) throw new Error(`${toolId}: not a registered write`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return withSchemaArgumentDeclarations(sources, code, call);
}

function placeholders(r: ConnectorWriteRow): string[] {
  const parsed = parseConfirmTemplate(r.confirm?.template ?? "");
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.segments.flatMap((s) => (s.kind === "field" ? [s.name] : []));
}

describe("every wave 4 row declares a type-to-confirm target", () => {
  test("there are 39 wave 4 rows, each with a confirm template that parses", () => {
    expect(WAVE4).toHaveLength(39);
    for (const r of WAVE4) {
      expect(r.confirm, r.toolId).toBeDefined();
      expect(parseConfirmTemplate(r.confirm?.template ?? "").ok, r.toolId).toBe(true);
    }
  });

  test("no wave 2 or 3 row carries one (the control is wave 4's)", () => {
    for (const r of CONNECTOR_WRITE_ROWS.filter((x) => x.wave < 4)) {
      expect(r.confirm, r.toolId).toBeUndefined();
    }
  });

  test("the three opaque-id deletes confirm on the id's last 8 characters (OR-W34-8)", () => {
    const tail = WAVE4.filter((r) => r.confirm?.template.includes(":tail8"));
    expect(tail.map((r) => r.toolId).sort((a, b) => a.localeCompare(b))).toEqual([
      "apple_calendar_event_delete",
      "onedrive_item_delete",
      "outlook_calendar_delete",
    ]);
  });
});

describe("each placeholder is a required top-level key of the installed tool", () => {
  for (const r of WAVE4) {
    test(r.toolId, () => {
      const decl = declaration(r.toolId);
      expect(declaredInputKeys(decl).length, "schema shape recognised").toBeGreaterThan(0);
      const required = new Set(requiredInputKeys(decl));
      for (const name of placeholders(r)) {
        expect(required.has(name), `${r.toolId}: ${name} must be required`).toBe(true);
      }
    });
  }

  test("requiredInputKeys sees an optional key as not required", () => {
    // github_pr_merge: mergeMethod and commitTitle are optional upstream, and not in its template.
    const decl = declaration("github_pr_merge");
    expect(requiredInputKeys(decl)).toEqual(["owner", "pullNumber", "repo"]);
    expect(declaredInputKeys(decl)).toContain("mergeMethod");
  });
});

describe("rendering from a plausible input", () => {
  const VALUE = "abc-123";
  function sampleInput(r: ConnectorWriteRow): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const name of placeholders(r))
      out[name] = name === "instanceIds" ? ["i-0a1", "i-0b2"] : VALUE;
    return out;
  }

  for (const r of WAVE4) {
    test(r.toolId, () => {
      const out = renderConfirmText(r, sampleInput(r));
      if (!out.ok) throw new Error(out.reason);
      expect(out.text.startsWith(`${serviceOf(r.actionType)}/`)).toBe(true);
      expect(out.text.length).toBeLessThanOrEqual(200);
    });
  }

  test("documented examples", () => {
    const by = (id: string): ConnectorWriteRow => {
      const hit = WAVE4.find((r) => r.toolId === id);
      if (hit === undefined) throw new Error(id);
      return hit;
    };
    const text = (id: string, input: Record<string, unknown>): string => {
      const out = renderConfirmText(by(id), input);
      if (!out.ok) throw new Error(out.reason);
      return out.text;
    };
    expect(text("github_pr_merge", { owner: "acme", repo: "api", pullNumber: 42 })).toBe(
      "github/merge acme/api#42",
    );
    expect(text("gitlab_mr_merge", { projectPath: "grp/app", mergeRequestIid: 7 })).toBe(
      "gitlab/merge grp/app!7",
    );
    expect(text("gha_run_trigger", { owner: "acme", repo: "api", workflowId: "ci.yml" })).toBe(
      "github_actions/trigger acme/api:ci.yml",
    );
    expect(text("aws_ec2_instance_stop", { instanceIds: ["i-0a1", "i-0b2"] })).toBe(
      "aws/stop i-0a1 i-0b2",
    );
    expect(
      text("k8s_rollout_restart", { resourceType: "deployment", name: "api", namespace: "x" }),
    ).toBe("kubernetes/restart deployment/api");
    expect(text("mlflow_model_promote", { name: "fraud", version: "4" })).toBe(
      "mlflow/promote fraud/v4",
    );
    expect(text("argocd_app_rollback", { name: "web", id: 12 })).toBe("argocd/rollback web@12");
    expect(text("outlook_calendar_delete", { eventId: "AAMkAGI2THVSAAA1B2c3D4" })).toBe(
      "outlook/delete A1B2c3D4",
    );
  });
});

describe("no two Wave 4 rows of one service render the same confirm text", () => {
  /** One value for every key a template names, so two rows differ only through their own template. */
  function sharedInput(...rows: ConnectorWriteRow[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of rows) for (const name of placeholders(r)) out[name] = "v1";
    return out;
  }

  test("every pair of rows in a service differs for shared values, a numeric value and an array value", () => {
    const byService = new Map<string, ConnectorWriteRow[]>();
    for (const r of WAVE4) {
      const s = serviceOf(r.actionType);
      byService.set(s, [...(byService.get(s) ?? []), r]);
    }
    let pairs = 0;
    for (const [service, rows] of byService) {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i];
          const b = rows[j];
          if (a === undefined || b === undefined) continue;
          pairs++;
          for (const value of ["v1", 7, ["v1", "v2"]]) {
            const input = Object.fromEntries(Object.keys(sharedInput(a, b)).map((k) => [k, value]));
            const ta = renderConfirmText(a, input);
            const tb = renderConfirmText(b, input);
            // A failed render is a failure, not a skip: every row must render these inputs.
            expect(ta.ok, `${service}: ${a.toolId} renders ${JSON.stringify(value)}`).toBe(true);
            expect(tb.ok, `${service}: ${b.toolId} renders ${JSON.stringify(value)}`).toBe(true);
            if (ta.ok && tb.ok) {
              expect(ta.text, `${service}: ${a.toolId} vs ${b.toolId}`).not.toBe(tb.text);
            }
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(20);
  });

  test("every multi-placeholder row refuses a value holding its own separator", () => {
    let checked = 0;
    for (const r of WAVE4) {
      const parsed = parseConfirmTemplate(r.confirm?.template ?? "");
      if (!parsed.ok) throw new Error(parsed.reason);
      const segs = parsed.segments;
      const names = placeholders(r);
      segs.forEach((seg, i) => {
        if (seg.kind !== "text" || segs[i - 1]?.kind !== "field" || segs[i + 1]?.kind !== "field")
          return;
        const prev = segs[i - 1];
        if (prev?.kind !== "field") return;
        const input = Object.fromEntries(names.map((n) => [n, "v1"]));
        input[prev.name] = `a${seg.text}b`;
        const out = renderConfirmText(r, input);
        expect(out.ok, `${r.toolId}: ${prev.name} holding ${JSON.stringify(seg.text)}`).toBe(false);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("a template names its effect: it starts with a literal verb", () => {
    for (const r of WAVE4) {
      const first = parseConfirmTemplate(r.confirm?.template ?? "");
      const seg = first.ok ? first.segments[0] : undefined;
      expect(seg?.kind, r.toolId).toBe("text");
    }
  });
});
