import { runConnectorAuth } from "./connector/auth.ts";
import { printConnectorHelp } from "./connector/help.ts";
import {
  runConnectorHistory,
  runConnectorLifecycle,
  runConnectorList,
  runConnectorSetInterval,
  runConnectorSync,
} from "./connector/list.ts";
import { runConnectorReindex, runConnectorRemove } from "./connector/remove.ts";
import { ADD_MCP_USAGE } from "./connector-add-mcp-args.ts";
import { runConnectorDetect } from "./connector-detect.ts";
import { runConnectorMigrate } from "./connector-migrate.ts";
import { runConnectorAddMcp, runConnectorCall, runConnectorTools } from "./connector-user-mcp.ts";
import { runConnectorWrites } from "./connector-writes-cli.ts";

export async function runConnector(args: string[]): Promise<void> {
  const sub = args[0];
  const tail = args.slice(1);

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printConnectorHelp();
    return;
  }

  switch (sub) {
    case "auth":
      await runConnectorAuth(tail);
      return;
    case "detect":
      await runConnectorDetect(tail);
      return;
    case "add": {
      const mode = tail[0]?.trim() ?? "";
      if (mode === "--mcp") {
        await runConnectorAddMcp(tail.slice(1));
        return;
      }
      throw new Error(ADD_MCP_USAGE);
    }
    case "tools":
      await runConnectorTools(tail);
      return;
    case "call":
      await runConnectorCall(tail);
      return;
    case "list":
      await runConnectorList({ json: tail.includes("--json") });
      return;
    case "history":
      await runConnectorHistory(tail);
      return;
    case "pause":
    case "resume":
    case "status":
      await runConnectorLifecycle(sub, tail);
      return;
    case "set-interval":
      await runConnectorSetInterval(tail);
      return;
    case "sync":
      await runConnectorSync(tail);
      return;
    case "remove":
      await runConnectorRemove(tail);
      return;
    case "reindex":
      await runConnectorReindex(tail);
      return;
    case "migrate":
      await runConnectorMigrate(tail);
      return;
    case "writes":
      await runConnectorWrites(tail);
      return;
    default:
      throw new Error(`Unknown connector subcommand: ${sub}. Try: nimbus connector help`);
  }
}
