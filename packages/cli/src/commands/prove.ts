import type { IPCClient } from "../ipc-client/index.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type VerifyResult = { ok: boolean; verifiedRows: number; brokenAt?: number; reason?: string };
type EgressRow = { timestamp: number; destination: string; method: string; resultStatus: string };

export interface ProveCompleteness {
  readonly coverage: Readonly<Record<string, string>>;
  readonly outboundEgressEvents: number;
  readonly indeterminate: boolean;
}

type ProveResult = {
  rows: EgressRow[];
  /** Total rows in the window. `rows` is a page of at most 1000 of them. */
  rowsTotal?: number;
  rowsTruncated?: boolean;
  completeness: ProveCompleteness;
  verify: VerifyResult;
  receipt?: { sigB64: string; pubkeyB64: string; digest: string };
};

/**
 * Friendlier display name for a coverage class; classes without an entry print their raw name.
 *
 * EVERY coverage class the gateway can observe needs an entry here, and each label must be worded
 * NARROWLY ENOUGH that it cannot be read as broader than the appender behind it. The raw fallback
 * is the trap: a bare `mcp` in a scope line reads as "everything my MCP client does", when the
 * class in fact covers only `agents.*` briefs served to a client that declared `kind: "mcp"` — not
 * `ask`, not `search.query`, not `glossary.*`, none of which that same client's socket calls would
 * ledger. Overstating scope on this surface is the same defect as the understating one guarded
 * against below, pointed the other way, and it is worse here: this is the one output whose entire
 * purpose is not over-claiming. Keep the labels in sync with `COVERAGE_CLASSES`
 * (`gateway/src/egress/egress-coverage.ts`) — the CLI cannot import it (cli→gateway source imports
 * are forbidden), so this map is a hand-maintained mirror and drifts silently if you forget.
 */
