import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

// Mirrors gateway `llm/route-availability.ts`'s `RouteAvailability["reason"]` — kept as an
// open string here (not re-imported: cli has no source dependency on gateway, IPC-only) so a
// future reason value degrades to its raw text rather than a type error.
type RouteReason = "ok" | "provider_unreachable" | "model_absent" | string;

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

const COL_WIDTHS = {
  routeId: 22,
  provider: 10,
  model: 20,
  local: 7,
  available: 26,
  context: 8,
};

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// The two failure reasons have different fixes (start the daemon vs. pull the model) and must
// stay distinguishable in the rendered text — never collapsed to a bare "unavailable".
function availabilityText(route: RouteStatus): string {
  if (route.available) return "yes";
  if (route.reason === "provider_unreachable") return "no (provider unreachable)";
  if (route.reason === "model_absent") return "no (model not pulled)";
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
    throw new Error(
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

export async function runLlm(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
    console.log("Usage: nimbus llm <subcommand>");
    console.log("");
    console.log("Subcommands:");
    console.log("  status    Show every registered LLM route and its availability");
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

  throw new Error(`Unknown llm subcommand: ${subcommand}`);
}
