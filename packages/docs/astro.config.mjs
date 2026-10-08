// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

// The site is published at https://nimbus-agent.dev/
// — base '/' serves from the apex of the custom domain.
export default defineConfig({
  site: "https://nimbus-agent.dev",
  base: "/",
  vite: {
    environments: {
      prerender: {
        resolve: {
          // Starlight is bundled into the prerender output but imports `js-yaml` as a DEFAULT
          // export (it declares ^4). Left external, that import is resolved at prerender time
          // from THIS package's location, which reaches the repo's hoisted js-yaml 5 — whose ESM
          // build has no default export ("does not provide an export named 'default'"). Bundling
          // it resolves js-yaml relative to each importer instead, so Starlight gets the 4.x it
          // declares. Astro does the same for its own `neotraverse` (withastro/astro#17508).
          noExternal: ["js-yaml"],
        },
      },
    },
  },
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
            { label: "VS Code extension", link: "/user-guide/vscode-extension/" },
            { label: "Nimbus Companion", link: "/user-guide/web-clipper/" },
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
