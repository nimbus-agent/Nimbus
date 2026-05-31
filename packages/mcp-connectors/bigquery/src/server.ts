import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerBigqueryTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-bigquery", (reg) => {
  registerBigqueryTools(reg);
});
