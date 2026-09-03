import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

// Mirrors gateway `llm/route-availability.ts`'s `RouteAvailability["reason"]` — kept as an
// open string here (not re-imported: cli has no source dependency on gateway, IPC-only) so a
// future reason value degrades to its raw text rather than a type error.
//
// The `string & {}` arm is what keeps that openness WITHOUT the four literals being swallowed.
// A bare `| string` collapses the whole union to `string`, so the known values stop being
// suggested and a typo in one of them stops being visible. This form accepts any string exactly
// as before and keeps the four as named members.
type RouteReason =
  | "ok"
  | "provider_unreachable"
  | "model_absent"
  | "not_configured"
  | (string & {});

type RouteStatus = {
  routeId: string;
  providerId: string;
  modelName: string;
  isLocal: boolean;
  available: boolean;
  reason: RouteReason;
  // Frequently absent — never fabricate a value here, render "—" instead.
  contextWindow?: number;
};

// Total column widths INCLUDING the two-space gap `pad` appends when a value is short enough to
// be padded, so the table's geometry is unchanged from before the gap existed.
const COL_WIDTHS = {
  routeId: 22,
  provider: 10,
  model: 20,
  local: 7,
  available: 26,
  context: 8,
};

/**
 * A MINIMUM column width plus an unconditional gap.
 *
 * The gap is the point. Padding alone guarantees a minimum width, NOT a separator: at
 * `s.length >= width` the old version emitted the bare string and the next column began on the
 * very next character, so `ollama/llama3.2:latest` (exactly 22, the `routeId` width) rendered as
 * `ollama/llama3.2:latestollama`. Slice 2b's own flagship route, `anthropic/claude-sonnet-4-6`
 * (27), collides too, so the first vendor most people enable hits it.
 *
 * Widening the column is NOT the fix — it moves the cliff to the first longer model name, and
 * `ollama/hf.co/user/some-long-model` is already a supported route-id shape. A separator that
 * does not depend on the value's length has no cliff.
 */
const COL_GAP = "  ";

function pad(s: string, width: number): string {
  return s.length >= width ? s + COL_GAP : s + " ".repeat(width - s.length);
}

// The two failure reasons have different fixes (start the daemon vs. pull the model) and must
// stay distinguishable in the rendered text — never collapsed to a bare "unavailable".
function availabilityText(route: RouteStatus): string {
  if (route.available) return "yes";
  if (route.reason === "provider_unreachable") return "no (provider unreachable)";
  if (route.reason === "model_absent") return "no (model not pulled)";
  // A cloud route that is enabled but keyless. Its remedy is a Vault key -- not starting a daemon
  // and not pulling a model -- so it must stay distinguishable from the two above.
  if (route.reason === "not_configured") return "no (no api key)";
  return `no (${route.reason})`;
}

function contextText(route: RouteStatus): string {
  return route.contextWindow === undefined ? "—" : String(route.contextWindow);
}

function printRouteTable(routes: RouteStatus[]): void {
  const header =
    pad("Route", COL_WIDTHS.routeId) +
    pad("Provider", COL_WIDTHS.provider) +
    pad("Model", COL_WIDTHS.model) +
    pad("Local", COL_WIDTHS.local) +
    pad("Available", COL_WIDTHS.available) +
    "Context";
  const divider = "-".repeat(header.length);
  console.log(header);
  console.log(divider);
  if (routes.length === 0) {
    console.log("(no routes registered)");
    return;
  }
  for (const route of routes) {
    console.log(
      pad(route.routeId, COL_WIDTHS.routeId) +
        pad(route.providerId, COL_WIDTHS.provider) +
        pad(route.modelName || "—", COL_WIDTHS.model) +
        pad(route.isLocal ? "yes" : "no", COL_WIDTHS.local) +
        pad(availabilityText(route), COL_WIDTHS.available) +
        contextText(route),
    );
  }
}

/**
 * Narrows the `llm.status` payload's envelope. Unguarded, a payload without a `routes` array
 * threw a raw `TypeError` on `.length` deep inside the table renderer — a stack trace where the
 * actual fact ("the gateway answered with something this build does not understand") is what the
 * user needs. Returns the rows still UNVALIDATED, so `--json` can emit exactly what the gateway
 * sent; the table path narrows each row itself, below.
 */
