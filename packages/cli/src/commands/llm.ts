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

type LlmStatusResponse = {
  routes: RouteStatus[];
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

export async function runLlmStatusImpl(client: IPCClient, opts: { json: boolean }): Promise<void> {
  const res = await client.call<LlmStatusResponse>("llm.status", {});
  if (opts.json) {
    // Emitted faithfully: whatever the gateway reported, verbatim — including a missing
    // contextWindow staying absent from the JSON rather than becoming a fabricated number.
    console.log(JSON.stringify(res.routes, null, 2));
    return;
  }
  printRouteTable(res.routes);
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