export const COVERAGE_CLASS_LABELS: Readonly<Record<string, string>> = {
  // LIVE as of the raw-CDP browser driver landing -- no longer latent. The appender
  // (`egress/browser-egress.ts`'s `wrapLedgeredBrowserContext`) decorates the CDP-backed context
  // that `computer-use/cu-lanes/browser.ts` constructs, appending one row per (destination origin,
  // verdict) BEFORE the request is allowed to proceed.
  //
  // "requests" plural against "per-run" granularity is deliberate and is why the label says
  // "origins contacted" rather than a count of calls: one row stands for every request to that
  // origin under that verdict, so this class NAMES where the browser went and does not measure how
  // often. Read a zero as "no browser lane made a request" -- on a stock install that is because
  // `[computer_use]` is off and no lane exists, which is the same claim, not a weaker one.
  //
  // TWO bounds, both narrower than the label alone would suggest. (1) Section 3.5.1's: `script`
  // and `image` subresources load from ANY origin (blocking either breaks the real web), so a
  // beacon built into a page's markup still leaves -- it just leaves with a row naming its origin,
  // which is the whole mitigation. (2) The class covers the lane's PAGE traffic, where CDP `Fetch`
  // interception is scoped; Chrome's OWN browser-process chatter (variations, Safe Browsing,
  // reliability beacons) originates outside any page target and is neither gated nor rowed --
  // observed on a CI runner, with the quieting flags already set. Hence "the page" in the label:
  // a zero here means the lane's page contacted nobody, not that the browser process did.
  browser: "origins the computer-use browser lane's page contacted",
  // Unlike `mcp` and `http`, this class is NOT narrower than its name: it covers EVERY outbound
  // post the gateway makes to Slack/Teams — operational replies, HITL approval cards, tribal
  // suggestions and agent briefs — because the appender decorates the single post closure they all
  // share. A zero here means the bot said nothing.
  chatops: "Slack/Teams posts",
  task: "gated connector actions",
  mcp: "agents.* briefs served to MCP clients",
  // NOT "the HTTP API" — the class covers agent briefs only. The other HTTP reads append nothing:
  // `GET /v1/items/resolve` in particular answers a URL lookup from the LOCAL index with no
  // outbound request, and saying so here is the whole point of a hand-written label: this is what
  // a human reads when `nimbus prove` prints its scope, and a label wider than the appender would
  // overstate the proof.
  http: "agents.* briefs served over the local HTTP API",
  // "runs", not "calls": a scheduled sync is a paginated RUN that can make many upstream calls and
  // ledgers ONE row for the whole run (`sync/scheduler.ts`'s `appendSyncEgress`); a targeted
  // fetch-on-miss call (`POST /v1/items/fetch`, `sync/targeted-fetch.ts`'s `appendEgress`) ledgers
  // one row for its one call; a cloud media byte-URL RESOLVE round-trip (the credentialed request
  // asking Google Photos/OneDrive where an artifact's bytes live,
  // `multimodal/cloud-url-resolver.ts`'s `appendEgress`) ledgers one row; and a cloud media
  // byte-fetch attempt (Google Photos/Drive/OneDrive, `multimodal/cloud-bytes.ts`'s `appendEgress`,
  // one row per attempt including retries) ledgers one row per attempt. So a single Photos or
  // OneDrive artifact contributes TWO rows for its TWO real outbound requests — the label says
  // "byte-URL resolves and byte-fetches" rather than one word for both, because collapsing them
  // would hide that a candidate failing at resolve still made a credentialed request. All four
  // land through the same appender
  // (`egress/sync-egress.ts`'s `recordSyncEgress`), and "runs" is the word that does not overclaim
  // the scheduled-sync quarter of the set — "calls" would read as per-call precision this class
  // does not have. "configured", not unqualified "connector": `sync/scheduler.ts`'s `runJob` skips the
  // append entirely for a connector `isConnectorConfigured` (`sync/connector-configured.ts`) says
  // is unconfigured — the connector's own `sync()` still runs (and, for six of them, still fails
  // loudly), it just makes no outbound call and ledgers no row — so a zero here means no
  // CONFIGURED connector's sync/fetch/resolve/byte-fetch ran, not that no syncable on the scheduler
  // executed at all. The cloud arm has its own, separately-implemented analogue: both its appenders
  // skip (and ledger nothing) when `bearerFor` cannot resolve a usable OAuth grant for the
  // candidate's service, rather than consulting `isConnectorConfigured`.
  sync: "configured connector sync runs, targeted fetch-on-miss calls, and cloud media byte-URL resolves and byte-fetches",
  // NOT "model calls". Covers every non-local ROUTE in the router's table (all callers, via the
  // provider wrapper `egress/model-egress.ts`), the Mastra engine agent (a second appender at the
  // AI-SDK seam, since it resolves its model outside the route table entirely), and remote
  // embeddings (a third appender at each embedding-pipeline construction site) -- wider than the
  // brief-synthesis-only scope this label used to name. The class carries no NAMED exclusion: a
  // LOCAL provider, a locally-run Mastra model, or a LOCAL embedder each append nothing by design,
  // not as a gap, so a zero here is still not literally a claim that no vector or prompt left the
  // machine. See the `model` entry in the gateway's `egress/egress-coverage.ts`.
  model: "prompts and embedding batches sent to a non-local model",
  // Latent — always "none" on this binary; no appender exists yet. Named here anyway so a class
  // this vector already reserves never prints as a bare identifier once it does.
  peer: "federated peer sends",
  // Latent — always "none" on this binary; no appender exists yet. Gateway housekeeping egress:
  // telemetry, the auto-updater, JWKS refresh.
  session: "gateway housekeeping egress (telemetry, updater, JWKS)",
};

/**
 * Pure renderer — the whole point is that this is testable without a gateway.
 *
 * `label` names the scope of `delta` in the printed line (e.g. "during this query" for the
 * `runProve` head-count diff, "in this window" for the `runEgressReport` / `nimbus egress` total)
 * — the two are DIFFERENT numbers over DIFFERENT scopes, and printing them under the same label is
 * exactly the "count printed under a scope that does not apply to it" defect this ledger exists to
 * prevent. Callers must supply the label true for the number they are passing.
 */
