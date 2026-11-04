import { describe, expect, test } from "bun:test";

import type { PlannedAction } from "../../engine/types.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  buildConnectorWritePreview,
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { type ConnectorWritePreviewTemplate, withPreview } from "./types.ts";

const FOUND = CONNECTOR_WRITE_ROWS.find((r) => r.actionType === "argocd.app.sync");
if (FOUND === undefined) throw new Error("argocd.app.sync row missing");
const BASE = FOUND;

function rowsWith(t: ConnectorWritePreviewTemplate) {
  return [withPreview(BASE, t)];
}

const TEMPLATE: ConnectorWritePreviewTemplate = {
  target: "{name}",
  summary: "Sync Argo CD application {name}",
  fields: [{ key: "revision", label: "Revision", kind: "text" }],
};

function act(input: Record<string, unknown>, extra: Record<string, unknown> = {}): PlannedAction {
  return { type: "argocd.app.sync", payload: { input, ...extra } };
}

function build(
  input: Record<string, unknown>,
  t: ConnectorWritePreviewTemplate = TEMPLATE,
  extra: Record<string, unknown> = {},
): ConnectorWritePreview {
  const p = buildConnectorWritePreviewFrom(act(input, extra), rowsWith(t));
  if (p === undefined) throw new Error("no preview");
  return p;
}

