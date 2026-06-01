import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerElasticsearchTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-elasticsearch", (reg) => {
  registerElasticsearchTools(reg);
});
