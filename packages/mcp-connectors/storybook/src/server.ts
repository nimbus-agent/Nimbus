import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { registerStorybookTools } from "./tools.ts";

await runReadOnlyMcpConnector("nimbus-storybook", (reg) => {
  registerStorybookTools(reg);
});