describe("buildConnectorWritePreview", () => {
  test("fills target, summary and fields from the input", () => {
    const p = build({ name: "web", revision: "abc" });
    expect(p.kind).toBe("connector-write");
    expect(p.service).toBe("argocd");
    expect(p.actionType).toBe("argocd.app.sync");
    expect(p.destination).toEqual({ service: "argocd" });
    expect(p.target).toBe("web");
    expect(p.summary).toBe("Sync Argo CD application web");
    expect(p.fields).toEqual([{ label: "Revision", kind: "text", value: "abc" }]);
  });

  test("a missing key shows (not set)", () => {
    const p = build({ name: "web" });
    expect(p.fields[0]?.value).toBe("(not set)");
    expect(build({}).target).toBe("(not set)");
  });

  test("every input key the template does not name is listed under Other fields", () => {
    expect(build({ name: "web", revision: "abc", force: true }).otherFields).toEqual([
      { key: "force", value: "true" },
    ]);
  });

  test("mcpToolId is a routing key, never shown", () => {
    const p = buildConnectorWritePreviewFrom(
      { type: "argocd.app.sync", payload: { mcpToolId: "argocd_app_sync", name: "web", z: 1 } },
      rowsWith(TEMPLATE),
    );
    expect(p?.otherFields.map((f) => f.key)).toEqual(["z"]);
    const q = build({ name: "x" }, TEMPLATE, { mcpToolId: "argocd_app_sync" });
    expect(q.otherFields.some((f) => f.key === "mcpToolId")).toBe(false);
  });

  test("a key that looks sensitive is shown in full", () => {
    const p = build({ name: "x", issueKey: "SECRET-1", author: "eve" });
    const text = JSON.stringify(p);
    expect(text).toContain("SECRET-1");
    expect(text).toContain("eve");
    expect(text).not.toContain("[REDACTED]");
  });

  test("a secret field is masked", () => {
    const t: ConnectorWritePreviewTemplate = {
      ...TEMPLATE,
      fields: [{ key: "token", label: "Token", kind: "secret" }],
    };
    const p = build({ name: "x", token: "abcdefghijkl" }, t);
    expect(p.fields[0]?.value).toBe("(hidden, 12 characters)");
    expect(JSON.stringify(p)).not.toContain("abcdefghijkl");
  });

  test("control, escape and bidi characters are stripped; newlines are escaped in CLI lines", () => {
    const v = "a\u001b[2K\rApproved: yes‮b\nc\u001b]8;;http://x\u001b\\L\u001bc";
    const p = build({ name: "x", revision: v });
    const value = p.fields[0]?.value ?? "";
    expect(value).not.toContain("\u001b");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("‮");
    const lines = renderConnectorWritePreviewLines(p);
    expect(lines.join("\n")).toContain("\\n");
    expect(lines.some((l) => l.startsWith("Approved"))).toBe(false);
    for (const l of lines) expect(l).not.toContain("\n");
  });

  test("a newline in the target, the summary or an input KEY cannot forge a line", () => {
    const p = build({ name: "web\nType: file.delete", "x\nApproved": 1 });
    const lines = renderConnectorWritePreviewLines(p);
    // Service, Target, summary, blank, Revision field, "Other fields:", one other entry.
    expect(lines).toHaveLength(7);
    expect(lines.some((l) => l.startsWith("Type:") || l.startsWith("Approved"))).toBe(false);
  });

  test("a long value is never truncated", () => {
    const long = "x".repeat(2500);
    const p = build({ name: "n", revision: long });
    expect(p.fields[0]?.value).toBe(long);
    expect(renderConnectorWritePreviewLines(p).join("\n")).toContain(long);
  });

  test("template keys do not repeat under Other fields", () => {
    const t: ConnectorWritePreviewTemplate = {
      target: "{namespace}/{name}",
      summary: "s",
      fields: [],
    };
    expect(build({ namespace: "a", name: "b" }, t).otherFields).toEqual([]);
  });

  test("an unset field shows its whenUnset text", () => {
    const t: ConnectorWritePreviewTemplate = {
      ...TEMPLATE,
      fields: [{ key: "revision", label: "Revision", kind: "text", whenUnset: "(not set: HEAD)" }],
    };
    expect(build({ name: "x" }, t).fields[0]?.value).toBe("(not set: HEAD)");
  });

  test("a prototype key reads as absent", () => {
    const t: ConnectorWritePreviewTemplate = { target: "{toString}", summary: "s", fields: [] };
    expect(build({}, t).target).toBe("(not set)");
  });

  test("an unknown placeholder shape is left literal", () => {
    const t: ConnectorWritePreviewTemplate = {
      target: "{a.b} {name}",
      summary: "plain",
      fields: [],
    };
    expect(build({ name: "n" }, t).target).toBe("{a.b} n");
  });

  test("a non-string value is compact JSON", () => {
    expect(build({ name: "x", a: [1, 2] }).otherFields).toEqual([{ key: "a", value: "[1,2]" }]);
    expect(build({ name: { a: [1, 2] } }).target).toBe('{"a":[1,2]}');
  });

  test("mcpToolId naming a different write gives no preview", () => {
    const a: PlannedAction = {
      type: "argocd.app.sync",
      payload: { mcpToolId: "argocd_app_rollback", input: {} },
    };
    expect(buildConnectorWritePreviewFrom(a, rowsWith(TEMPLATE))).toBeUndefined();
  });

  test("a namespaced mcpToolId resolves", () => {
    const a: PlannedAction = {
      type: "argocd.app.sync",
      payload: { mcpToolId: "argocd_argocd_app_sync", input: { name: "w" } },
    };
    expect(buildConnectorWritePreviewFrom(a, rowsWith(TEMPLATE))?.toolId).toBe("argocd_app_sync");
  });

  test("no template gives no preview", () => {
    expect(buildConnectorWritePreviewFrom(act({ name: "x" }), [BASE])).toBeUndefined();
    expect(buildConnectorWritePreview(act({ name: "x" }))).toBeUndefined();
  });

  test("a non-object input is shown whole", () => {
    const p = buildConnectorWritePreviewFrom(
      { type: "argocd.app.sync", payload: { input: "just text\n" } },
      rowsWith(TEMPLATE),
    );
    expect(p?.fields).toEqual([]);
    expect(p?.otherFields).toEqual([{ key: "(input)", value: "just text\n" }]);
  });

  test("CLI lines have the documented shape", () => {
    const lines = renderConnectorWritePreviewLines(build({ name: "web", revision: "abc", f: 1 }));
    expect(lines).toEqual([
      "Service: argocd",
      "Target:  web",
      "Sync Argo CD application web",
      "",
      "  Revision: abc",
      "Other fields:",
      "  f: 1",
    ]);
  });
});
