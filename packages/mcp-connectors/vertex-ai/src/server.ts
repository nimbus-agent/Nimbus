import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerVertexAiTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-vertex-ai", (reg) => {
  registerVertexAiTools(reg);
});
