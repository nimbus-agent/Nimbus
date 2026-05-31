import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerCloudwatchTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-cloudwatch", (reg) => {
  registerCloudwatchTools(reg);
});
