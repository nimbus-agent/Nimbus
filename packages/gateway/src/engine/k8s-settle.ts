/**
 * The settler of the plan-bound Kubernetes apply (Phase 9.7 D3a, invariant I54, spec § 15.5).
 *
 * The prepare child (`k8s_manifest_plan`) is the same kind of process that will later apply, so
 * nothing it says about its own result is an identity. This settler runs AFTER the prepare reply
 * passes its size cap and BEFORE the row's bound values are taken, and it fixes the identity
 * itself, purely, from the caller's own input:
 *
 *  - the PLAN HASH is computed by the gateway from the context, the namespace and the exact
 *    manifest text it shows (`k8sPlanHash`, domain `nimbus-k8s-manifest-v2`); the reply's
 *    `planSha256` must equal it or the plan is unbound, and the value bound is the gateway's;
 *  - the DIFF HASH is computed by the gateway from the diff text it renders (`k8sDiffHash`, domain
 *    `nimbus-k8s-diff-v1`); the reply's `diffSha256` must equal it, so the bound hash is the hash of
 *    the text the owner sees, and the connector's apply re-diffs and refuses a cluster that has
 *    changed since;
 *  - the gateway's own parse of the manifest must AGREE with the connector's scan (the multiset of
 *    `(apiVersion, kind, name, namespace?)`) and with `kubectl`'s own object list (`objects`, the
 *    dry run's names), or the plan is unbound: two independent readers must agree.
 *
 * What it cannot check, and says so (I54): the diff and the object list are the child's and the API
 * server's word; the gateway guarantees only that the manifest shown is the manifest applied,
 * namespace-confined, of allowlisted namespaced kinds with agreeing readers, and that the diff
 * shown is the diff the apply will recompute. The settle is a pure function (no process, no file):
 * it reaches the gate only through `BoundWriteCapabilities.settle` (static D42(h)). Every refusal is
 * a fixed {@link PREPARE_REFUSALS} text.
 */

import { escapeOneLine, renderedText } from "../connectors/connector-writes/iac-plan-preview.ts";
import { K8S_LIMITS } from "../connectors/connector-writes/k8s-limits.ts";
import {
  expectedObjectNames,
  type K8sObject,
  k8sDiffHash,
  k8sPlanHash,
  parseK8sManifest,
} from "../connectors/connector-writes/k8s-manifest.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { SettledWrite } from "./bound-write-capabilities.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";

export interface K8sSettleRequest {
  /** The write's input: `{context, namespace, manifest}`. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The prepare child's raw reply. */
  readonly reply: unknown;
  /**
   * The approved API server `host:port` the runner pinned this context to, shown to the owner
   * beside the context name. Absent when the caller has none (the line then shows the context only).
   */
  readonly server?: string;
}

export interface K8sSettleLimits {
  readonly maxRenderedBytes?: number;
  readonly maxObjects?: number;
}

