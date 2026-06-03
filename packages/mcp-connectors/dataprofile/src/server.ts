import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerDataprofileTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-dataprofile", (reg) => {
  registerDataprofileTools(reg);
});
