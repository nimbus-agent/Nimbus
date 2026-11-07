// packages/gateway/src/connectors/connector-writes/confirm-injective.test.ts
// D1 (review rounds 1 and 2): the confirm text is injective over the PROJECTED field values, the
// value each field shows after its `:tail8` projection (an array field shows its elements joined
// by single spaces). It is NOT injective over raw inputs: `:tail8` is a deliberate many-to-one
// projection for opaque ids (the full id is in the typed preview beside it).
//
// Property: for random value tuples over every template, whenever the text renders, reading it
// left to right (each field ends at the FIRST occurrence of the literal text that follows it, the
// last field takes the rest) recovers exactly the projected tuple, and one text never comes from
// two different projected tuples.
import { describe, expect, test } from "bun:test";
import { renderConfirmText } from "./confirm.ts";
import { type ConfirmSegment, parseConfirmTemplate } from "./confirm-template.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { type ConnectorWriteRow, row } from "./types.ts";

/** Seeded, so a failure reproduces. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** The templates D1 ships (plan section 3), spelled out so the property covers them before and after they are on rows. */
const D1_TEMPLATES: readonly string[] = [
  "merge {owner}/{repo}#{pullNumber}",
  "delete {owner}/{repo}@{branch}",
  "create {owner}/{repo}@{tag}",
  "merge {projectPath}!{mergeRequestIid}",
  "merge {repoFull}#{pullRequestId}",
  "trigger {jobName}",
  "abort {jobName}#{buildNumber}",
  "trigger {owner}/{repo}:{workflowId}",
  "cancel {owner}/{repo}#{runId}",
  "trigger {projectSlug}",
  "cancel {projectSlug}#{jobNumber}",
  "retry {projectPath}#{pipelineId}",
  "cancel {projectPath}#{pipelineId}",
  "invoke {functionName}",
  "stop {instanceIds}",
  "start {instanceIds}",
  "restart {resourceGroup}/{name}",
  "scale {resourceGroup}/{clusterName}/{poolName} to {nodeCount}",
  "deploy {projectId}/{region}/{service} {image:tail8}",
  "update {cluster}/{service}",
  "sync {name}",
  "rollback {name}@{id}",
  "reconcile kustomization {namespace}/{name}",
  "reconcile helmrelease {namespace}/{name}",
  "promote {name}/v{version}",
  "transition {name}/v{version} to {stage}",
  "set tag {object}/{tag}",
  "remove tag {object}/{tag}",
  "set comment {object}",
  "delete {itemId:tail8}",
  "delete {eventId:tail8}",
  "delete {href:tail8}",
  "commit {owner}/{repo}@{branch}",
  "commit {projectPath}@{branch}",
];

function allTemplates(): string[] {
  const out = new Set<string>(D1_TEMPLATES);
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (r.confirm === undefined) continue;
    out.add(r.confirm.template);
    if (r.confirm.whenUnset !== undefined) out.add(r.confirm.whenUnset.template);
  }
  return [...out];
}

const ALPHABET = "abcxyz019 /@#:!_.-\\";
const BIASED = "abcxyz019";

function randomValue(rnd: () => number, maxLen: number): string {
  const len = 1 + Math.floor(rnd() * maxLen);
  let v = "";
  for (let i = 0; i < len; i++) {
    const pool = rnd() < 0.7 ? BIASED : ALPHABET;
    v += pool.charAt(Math.floor(rnd() * pool.length));
  }
  return v;
}

function syntheticRow(template: string): ConnectorWriteRow {
  return { ...row("t_x", "github.t.x", "mesh", 4), confirm: { template } };
}

/** What each field shows: its tail when `:tail8`, else the value itself (the raw tuple is scalars). */
function projected(seg: Extract<ConfirmSegment, { kind: "field" }>, raw: string): string {
  const chars = [...raw];
  return seg.tail8 && chars.length > 8 ? chars.slice(-8).join("") : raw;
}

/** The reader: each field ends at the first occurrence of the text after it; the last takes the rest. */
function readLeftToRight(segments: readonly ConfirmSegment[], body: string): string[] | undefined {
  const values: string[] = [];
  let pos = 0;
  for (const [i, seg] of segments.entries()) {
    if (seg.kind === "text") {
      if (!body.startsWith(seg.text, pos)) return undefined;
      pos += seg.text.length;
      continue;
    }
    const next = segments[i + 1];
    if (next?.kind === "text") {
      const end = body.indexOf(next.text, pos);
      if (end === -1) return undefined;
      values.push(body.slice(pos, end));
      pos = end;
    } else {
      values.push(body.slice(pos));
      pos = body.length;
    }
  }
  return values;
}

