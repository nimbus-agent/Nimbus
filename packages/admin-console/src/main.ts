// Admin console entry point: bearer-token bootstrap + sidebar routing + DOM mount.
//
// innerHTML is used to mount view output. This is XSS-safe ONLY because every
// dynamic value in render.ts/views.ts is passed through esc(). Never interpolate
// a raw user/server string into the DOM outside those pure view functions.
import type { AdminClient } from "./client.ts";
import { makeClient } from "./client.ts";
import type { GatewayStatus } from "./render.ts";
import { renderOverview } from "./render.ts";
import {
  renderAudit,
  renderConnectors,
  renderNamespaces,
  renderPolicy,
  renderUsers,
} from "./views.ts";

type Route = "overview" | "connectors" | "audit" | "policy" | "users" | "namespaces";

const ROUTES: { id: Route; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "connectors", label: "Connectors" },
  { id: "audit", label: "Audit" },
  { id: "policy", label: "Policy" },
  { id: "users", label: "Users" },
  { id: "namespaces", label: "Namespaces" },
];

/** Read the bearer token from the URL fragment (#token=…). The fragment is never
 * sent to the server. Returns null if absent. */
function tokenFromHash(): string | null {
  const hash = location.hash.replace(/^#/, "");
  for (const part of hash.split("&")) {
    const [k, v] = part.split("=");
    if (k === "token" && v !== undefined && v.length > 0) {
      return decodeURIComponent(v);
    }
  }
  return null;
}

function renderView(route: Route, status: GatewayStatus, isAnchor: boolean): string {
  switch (route) {
    case "overview":
      return renderOverview(status);
    case "connectors":
      return renderConnectors(status.connectors);
    case "audit":
      return renderAudit(status.audit);
    case "policy":
      return renderPolicy(status, { isAnchor });
    case "users":
      return renderUsers(status.identity);
    case "namespaces":
      return renderNamespaces(status.namespaces);
  }
}

function wirePolicySave(client: AdminClient): void {
  const btn = document.getElementById("policy-save");
  const editor = document.getElementById("policy-editor");
  const out = document.getElementById("policy-save-status");
  if (btn === null || !(editor instanceof HTMLTextAreaElement)) {
    return;
  }
  btn.addEventListener("click", () => {
    void (async () => {
      try {
        const res = await client.savePolicy(editor.value);
        if (out !== null) {
          out.textContent = res.ok ? "Policy saved." : `Save failed (HTTP ${res.status}).`;
        }
      } catch (err) {
        if (out !== null) {
          out.textContent = `Save error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    })();
  });
}

function buildSidebar(onNavigate: (route: Route) => void): void {
  const list = document.querySelector(".sidebar ul");
  if (list === null) {
    return;
  }
  list.replaceChildren();
  for (const r of ROUTES) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${r.id}`;
    a.textContent = r.label;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onNavigate(r.id);
    });
    li.appendChild(a);
    list.appendChild(li);
  }
}

function showTokenPrompt(app: HTMLElement, onToken: (token: string) => void): void {
  app.replaceChildren();
  const p = document.createElement("p");
  p.textContent = "Paste an admin bearer token to continue:";
  const input = document.createElement("input");
  input.id = "token-input";
  input.type = "password";
  const btn = document.createElement("button");
  btn.textContent = "Connect";
  btn.addEventListener("click", () => {
    if (input.value.length > 0) {
      onToken(input.value);
    }
  });
  app.append(p, input, btn);
}

function start(token: string): void {
  const app = document.getElementById("app");
  if (app === null) {
    return;
  }
  const client = makeClient(token);
  // Default to showing the policy editor; the PUT endpoint enforces authority.
  const isAnchor = true;
  let current: Route = "overview";
  let latest: GatewayStatus | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function paint(): void {
    if (app === null || latest === null) {
      return;
    }
    app.innerHTML = renderView(current, latest, isAnchor);
    if (current === "policy") {
      wirePolicySave(client);
    }
  }

  async function refresh(): Promise<void> {
    try {
      latest = await client.status();
      paint();
    } catch (err) {
      if (app !== null && latest === null) {
        app.textContent = `Failed to load status: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    }
  }

  function navigate(route: Route): void {
    current = route;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (route === "overview") {
      pollTimer = setInterval(() => void refresh(), 5000);
    }
    paint();
  }

  buildSidebar(navigate);
  void refresh().then(() => navigate("overview"));
}

function bootstrap(): void {
  const app = document.getElementById("app");
  if (app === null) {
    return;
  }
  const token = tokenFromHash();
  if (token !== null) {
    start(token);
    return;
  }
  showTokenPrompt(app, (t) => start(t));
}

bootstrap();
