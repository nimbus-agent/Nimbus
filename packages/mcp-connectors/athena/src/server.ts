import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerAthenaTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-athena", (reg) => {
  registerAthenaTools(reg);
});