function requireRoutesArray(res: unknown): unknown[] {
  const routes = (res as { routes?: unknown } | null | undefined)?.routes;
  if (!Array.isArray(routes)) {
    throw new TypeError(
      "llm.status returned an unexpected payload: no `routes` array. " +
        "The gateway is likely a different version than this CLI.",
    );
  }
  return routes;
}

/**
 * Narrows one row for the TABLE renderer, which indexes fields: `pad()` calls `.length` on
 * `routeId`, so one malformed row is the same crash as a malformed envelope. Deliberately narrow
 * — the fields this renderer reads and nothing more; an unknown extra field is not an error, and
 * an absent `contextWindow` is normal (it renders as "—", never as a fabricated number).
 */
function toRouteStatus(row: unknown, i: number): RouteStatus {
  const r = row as Partial<RouteStatus> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    typeof r.routeId !== "string" ||
    typeof r.providerId !== "string" ||
    typeof r.modelName !== "string"
  ) {
    throw new Error(
      `llm.status returned an unexpected payload: route ${i} is missing routeId/providerId/modelName.`,
    );
  }
  return {
    routeId: r.routeId,
    providerId: r.providerId,
    modelName: r.modelName,
    isLocal: r.isLocal === true,
    available: r.available === true,
    reason: typeof r.reason === "string" ? r.reason : "unknown",
    ...(typeof r.contextWindow === "number" ? { contextWindow: r.contextWindow } : {}),
  };
}

export async function runLlmStatusImpl(client: IPCClient, opts: { json: boolean }): Promise<void> {
  const routes = requireRoutesArray(await client.call<unknown>("llm.status", {}));
  if (opts.json) {
    // Emitted faithfully: whatever the gateway reported, verbatim — including a missing
    // contextWindow staying absent from the JSON rather than becoming a fabricated number.
    // Hence the raw rows here, never the table renderer's narrowed copies.
    console.log(JSON.stringify(routes, null, 2));
    return;
  }
  // Explicit arity rather than `map(toRouteStatus)`: `.map` supplies
  // (element, index, array), so passing the function bare would hand it a third
  // argument the day anyone adds a parameter. The index is wanted — it names the
  // offending row in the validation error — but only the two.
  printRouteTable(routes.map((row, i) => toRouteStatus(row, i)));
}

/**
 * `nimbus llm use <task> <routeId>` — pins a task type to a route id.
 *
 * A thin IPC call, deliberately: `llm.use` validates the task type and the route id and
 * writes `[llm.tasks]` in `nimbus.toml` GATEWAY-side (`ipc/llm-rpc.ts`'s `handleLlmUse`), not
 * here. Splitting that — validate here, write there — would put the check and the write in
 * different processes with a window between them; see the gateway-side doc comment for the
 * full reasoning. Both forms (this command, or hand-editing the file) write the SAME table.
 */
export async function runLlmUseImpl(
  client: IPCClient,
  opts: { task: string; routeId: string },
): Promise<void> {
  await client.call<{ ok: true }>("llm.use", { task: opts.task, routeId: opts.routeId });
  console.log(`Pinned "${opts.task}" to "${opts.routeId}" in [llm.tasks].`);
  console.log("Applied immediately — no restart needed — and persisted for the next one.");
}

export async function runLlm(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
    console.log("Usage: nimbus llm <subcommand>");
    console.log("");
    console.log("Subcommands:");
    console.log("  status                 Show every registered LLM route and its availability");
    console.log("  use <task> <routeId>   Pin a task type to a registered route");
    console.log("");
    console.log("Flags:");
    console.log("  --json    Emit machine-readable JSON");
    return;
  }

  if (subcommand === "status") {
    const json = rest.includes("--json");
    await withGatewayIpc((c) => runLlmStatusImpl(c, { json }));
    return;
  }

  if (subcommand === "use") {
    const [task, routeId] = rest;
    if (task === undefined || routeId === undefined) {
      throw new Error(
        "Usage: nimbus llm use <task> <routeId>   (see `nimbus llm status` for route ids)",
      );
    }
    await withGatewayIpc((c) => runLlmUseImpl(c, { task, routeId }));
    return;
  }

  throw new Error(`Unknown llm subcommand: ${subcommand}`);
}