function refuse(reason: string): PrepareRefusedError {
  return new PrepareRefusedError(reason);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function field(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** A canonical, injective key of one scanned or parsed object (for multiset comparison). */
function objectKey(o: {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace?: string | undefined;
}): string {
  return JSON.stringify([o.apiVersion, o.kind, o.name, o.namespace ?? null]);
}

/** The reply's `scanned` list as keys, or `undefined` when any entry is not the connector's shape. */
function scannedKeys(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const keys: string[] = [];
  for (const entry of v as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const apiVersion = field(entry, "apiVersion");
    const kind = field(entry, "kind");
    const name = field(entry, "name");
    const namespace = field(entry, "namespace");
    if (typeof apiVersion !== "string" || typeof kind !== "string" || typeof name !== "string") {
      return undefined;
    }
    if (namespace !== undefined && typeof namespace !== "string") return undefined;
    keys.push(objectKey({ apiVersion, kind, name, namespace }));
  }
  return keys;
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort(codeUnitCompare);
  const y = [...b].sort(codeUnitCompare);
  return x.every((v, i) => v === y[i]);
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list: unknown[] = v;
  return list.every((x) => typeof x === "string") ? (list as string[]) : undefined;
}

function objectLine(o: K8sObject): string {
  return `${escapeOneLine(o.kind)}/${escapeOneLine(o.name)} (${escapeOneLine(o.apiVersion)})`;
}

/** The diff as lines: split on newlines, the final newline of a unified diff not a line of its own. */
function diffLines(diff: string): string[] {
  if (diff === "") return [];
  const body = diff.endsWith("\n") ? diff.slice(0, -1) : diff;
  return body.split("\n").map(escapeOneLine);
}

/**
 * Cross-checks a Kubernetes plan reply against the caller's own input and renders it (module
 * comment). Pure and synchronous; throws a {@link PrepareRefusedError}.
 */
export function settleK8sManifest(
  req: K8sSettleRequest,
  limits: K8sSettleLimits = {},
): SettledWrite {
  const { input, reply } = req;
  const context = field(input, "context");
  const namespace = field(input, "namespace");
  const manifest = field(input, "manifest");
  if (
    typeof context !== "string" ||
    typeof namespace !== "string" ||
    typeof manifest !== "string"
  ) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  const parsed = parseK8sManifest(manifest, namespace);
  if (!parsed.ok) throw refuse(PREPARE_REFUSALS.unbound);
  if (!isRecord(reply)) throw refuse(PREPARE_REFUSALS.unbound);

  // The identity is the gateway's: the reply may only AGREE with it.
  const planSha256 = k8sPlanHash(context, namespace, manifest);
  const replyPlan = field(reply, "planSha256");
  if (typeof replyPlan !== "string" || !sha256HexEqualConstantTime(replyPlan, planSha256)) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  if (field(reply, "namespace") !== namespace) throw refuse(PREPARE_REFUSALS.unbound);

  // Two independent readers must agree on what the manifest declares.
  const scanned = scannedKeys(field(reply, "scanned"));
  if (scanned === undefined || !sameMultiset(scanned, parsed.objects.map(objectKey))) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  const maxObjects = limits.maxObjects ?? K8S_LIMITS.maxObjects;
  const names = stringList(field(reply, "objects"));
  if (names === undefined || names.length > maxObjects) throw refuse(PREPARE_REFUSALS.unshowable);
  if (!sameMultiset(names, expectedObjectNames(parsed.objects))) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }

  const hasDifferences = field(reply, "hasDifferences");
  const diff = field(reply, "diff");
  if (typeof hasDifferences !== "boolean" || typeof diff !== "string") {
    throw refuse(PREPARE_REFUSALS.unshowable);
  }
  // The connector's own rule: `hasDifferences` is exactly "the diff is not empty" (a Secret's
  // withheld diff cannot occur here: the gateway refuses Secrets on every door).
  if (hasDifferences !== (diff !== "")) throw refuse(PREPARE_REFUSALS.unshowable);
  const diffSha256 = k8sDiffHash(diff);
  const replyDiffHash = field(reply, "diffSha256");
  if (typeof replyDiffHash !== "string" || !sha256HexEqualConstantTime(replyDiffHash, diffSha256)) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }

  const lines = [
    `Objects: ${String(parsed.objects.length)}`,
    ...parsed.objects.map(objectLine),
    `Differences: ${hasDifferences ? "yes" : "no"}`,
    ...diffLines(diff),
    `End of plan: ${String(parsed.objects.length)} objects`,
  ];
  const text = renderedText(lines);
  if (text.bytes > (limits.maxRenderedBytes ?? K8S_LIMITS.maxRenderedBytes)) {
    throw refuse(PREPARE_REFUSALS.diffTooLarge);
  }
  const cluster = req.server === undefined ? context : `${context} (${req.server})`;
  return {
    values: Object.freeze({ planSha256, diffSha256 }),
    fields: [
      { label: "Cluster", value: cluster },
      { label: "Namespace", value: namespace },
      { label: "Objects", value: String(parsed.objects.length) },
      { label: "Differences", value: hasDifferences ? "yes" : "no" },
      { label: "Plan hash", value: planSha256 },
    ],
    plan: text,
    // A dry run and a diff create nothing: there is nothing to discard.
    cleanup: () => Promise.resolve(),
  };
}
