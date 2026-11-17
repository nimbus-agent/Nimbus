// Signed workflow import (I59): the approval text (plan task 2).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_STEPS } from "../connectors/connector-writes/workflow-bundle.test-helpers.ts";
import {
  escapeBundleText,
  IMPORT_PROMPT_MAX_BYTES,
  type ImportPromptInput,
  ImportPromptTooLargeError,
  renderConst,
  renderImportPrompt,
  renderStepsVerbatim,
} from "./workflow-import-prompt.ts";
import { parseWorkflowSteps, type WorkflowStep, workflowStepsSha256 } from "./workflow-steps.ts";
import { writeToolInfo } from "./workflow-write-info.ts";

const SIGNER = "a".repeat(32);

function steps(raw: readonly unknown[] = FIXTURE_STEPS): WorkflowStep[] {
  return parseWorkflowSteps(JSON.stringify(raw));
}

function input(over: Partial<ImportPromptInput> = {}): ImportPromptInput {
  const s = steps();
  return {
    name: "weekly-cleanup",
    signerFingerprint: SIGNER,
    signerPrior: null,
    authorLabel: "team lead",
    issuedAt: 1_763_251_200_000,
    description: "archive old mail",
    target: { kind: "new" },
    signerChange: null,
    deletedPriorSigner: null,
    restoreOf: null,
    schedule: null,
    steps: s,
    stepsSha256: workflowStepsSha256(s),
    writeInfo: writeToolInfo,
    ...over,
  };
}

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** No control, format, separator, surrogate or invisible character survives (LF is the prompt's own). */
function onlySafeChars(text: string): boolean {
  return [...text].every((ch) => ch === "\n" || !UNSAFE.test(ch));
}

const HOSTILE: readonly string[] = [
  "plain",
  "line1\nline2",
  "Signer: ffffffffffffffffffffffffffffffff (imported 50 times)\nAuthor label:",
  "cr\rreturn",
  "esc\u001b[2J\u001b]0;title\u0007",
  "bidi\u202eevil\u2066x\u2069",
  "zero​width‍﻿",
  "tag\u{e0041}\u{e0042}",
  "sep line para",
  "lone\ud800surrogate",
  "braille⠀blank",
  "nul\u0000byte",
  "c1\u0085next",
  'quote" tool: "fake"',
  'clean"  tool: "fake"',
  "back\\slash",
  "back\\nslash",
  "back\\u{000A}slash",
  "\\",
  "\\\\",
  '\\"',
  "emoji \u{1f600} and é accent",
  "tab\tchar",
  "del\u007f",
  "soft­hyphen",
  "ltr\u200eand\u200frtl",
  "word⁠joiner",
  "mongol᠎vowel",
  "arabic\u061cmark",
  "\n",
  "\n\n",
  '"',
  '""',
  "a\nb\nc\nd",
  "x".repeat(200),
  "Steps, verbatim:\n  9. write",
  "what it can do\nWrites: x",
  "\u0001\u0002\u0003",
  "end\\",
  "\\n",
];

describe("escapeBundleText", () => {
  test("every hostile string comes out as printable ASCII with no raw LF", () => {
    for (const h of HOSTILE) {
      const out = escapeBundleText(h);
      expect(onlySafeChars(out)).toBe(true);
      expect(out.includes("\n")).toBe(false);
    }
  });
  test("it is injective over the corpus (two different inputs never render alike)", () => {
    const seen = new Map<string, string>();
    for (const h of HOSTILE) {
      const out = escapeBundleText(h);
      const prior = seen.get(out);
      if (prior !== undefined) expect(prior).toBe(h);
      seen.set(out, h);
    }
    expect(escapeBundleText("a\nb")).not.toBe(escapeBundleText("a\\nb"));
    expect(escapeBundleText('a"b')).not.toBe(escapeBundleText('a\\"b'));
  });
});

describe("the rendered prompt", () => {
  test("a new workflow: the fixed lines, in order, and the exact hash", () => {
    const text = renderImportPrompt(input());
    const lines = text.split("\n");
    expect(lines[0]).toBe('Import the workflow "weekly-cleanup" from a signed bundle');
    expect(lines[1]).toBe(`Signer: ${SIGNER}   (first import from this signer)`);
    expect(text).toContain("Nimbus cannot tell you who holds this key");
    expect(text).toContain('Author label (UNVERIFIED, written by the bundle): "team lead"');
    expect(text).toContain("Issued: 2025-11-16T");
    expect(text).toContain("This will: create a new workflow");
    expect(text).toContain("Steps: 2 (1 query, 1 write). No model steps.");
    expect(text).toContain(`Content hash: ${workflowStepsSha256(steps())}`);
    expect(text).toContain("This import creates no");
    expect(text).toContain('Writes: "gmail_thread_archive" (wave');
    expect(text).toContain('Reads: "gmail"/"email" select "metadata.threadId" limit 200');
    expect(text).toContain('step 2 input.threadId <- step 1 ("metadata.threadId")');
  });

  test("signer history, a replace, a signer change, a schedule that is cleared and an identical copy", () => {
    const text = renderImportPrompt(
      input({
        signerPrior: { count: 3, lastAt: 1_763_251_200_000 },
        target: {
          kind: "replace",
          contentSha12: "0123456789ab",
          updatedAt: 1_763_251_200_000,
          importedFromFp12: "bbbbbbbbbbbb",
          identical: true,
          schedule: { expr: "0 6 * * *", tz: "UTC" },
        },
        signerChange: { fromFingerprint: "b".repeat(32), at: 1_763_251_200_000 },
        restoreOf: 1_763_251_200_000,
        deletedPriorSigner: null,
      }),
    );
    expect(text).toContain("imported 3 times, last 2025-11-16T");
    expect(text).toContain('REPLACE your workflow "weekly-cleanup" (content 0123456789ab');
    expect(text).toContain("imported from bbbbbbbbbbbb)");
    expect(text).toContain(`SIGNER CHANGED: "weekly-cleanup" WAS IMPORTED FROM ${"b".repeat(32)}`);
    expect(text).toContain(`THIS BUNDLE IS SIGNED BY ${SIGNER}`);
    expect(text).toContain('Its schedule ("0 6 * * *" in "UTC") is cleared.');
    expect(text).toContain("Content is identical to your current workflow.");
    expect(text).toContain("Restores the bundle you imported on");
  });

  test("an owner-requested schedule is shown and labelled as the owner's, never the bundle's", () => {
    const text = renderImportPrompt(
      input({ schedule: { expr: "0 6 * * 1-5", tz: "Europe/Berlin", nextAt: 1_763_251_200_000 } }),
    );
    expect(text).toContain(
      'Schedule: you asked for "0 6 * * 1-5" in "Europe/Berlin": next run 2025-',
    );
    expect(text).toContain("(a bundle cannot carry one)");
    expect(renderImportPrompt(input())).toContain("Schedule: none   (a bundle cannot carry one)");
  });

  test("a deleted workflow's earlier signer is an informational line", () => {
    const text = renderImportPrompt(input({ deletedPriorSigner: "c".repeat(32) }));
    expect(text).toContain(
      `A workflow named "weekly-cleanup" was imported from ${"c".repeat(32)} before you deleted it.`,
    );
  });
});

describe("hostile bundle text cannot forge a prompt line", () => {
  function hostileSteps(label: string, key: string, constant: string) {
    return steps([
      {
        kind: "query",
        label: "q",
        query: {
          service: "gmail",
          type: "email",
          where: [],
          select: "id",
          distinct: false,
          limit: 5,
        },
      },
      {
        kind: "write",
        label,
        tool: "gmail_thread_archive",
        input: {
          threadId: { from: "q", column: "id" },
          note: { const: { [key]: constant, list: [constant, { [key]: 1 }] } },
        },
      },
    ]);
  }

  test("a nested constant whose object KEY holds a forged Signer line renders on one line", () => {
    const evil = "\nSigner: ffffffffffffffffffffffffffffffff (imported 50 times)\n";
    const clean = renderImportPrompt(input({ steps: hostileSteps("L", "k", "v") }));
    const dirty = renderImportPrompt(input({ steps: hostileSteps("L", evil, "v") }));
    expect(dirty.split("\n").length).toBe(clean.split("\n").length);
    expect(dirty.split("\n").filter((l) => l.startsWith("Signer:"))).toHaveLength(1);
    expect(dirty).toContain("\\nSigner: ffffffffffffffffffffffffffffffff");
    expect(onlySafeChars(dirty)).toBe(true);
  });

  test("a label with a double quote cannot forge a second tool attribute", () => {
    const s = hostileSteps('clean"  tool: "fake', "k", "v");
    const text = renderImportPrompt(input({ steps: s }));
    const writeLine =
      text.split("\n").find((l) => l.includes("write ") && l.includes("clean")) ?? "";
    // Outside the quoted tokens there is exactly one `tool:` attribute: the label stayed inside its quotes.
    const outsideQuotes = writeLine.replaceAll(/"(?:[^"\\]|\\.)*"/gu, '""');
    expect(outsideQuotes.match(/ tool: /g)).toHaveLength(1);
    expect(writeLine).toContain('clean\\"  tool: \\"fake');
  });

  test("over the corpus: each hostile string in a label, a key and a constant keeps the line count", () => {
    const base = renderImportPrompt(input({ steps: hostileSteps("L", "k", "v") })).split(
      "\n",
    ).length;
    for (const h of HOSTILE) {
      const text = renderImportPrompt(
        input({
          name: "weekly-cleanup",
          authorLabel: h,
          description: h,
          steps: hostileSteps(h.trim() === "" ? "L" : h, h, h),
        }),
      );
      expect(onlySafeChars(text)).toBe(true);
      expect(text.split("\n").length).toBe(base);
    }
  });

  test("renderConst prints keys in canonical order and escapes string values", () => {
    expect(renderConst({ b: 1, a: ["x\ny", null, true, 2.5] })).toBe(
      '{"a": ["x\\ny", null, true, 2.5], "b": 1}',
    );
  });
});