export function formatProveResult(input: {
  readonly delta: number;
  readonly completeness: ProveCompleteness;
  readonly chainOk: boolean;
  readonly label: string;
}): string {
  if (!input.chainOk || input.completeness.indeterminate) {
    const why = !input.chainOk
      ? "the egress chain is unverifiable"
      : "no boot marker covers this window, so nothing recorded what was being observed";
    return `indeterminate — cannot prove zero egress: ${why}`;
  }
  const observed = Object.entries(input.completeness.coverage)
    .filter(([, g]) => g !== "none")
    .map(([c]) => c)
    .sort((a, b) => a.localeCompare(b));
  const unobserved = Object.entries(input.completeness.coverage)
    .filter(([, g]) => g === "none")
    .map(([c]) => c)
    .sort((a, b) => a.localeCompare(b));
  // Name EVERY observed class — collapsing to just "gated connector actions" whenever `task` is
  // among several observed classes would silently drop the others from both this line AND the
  // "not observed" line below, understating scope.
  const scope = observed.map((c) => COVERAGE_CLASS_LABELS[c] ?? c).join(", ");
  // The HEADLINE names its own narrowness (F9). "outbound egress events during this query: 0" is
  // the line a user reads; the scope parenthetical is the line they skip. During the audit four
  // real outbound attempts to `api.anthropic.com` were made by the remote intent classifier — a
  // class this ledger does not cover — and the headline still said 0. The scope label was honest
  // and the number was correct; the sentence still read as "nothing left the machine".
  //
  // "in the covered classes" is four words and cannot be skipped, because it sits inside the
  // clause carrying the number rather than after it.
  const lines = [
    `outbound egress events ${input.label}, in the covered classes: ${String(input.delta)} (scope: ${scope})`,
  ];
  if (unobserved.length > 0) {
    lines.push(`  not observed: ${unobserved.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * A `withGatewayIpc` call with a caller-sized request budget.
 *
 * It used to pass the interactive consent prompt explicitly, which is why it is named for
 * consent; `withGatewayIpc` now registers that prompt itself and there is no way to opt out,
 * so the only thing left here is the timeout. An inline `consent.request` — egress.prune's
 * owner-HITL gate, or any HITL action a proved query triggers — is awaited INSIDE the pending
 * call, so `requestTimeoutMs` is also the user's think time: pass a budget sized for a human,
 * not for an RPC.
 *
 * (Two stacked doc comments used to sit here, one of them referring to a `withIpc` helper this
 * file does not have.)
 */
async function withConsentIpc<T>(
  fn: (c: IPCClient) => Promise<T>,
  requestTimeoutMs?: number,
): Promise<T> {
  return withGatewayIpc(fn, undefined, {
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
}

/**
 * Resolve the prune cutoff from EITHER the absolute `--before <ISO|epoch>` form OR the relative
 * `--older-than <dur>` form (e.g. `--older-than 30d`). The two are mutually exclusive — supplying
 * both is an error. `--older-than` reuses the shipped `parseSinceDurationToMs` (the `nimbus audit
 * --since` parser) so the duration grammar (`7d`/`24h`/`30m`/…) is identical across the CLI:
 * `beforeTs = now - parseSinceDurationToMs(value)`. `--before` accepts an ISO date or an epoch-ms
 * integer. Throws on a missing/invalid value or when neither form is present.
 */
export function resolvePruneBeforeTs(args: string[], now: number): number {
  const bi = args.indexOf("--before");
  const oi = args.indexOf("--older-than");
  const beforeRaw = bi >= 0 ? args[bi + 1] : undefined;
  const olderRaw = oi >= 0 ? args[oi + 1] : undefined;
  if (beforeRaw !== undefined && olderRaw !== undefined) {
    throw new Error("Use either --before <ISO|epoch> or --older-than <duration>, not both.");
  }
  if (olderRaw !== undefined) {
    // parseSinceDurationToMs throws on an invalid grammar (examples: 7d, 24h, 30m).
    return now - parseSinceDurationToMs(olderRaw);
  }
  if (beforeRaw !== undefined) {
    const asEpoch = /^\d+$/.test(beforeRaw)
      ? Number.parseInt(beforeRaw, 10)
      : Date.parse(beforeRaw);
    if (Number.isNaN(asEpoch)) {
      throw new TypeError(
        `Invalid --before value: ${beforeRaw} (expected an ISO date or epoch ms)`,
      );
    }
    return asEpoch;
  }
  throw new Error("Usage: nimbus egress prune (--before <ISO|epoch> | --older-than <duration>)");
}

/** Parse `--since <dur>` (e.g. 24h, 30m, 7d) into an epoch-ms lower bound relative to now. */
function parseSince(args: string[], now: number): number | undefined {
  const i = args.indexOf("--since");
  if (i < 0) return undefined;
  const raw = args[i + 1];
  if (raw === undefined || raw.startsWith("--")) return undefined;
  return now - parseSinceDurationToMs(raw);
}

export async function runEgressVerify(client: IPCClient): Promise<void> {
  const out = await client.call<VerifyResult>("egress.verify", {});
  if (out.ok) {
    console.log(`[ok]   egress chain integrity — ${String(out.verifiedRows)} rows verified`);
    process.exitCode = 0;
  } else {
    console.log(
      `[FAIL] egress chain break at row ${String(out.brokenAt)}: ${out.reason ?? "unknown"}`,
    );
    process.exitCode = 1;
  }
}

export async function runEgressReport(
  client: IPCClient,
  opts: { since?: number | undefined; json?: boolean; sign?: boolean },
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (opts.since !== undefined) params["since"] = opts.since;
  if (opts.sign === true) params["sign"] = true;
  const out = await client.call<ProveResult>("egress.proveWindow", params);
  if (opts.json === true) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (!out.verify.ok) {
    // The EAF "indeterminate, never a false zero" rule: a degraded chain is unverifiable, NOT proof
    // of zero egress.
    console.log(
      `indeterminate — egress chain is unverifiable (break at row ${String(out.verify.brokenAt)})`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    formatProveResult({
      delta: out.completeness.outboundEgressEvents,
      completeness: out.completeness,
      chainOk: out.verify.ok,
      // This is the whole-ledger or --since-window total, not a query delta — there is no query
      // here (this is also the `nimbus egress [--since]` surface).
      label: "in this window",
    }),
  );
  if (out.completeness.indeterminate) {
    // Chain is intact (the `!out.verify.ok` branch above already returned), but no boot marker
    // covers this window — the count cannot be trusted. An unprovable window must not exit 0.
    process.exitCode = 1;
  }
  for (const r of out.rows) {
    const ts = new Date(r.timestamp).toISOString().replace("T", " ").slice(0, 19);
    console.log(`  ${ts}  ${r.method.padEnd(28)} ${r.resultStatus}`);
  }
  if (out.rowsTruncated === true) {
    // The COUNT above is exact for the whole window; only this listing is a page. Saying so keeps
    // the listing from reading as the complete set of what left.
    console.log(
      `  … showing the oldest ${String(out.rows.length)} of ${String(out.rowsTotal ?? out.rows.length)} rows in this window (the count above covers all of them)`,
    );
  }
  if (out.receipt !== undefined) {
    console.log(`receipt: digest=${out.receipt.digest} sig=${out.receipt.sigB64.slice(0, 16)}…`);
  }
}

/** `nimbus prove "<query>"` — snapshot a time window around the query, print the egress delta. */
export async function runProve(args: string[]): Promise<void> {
  const sign = args.includes("--receipt") || args.includes("--sign");
  const query = args.find((a) => !a.startsWith("--"));
  // `agent.invoke` below is `stream: false`, so unlike `nimbus ask` there are no tokens
  // already on stdout to salvage: a timeout here loses the whole answer AND the proof.
  await withConsentIpc(async (client) => {
    const since = Date.now();
    if (query !== undefined && query !== "") {
      // The blocking ask path (mirrors `nimbus ask`): agent.invoke runs the query so the ledger head
      // advances if (and only if) the agent dispatches a real outbound action.
      await client.call("agent.invoke", { input: query, stream: false });
    }
    const until = Date.now();
    // `egress.proveWindow({ since, until })` — NOT `egress.head` before/after — so the headline
    // uses the SAME counting rule as the report below: authorized, non-marker rows only. A raw
    // `head.count` diff would also count blocked rows, boot/degraded markers, and any concurrent
    // append from another session, silently inflating the number this command exists to keep
    // honest.
    //
    // RESIDUAL LIMITATION: this is a TIME window, not a query-correlation id. There is no per-row
    // field tying an egress_ledger row to the query that caused it, so a concurrent append from
    // another gateway session (another CLI invocation, another agent run, a background sync) that
    // lands inside [since, until] is counted here too, attributed to a query that did not cause
    // it. This command does not — and structurally cannot, without a correlation id threaded
    // through the executor and stored per row — prove that the counted egress was CAUSED BY this
    // query, only that authorized, non-marker egress was appended during the time this query ran.
    const window = await client.call<ProveResult>("egress.proveWindow", { since, until });
    const delta = window.completeness.outboundEgressEvents;
    console.log(
      formatProveResult({
        delta,
        completeness: window.completeness,
        chainOk: window.verify.ok,
        // `delta` is the authorized, non-marker row count for the [since, until] window this query
        // ran in — the same counting rule `runEgressReport` uses below, just windowed narrower.
        label: "during this query",
      }),
    );
    if (window.verify.ok === false || window.completeness.indeterminate) {
      process.exitCode = 1;
    }
    if (delta !== 0) {
      // Prints a SEPARATE report scoped "in this window" (the whole-ledger/--since total, with its
      // own row table) — deliberately a different label from the line above, since it is a
      // different number over a different scope.
      await runEgressReport(client, { json: false, sign });
    }
  }, INTERACTIVE_RPC_TIMEOUT_MS);
}

/**
 * `nimbus egress [verify] [--since <dur>] [--json] [--sign]` — the report / offline verify.
 * `nimbus egress prune (--before <ISO|epoch> | --older-than <duration>)` — HITL-gated retention
 * (e.g. `nimbus egress prune --older-than 30d`); the two cutoff forms are mutually exclusive.
 */
export async function runEgress(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "verify") {
    await withGatewayIpc((c) => runEgressVerify(c));
    return;
  }
  if (sub === "prune") {
    // Accepts either the absolute `--before <ISO|epoch>` or the relative `--older-than <duration>`
    // (e.g. `nimbus egress prune --older-than 30d`); the two are mutually exclusive. The owner-HITL
    // gate prompts inline (registerConsentPromptHandler) — deny → nothing removed.
    const beforeTs = resolvePruneBeforeTs(rest, Date.now());
    await withConsentIpc(async (c) => {
      const out = await c.call<{ approved: boolean; prunedCount: number }>("egress.prune", {
        beforeTs,
      });
      console.log(
        out.approved
          ? `[ok] pruned ${String(out.prunedCount)} egress rows (tombstone written)`
          : "[denied] prune not approved — nothing removed",
      );
    }, INTERACTIVE_RPC_TIMEOUT_MS);
    return;
  }
  const since = parseSince(args, Date.now());
  const json = args.includes("--json");
  const signFlag = args.includes("--sign");
  await withGatewayIpc((c) => runEgressReport(c, { since, json, sign: signFlag }));
}
