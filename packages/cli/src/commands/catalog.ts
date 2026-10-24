import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

// Local structural shape of `catalog.list`. The CLI reaches the gateway over IPC only, so this is
// declared here and the response is narrowed defensively rather than trusted.
type CatalogAgentRow = {
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly visible: boolean;
};

type CatalogConnectorRow = {
  readonly kind: "builtin" | "extension" | "user-mcp";
  readonly id: string;
  readonly name: string | null;
  readonly category: string;
};

type CatalogView = {
  readonly agents: readonly Record<string, unknown>[];
  readonly connectors: readonly Record<string, unknown>[];
  readonly visibility: Record<string, unknown>;
};

const USAGE = "Usage: nimbus catalog [agents|connectors] [--json]";

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function narrow(value: unknown): CatalogView {
  const v = asRecord(value);
  const visibility = asRecord(v?.["visibility"]);
  const agents = v?.["agents"];
  const connectors = v?.["connectors"];
  if (
    v === undefined ||
    visibility === undefined ||
    !Array.isArray(agents) ||
    !Array.isArray(connectors)
  ) {
    throw new Error("Malformed catalog.list response");
  }
  return {
    agents: agents.map((a) => asRecord(a) ?? {}),
    connectors: connectors.map((c) => asRecord(c) ?? {}),
    visibility,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toAgent(r: Record<string, unknown>): CatalogAgentRow {
  return {
    name: str(r["name"]),
    category: str(r["category"]),
    description: str(r["description"]),
    visible: r["visible"] === true,
  };
}

function toConnector(r: Record<string, unknown>): CatalogConnectorRow {
  const kind = r["kind"] === "extension" || r["kind"] === "user-mcp" ? r["kind"] : "builtin";
  const rawName = kind === "builtin" ? r["displayName"] : r["name"];
  return {
    kind,
    id: str(r["id"]),
    name: typeof rawName === "string" ? rawName : null,
    category: str(r["category"]),
  };
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [fmt(headers), ...rows.map(fmt)];
}

function agentLines(view: CatalogView): string[] {
  const notes = view.visibility["notes"];
  const summary = Array.isArray(notes) ? str(notes[0]) : "";
  const rows = view.agents
    .map(toAgent)
    .map((a) => [
      stripControlChars(a.name),
      a.visible ? "shown" : "hidden",
      stripControlChars(a.category),
      stripControlChars(a.description),
    ]);
  return [
    ...(summary === "" ? [] : [stripControlChars(summary), ""]),
    ...table(["name", "shown", "category", "description"], rows),
  ];
}

function connectorLines(view: CatalogView): string[] {
  const rows = view.connectors
    .map(toConnector)
    .map((c) => [
      stripControlChars(c.id),
      c.name === null || stripControlChars(c.name).trim() === ""
        ? "(no name)"
        : stripControlChars(c.name),
      stripControlChars(c.category),
    ]);
  return table(["id", "name", "category"], rows);
}

export async function runCatalog(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const positional = args.filter((a) => a !== "--json");
  const sub = positional[0];
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return;
  }
  if ((sub !== undefined && sub !== "agents" && sub !== "connectors") || positional.length > 1) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const view = narrow(await withGatewayIpc((c) => c.call<unknown>("catalog.list", undefined)));
  const wantAgents = sub !== "connectors";
  const wantConnectors = sub !== "agents";

  if (json) {
    const out: Record<string, unknown> = {};
    if (wantAgents) out["agents"] = view.agents;
    if (wantConnectors) out["connectors"] = view.connectors;
    if (wantAgents) out["visibility"] = view.visibility;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const lines: string[] = [];
  if (wantAgents) lines.push(...agentLines(view));
  if (wantAgents && wantConnectors) lines.push("");
  if (wantConnectors) lines.push(...connectorLines(view));
  console.log(lines.join("\n"));
}
