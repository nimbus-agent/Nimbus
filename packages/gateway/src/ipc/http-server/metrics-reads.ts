import type { Database } from "bun:sqlite";
import { loadNimbusPreflightRiskFromConfigDir } from "../../config/preflight-risk-toml.ts";
import type { ServiceConfig } from "../../metrics/dora-config.ts";
import { dispatchMetricsRpc, type MetricsRpcContext, MetricsRpcError } from "../metrics-rpc.ts";
import {
  dispatchPreflightRpc,
  type PreflightRpcContext,
  PreflightRpcError,
} from "../preflight-rpc.ts";
import { json, loadServiceConfigs, missingQueryParam, requiredQueryParam } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

/** What `metrics.*` and `deploy.preflight` both take: the read handle, configs, and the clock. */
function serviceRpcContext(
  db: Database,
  opts: ReadOnlyHttpServerOptions,
  loadConfig: () => Map<string, ServiceConfig>,
): MetricsRpcContext & PreflightRpcContext {
  return { db, loadConfig, ...(opts.nowMs === undefined ? {} : { nowMs: opts.nowMs }) };
}

/** A dispatcher's own refusal class (`MetricsRpcError`, `PreflightRpcError`). */
type RpcRefusalClass = abstract new (...args: never[]) => Error;

/**
 * Serves a read-only RPC dispatcher's answer on its public route. Its own `refusal` class becomes a
 * 400 carrying the message verbatim (those messages are the actionable part); ANY other throw
 * propagates to `handleGet`'s generic 500, which keeps a config parser's message (service id,
 * offending value) off the wire; a `miss` is a wiring bug, thrown rather than served. `dispatch` is
 * handed `method`, so the method dispatched and the one that error names cannot drift apart.
 */
async function serveRpcRead(
  method: string,
  refusal: RpcRefusalClass,
  dispatch: (method: string) => Promise<{ kind: "miss" } | { kind: "hit"; value: unknown }>,
): Promise<Response> {
  let out: Awaited<ReturnType<typeof dispatch>>;
  try {
    out = await dispatch(method);
  } catch (e) {
    if (e instanceof refusal) {
      return json({ error: e.message }, 400);
    }
    throw e;
  }
  if (out.kind === "miss") {
    throw new Error(`${method} dispatcher returned miss`);
  }
  return json(out.value);
}

/**
 * GET /v1/metrics/stats — one DORA-family metric as a bucketed TIME SERIES.
 *
 * PUBLIC, beside `/v1/metrics/dora` and `/v1/preflight/deploy`. That is a decision and not an
 * inheritance, and it lands the opposite way from `GET /v1/services/resolve`, which is scoped —
 * so the difference is worth stating, because the next proposal will copy one of them:
 *
 *   - It is the same config and the same service at a different resolution. `/v1/metrics/dora`
 *     already answers the four DORA metrics publicly over an arbitrary `since`, so a caller can
 *     already walk nested windows and difference them; this route makes that cheaper and
 *     disjoint. Its metric set is WIDER than that route's — `pr-merges` and `incidents-opened`
 *     have no scalar equivalent — but neither reaches anything new either: both count rows in
 *     `item` that the public `GET /v1/items` already serves unaggregated.
 *   - Scoping the series while the scalar beside it stays public would be a seam no caller could
 *     explain, and the client that needs it is the same unauthenticated reader.
 *
 * `/v1/services/resolve` is scoped for the opposite reason: it CLAIMS narrowness (one repo the
 * caller already named), and a public mount would have let N cheap calls rebuild the whole
 * service-to-repo grouping it exists not to expose.
 *
 * Public therefore also means published: `HTTP_ROUTES` plus a `paths:` entry in
 * `openapi/v1.yaml`, which `audit:openapi-drift` enforces as a pair.
 *
 * Appends NO egress row — it reads the local index and the owner's config, and makes no
 * outbound request (the `http` narrowing in `egress/egress-coverage.ts`).
 */