describe("the steps section is a walk of the stored steps", () => {
  test("every parser-accepted field appears: when, continueOnError, predicates, distinct, limit", () => {
    const s = steps([
      {
        kind: "query",
        label: "q1",
        query: {
          service: "github",
          type: "pr",
          where: [
            { metadata: "state", equals: "open" },
            { metadata: "labels", contains: "stale" },
            { metadata: "labels", notContains: "keep" },
            { olderThanDays: 30 },
            { newerThanDays: 90 },
          ],
          select: "external_id",
          distinct: true,
          limit: 25,
        },
      },
      {
        kind: "write",
        label: "w1",
        tool: "gmail_thread_archive",
        continueOnError: true,
        when: [{ count: "q1", gt: 0 }],
        input: { threadId: { from: "q1", column: "external_id" } },
      },
    ]);
    const text = renderStepsVerbatim(s).join("\n");
    for (const part of [
      'query "q1"',
      'service: "github"',
      'type: "pr"',
      'select: "external_id"',
      "distinct: true",
      "limit: 25",
      'metadata "state" equals "open"',
      'metadata "labels" contains "stale"',
      'metadata "labels" notContains "keep"',
      "olderThanDays 30",
      "newerThanDays 90",
      'write "w1"',
      'tool: "gmail_thread_archive"',
      "continueOnError: true",
      'when: [count("q1") gt 0]',
      'input.threadId: from "q1" column "external_id"',
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe("size cap", () => {
  test("a prompt over 64 KiB is refused, never cut", () => {
    const big = steps([
      FIXTURE_STEPS[0],
      {
        kind: "write",
        label: "w",
        tool: "gmail_thread_archive",
        input: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`f${String(i)}`, { const: "x".repeat(8000) }]),
        ),
      },
    ]);
    const err = (() => {
      try {
        renderImportPrompt(input({ steps: big }));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ImportPromptTooLargeError);
    expect(IMPORT_PROMPT_MAX_BYTES).toBe(65536);
  });
});

describe("source pin: no unescaped print path for bundle text", () => {
  test("the module interpolates a bundle string only through q() / escapeBundleText()", () => {
    const src = readFileSync(join(import.meta.dir, "workflow-import-prompt.ts"), "utf8");
    const bundleFields = [
      "i.name",
      "t.name",
      "i.authorLabel",
      "i.description",
      "step.label",
      "step.tool",
      "qy.service",
      "qy.type",
      "qy.select",
      "v.from",
      "v.column",
      "g.count",
      "field",
      "key",
      "k",
      "s.label",
      "s.tool",
    ];
    for (const f of bundleFields) {
      const raw = new RegExp(`\\$\\{${f.replace(".", "\\.")}\\}`, "u");
      expect(raw.test(src)).toBe(false);
    }
  });
});