describe("the confirm text is injective over the projected field values (D1)", () => {
  const templates = allTemplates();

  test("the property runs over the D1 templates and every template on a row", () => {
    expect(templates.length).toBeGreaterThanOrEqual(D1_TEMPLATES.length);
    for (const t of D1_TEMPLATES) expect(parseConfirmTemplate(t).ok, t).toBe(true);
  });

  for (const template of templates) {
    test(`${template}: reading the text left to right recovers the projected tuple; one text, one tuple`, () => {
      const parsed = parseConfirmTemplate(template);
      if (!parsed.ok) throw new Error(parsed.reason);
      const fields = parsed.segments.filter(
        (s): s is Extract<ConfirmSegment, { kind: "field" }> => s.kind === "field",
      );
      const r = syntheticRow(template);
      const rnd = prng(0x5eed + template.length);
      const seen = new Map<string, string>();
      let accepted = 0;
      for (let n = 0; n < 3000; n++) {
        const raw: Record<string, string> = {};
        for (const f of fields) raw[f.name] = randomValue(rnd, f.tail8 ? 20 : 9);
        const out = renderConfirmText(r, raw);
        if (!out.ok) continue;
        accepted++;
        const shown = fields.map((f) => projected(f, raw[f.name] ?? ""));
        const body = out.text.slice("github/".length);
        expect(readLeftToRight(parsed.segments, body), `${out.text}`).toEqual(shown);
        const tuple = JSON.stringify(shown);
        const earlier = seen.get(out.text);
        if (earlier !== undefined) expect(earlier, out.text).toBe(tuple);
        seen.set(out.text, tuple);
      }
      expect(accepted, `${template}: the property must not be vacuous`).toBeGreaterThanOrEqual(10);
    });
  }

  test("an array field shows its space-joined elements, and an element holding a space is refused", () => {
    const parsed = parseConfirmTemplate("stop {ids}@{tail}");
    if (!parsed.ok) throw new Error(parsed.reason);
    const r = syntheticRow("stop {ids}@{tail}");
    const out = renderConfirmText(r, { ids: ["i-1", "i-2"], tail: "x/y z" });
    if (!out.ok) throw new Error(out.reason);
    expect(readLeftToRight(parsed.segments, out.text.slice("github/".length))).toEqual([
      "i-1 i-2",
      "x/y z",
    ]);
    expect(renderConfirmText(r, { ids: ["i-1 i-2"], tail: "x" }).ok).toBe(false);
    expect(renderConfirmText(r, { ids: ["i@1"], tail: "x" }).ok).toBe(false);
  });

  test("the many-to-one projection is deliberate: two ids with the same last 8 characters render alike, and the raw inputs differ", () => {
    const r = syntheticRow("delete {itemId:tail8}");
    const a = renderConfirmText(r, { itemId: "AAAAAAAA-12345678" });
    const b = renderConfirmText(r, { itemId: "BBBBBBBB-12345678" });
    expect(a.ok && b.ok && a.text === b.text).toBe(true);
  });
});

/** Every string of length 1 to `maxLen` over `chars`. */
function allStrings(chars: readonly string[], maxLen: number): string[] {
  let layer: string[] = [""];
  const out: string[] = [];
  for (let n = 0; n < maxLen; n++) {
    layer = layer.flatMap((s) => chars.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

describe("brute-force oracle: no two accepted projected tuples render the same text (D1)", () => {
  // The alphabet holds every separator character the templates below use, plus a space and a slash.
  const CHARS = ["a", "b", "x", "/", " "] as const;
  const SCALARS = allStrings(CHARS, 3);
  // Longer than 8 characters, so `:tail8` projects them (and two of them share a tail).
  const LONG = ["xaaaaaaaab", "baaaaaaaab", "aaaaaaaaaab"];
  const ELEMENTS = allStrings(["a", "b", "x", "/"], 2);
  const ARRAYS: string[][] = [
    ...ELEMENTS.map((e) => [e]),
    ...ELEMENTS.flatMap((e) => ELEMENTS.map((f) => [e, f])),
  ];

  /** Renders every (first, second) pair; returns how many were accepted. Fails on a collision. */
  function sweep(template: string, firsts: readonly unknown[], seconds: readonly string[]): number {
    const parsed = parseConfirmTemplate(template);
    if (!parsed.ok) throw new Error(parsed.reason);
    const [f1, f2] = parsed.segments.filter(
      (s): s is Extract<ConfirmSegment, { kind: "field" }> => s.kind === "field",
    );
    if (f1 === undefined || f2 === undefined) throw new Error("two fields expected");
    const r = syntheticRow(template);
    const seen = new Map<string, string>();
    let accepted = 0;
    for (const first of firsts) {
      for (const second of seconds) {
        const out = renderConfirmText(r, { [f1.name]: first, [f2.name]: second });
        if (!out.ok) continue;
        accepted++;
        const shown1 = Array.isArray(first)
          ? (first as string[]).join(" ")
          : projected(f1, first as string);
        const tuple = JSON.stringify([shown1, projected(f2, second)]);
        const earlier = seen.get(out.text);
        if (earlier !== undefined && earlier !== tuple) {
          throw new Error(`${template}: ${earlier} and ${tuple} both render ${out.text}`);
        }
        seen.set(out.text, tuple);
      }
    }
    return accepted;
  }

  for (const template of ["{a}ab{b}", "{a}a{b}", "{a}x{b}", "{a}aba{b}", "{a}/{b}"]) {
    test(`${template}: scalar values`, () => {
      expect(sweep(template, SCALARS, SCALARS)).toBeGreaterThan(100);
    });
  }

  test("{a:tail8}x{b}: a tail8 field followed by a literal", () => {
    expect(sweep("{a:tail8}x{b}", [...SCALARS, ...LONG], [...SCALARS, ...LONG])).toBeGreaterThan(
      100,
    );
  });

  test("{a:tail8}aba{b}: a tail8 field followed by an overlapping literal", () => {
    expect(sweep("{a:tail8}aba{b}", [...SCALARS, ...LONG], SCALARS)).toBeGreaterThan(100);
  });

  test("{a}x{b}: an array field followed by a literal", () => {
    expect(sweep("{a}x{b}", ARRAYS, SCALARS)).toBeGreaterThan(100);
  });

  test("{a}aba{b}: an array field followed by an overlapping literal", () => {
    expect(sweep("{a}aba{b}", ARRAYS, SCALARS)).toBeGreaterThan(100);
  });

  test("adjacent fields never reach the oracle: the template does not parse", () => {
    expect(parseConfirmTemplate("{a}{b}").ok).toBe(false);
  });
});