export async function handleMetricsStats(
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  // Params mirror the IPC one-for-one, snake_case included: the CLI parses `--window 90d` at its
  // own edge and the IPC layer takes milliseconds, so integer ms keeps this route on the same
  // side of that line as the method it wraps. `requireStatsParams` does the real validation and
  // its messages are actionable, so bare presence is all that is checked here.
  const service = requiredQueryParam(url, "service");
  if (service === null) return missingQueryParam("service");
  const metric = requiredQueryParam(url, "metric");
  if (metric === null) return missingQueryParam("metric");
  // The two integers refuse only ABSENCE, not emptiness, so they are not `requiredQueryParam`: a
  // present-but-empty `?window_ms=` passes and reaches the dispatcher as `Number("")`, i.e. 0,
  // which its bucket-shape check refuses as non-positive (see the conversion below).
  const windowMs = url.searchParams.get("window_ms");
  if (windowMs === null) return missingQueryParam("window_ms");
  // Checked SEPARATELY from `window_ms`, not as one combined `||`. A combined check names both
  // params whatever the caller omitted, so someone who sent `window_ms` and forgot `bucket_ms`
  // is told `window_ms` is missing too — and then goes looking at the one param they got right.
  const bucketMs = url.searchParams.get("bucket_ms");
  if (bucketMs === null) return missingQueryParam("bucket_ms");
  let loaded: Map<string, ServiceConfig>;
  try {
    loaded = loadServiceConfigs(opts);
  } catch {
    // Loaded HERE rather than inside the dispatcher's `loadConfig` thunk, so a malformed
    // `nimbus.toml` is caught and NAMED rather than escaping to `handleGet`'s generic
    // `internal_error` 500 — which is what `/v1/metrics/dora` beside it still answers today. The
    // body names only THAT parsing failed: the parser's messages embed the service id AND the
    // offending config value, and on a PUBLIC route that is readable by any local process on the
    // machine. Same answer as `GET /v1/services/resolve` gives, deliberately: the design asked
    // that both routes answer this seam the same way.
    //
    // Not a fix for the sibling route. That is pre-existing and out of scope here; it is named so
    // the next reader knows the two differ on purpose rather than by oversight.
    return json({ error: "config_unreadable" }, 500);
  }
  // `MetricsRpcError` covers the unknown-service refusal AND every `StatsBucketError` the
  // dispatcher already maps to it — non-positive or inverted bounds, and the MAX_BUCKETS ceiling.
  // Those messages are actionable ("widen the bucket or narrow the window") and reach the client
  // verbatim, as `serveRpcRead`'s 400.
  return await serveRpcRead("metrics.stats", MetricsRpcError, (method) =>
    dispatchMetricsRpc(
      method,
      {
        service,
        metric,
        // `requireStatsParams` demands real integers (`Number.isInteger`), so the query
        // string's values must be converted here — but deliberately NOT validated here.
        // `Number("abc")` is `NaN`, which fails that check and produces the dispatcher's own
        // message naming both params; a second, blander rejection at this layer would only
        // shadow it. `Number("")` is 0, which the bucket-shape check refuses as non-positive.
        window_ms: Number(windowMs),
        bucket_ms: Number(bucketMs),
      },
      serviceRpcContext(db, opts, () => loaded),
    ),
  );
}

export async function handleMetricsDora(
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const service = requiredQueryParam(url, "service");
  if (service === null) return missingQueryParam("service");
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw === null || sinceRaw === "" ? "30d" : sinceRaw;
  return await serveRpcRead("metrics.dora", MetricsRpcError, (method) =>
    dispatchMetricsRpc(
      method,
      { service, since },
      serviceRpcContext(db, opts, () => loadServiceConfigs(opts)),
    ),
  );
}

export async function handleDeployPreflight(
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const service = requiredQueryParam(url, "service");
  if (service === null) return missingQueryParam("service");
  const targetRef = requiredQueryParam(url, "target_ref");
  if (targetRef === null) return missingQueryParam("target_ref");
  const maxFindingsRaw = url.searchParams.get("max_findings");
  const maxFindings =
    maxFindingsRaw === null || maxFindingsRaw === ""
      ? undefined
      : Number.parseInt(maxFindingsRaw, 10);
  if (maxFindings !== undefined && !Number.isInteger(maxFindings)) {
    return json({ error: "max_findings must be an integer" }, 400);
  }
  return await serveRpcRead("deploy.preflight", PreflightRpcError, (method) =>
    dispatchPreflightRpc(
      method,
      maxFindings === undefined
        ? { service, target_ref: targetRef }
        : { service, target_ref: targetRef, max_findings: maxFindings },
      {
        ...serviceRpcContext(db, opts, () => loadServiceConfigs(opts)),
        ...(opts.configDir === undefined
          ? {}
          : {
              loadRiskConfig: () => loadNimbusPreflightRiskFromConfigDir(opts.configDir as string),
            }),
      },
    ),
  );
}
