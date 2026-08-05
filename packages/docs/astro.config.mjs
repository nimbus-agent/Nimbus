// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

// The site is published at https://nimbus-agent.dev/
// — base '/' serves from the apex of the custom domain.
export default defineConfig({
  site: "https://nimbus-agent.dev",
  base: "/",
  integrations: [
    starlight({
      title: "Nimbus",
      plugins: [starlightLinksValidator()],
      sidebar: [
        {
          label: "User Guide",
          items: [
            { label: "What is Nimbus", link: "/" },
            { label: "Install", link: "/user-guide/install/" },
            { label: "Verify your download", link: "/user-guide/verify-your-download/" },
            { label: "First-run setup", link: "/user-guide/first-run-setup/" },
            { label: "Connect your first service", link: "/user-guide/connect-your-first-service/" },
            { label: "Your first query", link: "/user-guide/your-first-query/" },
            { label: "HITL & safety", link: "/user-guide/hitl-and-safety/" },
            { label: "Watchers", link: "/user-guide/watchers/" },
            { label: "Workflows", link: "/user-guide/workflows/" },
            { label: "Built-in agents", link: "/user-guide/agents/" },
            { label: "Profiles", link: "/user-guide/profiles/" },
            { label: "Voice", link: "/user-guide/voice/" },
            { label: "VS Code extension", link: "/user-guide/vscode-extension/" },
            { label: "Web clipper", link: "/user-guide/web-clipper/" },
            { label: "Connectors", link: "/user-guide/connectors/" },
            { label: "Troubleshooting", link: "/user-guide/troubleshooting/" },
            { label: "FAQ", link: "/faq/" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Run from source", link: "/getting-started/" },
            { label: "Query & HTTP", link: "/query-and-http/" },
            { label: "Monitoring", link: "/monitoring/" },
            { label: "Telemetry", link: "/telemetry/" },
            { label: "Performance benchmarks", link: "/perf/" },
            {
              label: "Connectors (per-service)",
              items: [{ autogenerate: { directory: "connectors" } }],
            },
          ],
        },
        {
          label: "Developer",
          items: [
            { label: "Architecture overview", link: "/architecture-overview/" },
            { label: "Client library", link: "/client-library/" },
          ],
        },
      ],
    }),
  ],
});
