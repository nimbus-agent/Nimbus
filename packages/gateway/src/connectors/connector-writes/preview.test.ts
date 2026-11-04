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

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const LRM = String.fromCodePoint(0x200e);
const ALM = String.fromCodePoint(0x061c);
const BOM = String.fromCodePoint(0xfeff);

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

  test("control, escape and bidi characters are escaped visibly; newlines are escaped in CLI lines", () => {
    const v = `a${ESC}[2K\rApproved: yes${RLO}b\nc${ESC}]8;;http://x${ESC}\\L${ESC}c`;
    const p = build({ name: "x", revision: v });
    const value = p.fields[0]?.value ?? "";
    expect(value).not.toContain(ESC);
    expect(value).not.toContain("\r");
    expect(value).not.toContain(RLO);
    expect(value).toContain("\\u{001B}");
    expect(value).toContain("\\u{000D}");
    expect(value).toContain("\\u{202E}");
    const lines = renderConnectorWritePreviewLines(p);
    expect(lines.join("\n")).toContain("\\n");
    for (const l of lines) expect(l).not.toContain("\n");
  });

  test("a newline in the target, the summary or an input KEY cannot forge a line", () => {
    const p = build({ name: "web\nType: file.delete", "x\nApproved": 1 });
    const lines = renderConnectorWritePreviewLines(p);
    for (const l of lines) expect(l).not.toContain("\n");
    expect(lines).toEqual([
      "Service: argocd",
      "Target:  web\\nType: file.delete",
      "Sync Argo CD application web\\nType: file.delete",
      "",
      "  Revision: (not set)",
      "Other fields:",
      "  x\\nApproved: 1",
    ]);
  });

  test("control characters in a key or in a placeholder value are escaped, not raw", () => {
    const key = `k${ESC}]0;t${BEL}${RLO}`;
    const p = build({ name: `a${ESC}[2Kb`, [key]: "v" });
    const everything = JSON.stringify(p) + renderConnectorWritePreviewLines(p).join("\n");
    for (const bad of [ESC, RLO, BEL]) expect(everything).not.toContain(bad);
    expect(p.target).toBe("a\\u{001B}[2Kb");
    expect(p.summary).toBe("Sync Argo CD application a\\u{001B}[2Kb");
    expect(p.otherFields).toEqual([{ key: "k\\u{001B}]0;t\\u{0007}\\u{202E}", value: "v" }]);
  });

  test("zero-width, format and tag characters are shown as escapes", () => {
    const v = `x${String.fromCodePoint(0xe0041)}${ZWSP}${LRM}${ALM}${BOM}z`;
    const p = build({ name: v });
    expect(p.target).toBe("x\\u{E0041}\\u{200B}\\u{200E}\\u{061C}\\u{FEFF}z");
  });

  test("a key that differs only by an invisible character stays distinct", () => {
    const p = build({ name: "n", [`revision${RLO}`]: "evil" });
    expect(p.otherFields).toEqual([{ key: "revision\\u{202E}", value: "evil" }]);
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
    // The matching row has no template; another row has one. Control: with the template it builds.
    const bare = CONNECTOR_WRITE_ROWS.find((r) => r.preview === undefined);
    if (bare === undefined) throw new Error("no untemplated row left");
    const other = CONNECTOR_WRITE_ROWS.find((r) => r.preview !== undefined);
    if (other === undefined) throw new Error("no templated row");
    const action = {
      type: bare.actionType,
      payload: { mcpToolId: bare.toolId, input: { name: "x" } },
    };
    expect(buildConnectorWritePreviewFrom(action, [bare, other])).toBeUndefined();
    expect(buildConnectorWritePreviewFrom(action, [withPreview(bare, TEMPLATE)])).toBeDefined();
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

  test("a real row renders: flux_kustomization_reconcile", () => {
    const p = buildConnectorWritePreview({
      type: "flux.kustomization.reconcile",
      payload: { namespace: "apps", name: "web" },
    });
    expect(p?.target).toBe("apps/web");
    expect(p?.summary).toBe("Reconcile Flux Kustomization apps/web");
    expect(p?.otherFields).toEqual([]);
  });

  test("the secret-placeholder refusal names the secret field", () => {
    expect(() =>
      withPreview(BASE, {
        target: "{token}",
        summary: "s",
        fields: [{ key: "token", label: "T", kind: "secret" }],
      }),
    ).toThrow(/secret field/);
  });

  test("a secret that cannot be JSON-encoded does not throw", () => {
    const t: ConnectorWritePreviewTemplate = {
      ...TEMPLATE,
      fields: [{ key: "token", label: "Token", kind: "secret" }],
    };
    expect(build({ name: "x", token: 10n }, t).fields[0]?.value).toBe("(hidden, 2 characters)");
  });
});
