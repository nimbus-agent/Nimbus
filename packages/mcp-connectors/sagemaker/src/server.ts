import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerSagemakerTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-sagemaker", (reg) => {
  registerSagemakerTools(reg);
});
