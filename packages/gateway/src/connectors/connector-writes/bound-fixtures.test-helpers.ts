// packages/gateway/src/connectors/connector-writes/bound-fixtures.test-helpers.ts
// Test support for the bound-write mechanism (Phase 9.7 D0b): SYNTHETIC rows only. No production
// row declares `bound`, and `PREPARE_TOOL_IDS` is empty, so every test of the mechanism supplies its
// own prepare-tool set through the seams static rule D42(c) forbids production code to use.
import {
  type BoundWrite,
  type ConnectorWriteRow,
  row as makeRow,
  textField,
  withBound,
  withConfirm,
  withPreview,
} from "./types.ts";

/** The synthetic prepare tool; its mesh key under the `iac` service is `iac_synth_plan`. */
export const SYNTH_PREPARE_TOOL = "synth_plan";
export const SYNTH_PREPARE_IDS: ReadonlySet<string> = new Set([SYNTH_PREPARE_TOOL]);

/** The synthetic prepare reply every fixture reads. */
export const SYNTH_REPLY = { summary: "3 to add, 0 to change", digest: "sha256:abc123" } as const;

export function synthBound(overrides: Partial<BoundWrite["prepare"]> = {}): BoundWrite {
  return {
    prepare: {
      tool: SYNTH_PREPARE_TOOL,
      argKeys: ["dir"],
      args: (input) => ({ dir: input["dir"] }),
      select: (reply) => [
        { label: "Plan", value: String((reply as { summary: unknown }).summary) },
      ],
      budgetMs: 1000,
      maxInputBytes: 1000,
      maxReplyBytes: 1000,
      ...overrides,
    },
    binds: [
      {
        field: "planDigest",
        from: (reply) => (reply as { digest?: string }).digest,
      },
    ],
  };
}

/**
 * A bound row on the REAL HITL type `iac.terraform.apply` (so the frozen set gates it), with the
 * synthetic tool id `synth_apply`. Wave 4 also declares a confirm target.
 */
export function synthBoundRow(
  wave: 3 | 4 = 3,
  bound: BoundWrite = synthBound(),
): ConnectorWriteRow {
  const base = withPreview(makeRow("synth_apply", "iac.terraform.apply", "write", wave), {
    target: "{dir}",
    summary: "Apply {dir}",
    fields: [textField("dir")],
  });
  const confirmed = wave === 4 ? withConfirm(base, { template: "{dir}" }) : base;
  return withBound(confirmed, bound, SYNTH_PREPARE_IDS);
}
