import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerLocaldbTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-localdb", (reg) => {
  registerLocaldbTools(reg);
});
