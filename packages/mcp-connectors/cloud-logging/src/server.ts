import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerCloudLoggingTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-cloud-logging", (reg) => {
  registerCloudLoggingTools(reg);
});
