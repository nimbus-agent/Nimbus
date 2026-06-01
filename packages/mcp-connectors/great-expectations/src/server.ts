import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerGreatExpectationsTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-great-expectations", (reg) => {
  registerGreatExpectationsTools(reg);
});
