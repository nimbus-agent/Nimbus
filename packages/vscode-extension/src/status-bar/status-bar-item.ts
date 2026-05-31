import type { ConnectionState } from "../connection/connection-manager.js";
import type { StatusBarItemHandle } from "../vscode-shim.js";

export type StatusBarInputs = {
  connection: ConnectionState;
  profile: string;
  degradedConnectorCount: number;
  degradedConnectorNames: string[];
  pendingHitlCount: number;
  autoStartGateway: boolean;
};

export type StatusBarRender = {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: { id: string } | undefined;
};

const COLOR_WARN = { id: "statusBarItem.warningBackground" };
const COLOR_ERR = { id: "statusBarItem.errorBackground" };

function formatNonConnected(
  connection: Exclude<ConnectionState, { kind: "connected" }>,
  autoStartGateway: boolean,
): StatusBarRender | undefined {
  if (connection.kind === "connecting" || connection.kind === "idle") {
    const tooltip =
      connection.kind === "connecting"
        ? `Connecting to Gateway socket: ${connection.socketPath}`
        : "Initializing";
    return {
      text: "Nimbus: $(sync~spin) connecting…",
      tooltip,
      command: undefined,
      backgroundColor: undefined,
    };
  }
  if (connection.kind === "permission-denied") {
    return {
      text: "Nimbus: $(error) Socket permission denied",
      tooltip: `Permission denied accessing socket: ${connection.socketPath} — check file ownership/mode or socketPath setting`,
      command: "nimbus.openLogs",
      backgroundColor: COLOR_ERR,
    };
  }
  if (connection.kind === "disconnected") {
    if (autoStartGateway) {
      return {
        text: "Nimbus: $(sync~spin) starting Gateway…",
        tooltip: `Spawning nimbus start; reconnecting to ${connection.socketPath}`,
        command: undefined,
        backgroundColor: undefined,
      };
    }
    return {
      text: "Nimbus: $(circle-slash) Gateway not running",
      tooltip: `Run "Nimbus: Start Gateway" or start manually with: nimbus start`,
      command: "nimbus.startGateway",
      backgroundColor: COLOR_WARN,
    };
  }
  if (connection.kind === "starting-gateway") {
    return {
      text: "Nimbus: $(sync~spin) starting Gateway…",
      tooltip: "Spawning nimbus start; waiting for socket",
      command: undefined,
      backgroundColor: undefined,
    };
  }
  return undefined;
}

function formatDegradedSummary(count: number, names: readonly string[]): string {
  if (count === 0) return "0 connectors degraded";
  if (names.length > 0) return `${count} degraded: ${names.join(", ")}`;
  return `${count} connectors degraded`;
}

function formatConnected(inp: StatusBarInputs): StatusBarRender {
  const { profile, degradedConnectorCount, degradedConnectorNames, pendingHitlCount } = inp;
  const tags: string[] = [];
  if (degradedConnectorCount > 0) tags.push(`${degradedConnectorCount} degraded`);
  if (pendingHitlCount > 0) tags.push(`${pendingHitlCount} pending`);
  let icon = "$(circle-large-filled)";
  let bg: { id: string } | undefined;
  if (pendingHitlCount > 0) {
    icon = "$(bell-dot)";
    bg = COLOR_WARN;
  } else if (degradedConnectorCount > 0) {
    icon = "$(warning)";
    bg = COLOR_WARN;
  }
  const profileSegment = profile.length > 0 ? profile : "default";
  const tagSegment = tags.length > 0 ? ` · ${tags.join(" · ")}` : "";
  const text = `Nimbus: ${icon} ${profileSegment}${tagSegment}`;

  const degradedSummary = formatDegradedSummary(degradedConnectorCount, degradedConnectorNames);
  if (pendingHitlCount > 0) {
    const extra = degradedConnectorCount > 0 ? ` · ${degradedSummary}` : "";
    return {
      text,
      tooltip: `${pendingHitlCount} consent request(s) waiting${extra}`,
      command: "nimbus.showPendingHitl",
      backgroundColor: bg,
    };
  }
  return {
    text,
    tooltip: `Connected · profile=${profileSegment} · ${degradedSummary}`,
    command: "nimbus.ask",
    backgroundColor: bg,
  };
}

export function formatStatusBar(inp: StatusBarInputs): StatusBarRender {
  if (inp.connection.kind !== "connected") {
    const r = formatNonConnected(inp.connection, inp.autoStartGateway);
    if (r !== undefined) return r;
  }
  return formatConnected(inp);
}

export interface StatusBarController {
  update(inp: StatusBarInputs): void;
  dispose(): void;
}

export function createStatusBarController(item: StatusBarItemHandle): StatusBarController {
  item.show();
  return {
    update(inp): void {
      const r = formatStatusBar(inp);
      item.text = r.text;
      item.tooltip = r.tooltip;
      item.command = r.command;
      item.backgroundColor = r.backgroundColor;
    },
    dispose(): void {
      item.dispose();
    },
  };
}
