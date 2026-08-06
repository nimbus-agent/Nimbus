import { FLUX_KINDS, type FluxKindEntry, trimTrailingSlash } from "@nimbus-dev/sdk";
import { z } from "zod";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
import { filterFluxResources } from "./search-filter.ts";

const KIND_VALUES = FLUX_KINDS.map((e) => e.kind) as [string, ...string[]];

function kindEntry(kind: string): FluxKindEntry {
  const found = FLUX_KINDS.find((e) => e.kind === kind);
  if (found === undefined) {
    throw new Error(`Unknown Flux kind: ${kind}`);
  }
  return found;
}

function apiBase(): string {
  const v = process.env["FLUX_API_URL"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("FLUX_API_URL is not set");
  }
  return trimTrailingSlash(v);
}

function authHeader(): Record<string, string> {
  const t = process.env["FLUX_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("FLUX_TOKEN is not set");
  }
  return { Authorization: `Bearer ${t}`, Accept: "application/json" };
}

async function agGet(path: string): Promise<unknown> {
  const res = await fetchWithTimeout(`${apiBase()}${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Flux ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function itemsFrom(root: unknown): unknown[] {
  if (Array.isArray(root)) {
    return root;
  }
  const items = (root as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

function listPath(entry: FluxKindEntry, namespace?: string): string {
  const prefix = `/apis/${entry.group}/${entry.version}`;
  if (namespace !== undefined && namespace !== "") {
    return `${prefix}/namespaces/${encodeURIComponent(namespace)}/${entry.plural}`;
  }
  return `${prefix}/${entry.plural}`;
}

/** Request a reconcile by annotating reconcile.fluxcd.io/requestedAt on the CR (the same mechanism
 *  `flux reconcile` uses). Returns the RFC3339 timestamp written. Reuses kindEntry/listPath so the
 *  write path shares the read path's single source of truth — no new kind strings or version drift. */
async function fluxReconcile(kind: string, namespace: string, name: string): Promise<string> {
  const entry = kindEntry(kind);
  const path = `${listPath(entry, namespace)}/${encodeURIComponent(name)}`;
  const requestedAt = new Date().toISOString();
  const res = await fetchWithTimeout(`${apiBase()}${path}`, {
    method: "PATCH",
    headers: { ...authHeader(), "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({
      metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": requestedAt } },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Flux reconcile ${path} ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return requestedAt;
}

export function registerFluxTools(reg: ZodToolRegistrar): void {
  reg(
    "flux_list",
    "List Flux Custom Resources of one `kind` (default `kustomization`). Reads the Kubernetes API: all-namespaces by default, or scoped to `namespace` when given. `limit` (default 200) caps the returned `items` client-side. Returns the raw Kubernetes List envelope.",
    z.object({
      kind: z.enum(KIND_VALUES).optional(),
      namespace: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const entry = kindEntry(p.kind ?? "kustomization");
      const root = await agGet(listPath(entry, p.namespace));
      const items = itemsFrom(root);
      const cap = p.limit ?? 200;
      return jsonResult({ items: items.slice(0, cap) });
    },
  );

  reg(
    "flux_get",
    "Fetch one Flux Custom Resource by `kind`, `namespace`, and `name` (`/apis/<group>/<version>/namespaces/<ns>/<plural>/<name>`). Throws when no such resource exists.",
    z.object({
      kind: z.enum(KIND_VALUES),
      namespace: z.string().min(1),
      name: z.string().min(1),
    }),
    async (p) => {
      const entry = kindEntry(p.kind);
      const path = `${listPath(entry, p.namespace)}/${encodeURIComponent(p.name)}`;
      return jsonResult(await agGet(path));
    },
  );

  reg(
    "flux_search",
    "Substring search across Flux Custom Resources of one `kind` (default `kustomization`). Lists the kind across all namespaces and matches the query (case-insensitive) against resource name, namespace, and the Ready condition's reason/message. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      kind: z.enum(KIND_VALUES).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const entry = kindEntry(p.kind ?? "kustomization");
      const root = await agGet(listPath(entry));
      const matches = filterFluxResources(itemsFrom(root), {
        query: p.query,
        limit: p.limit,
      });
      return jsonResult({ matches });
    },
  );

  reg(
    "flux_kustomization_reconcile",
    "Request a reconcile of a Flux Kustomization by annotating reconcile.fluxcd.io/requestedAt (PATCH the CR; requires HITL flux.kustomization.reconcile, and the SA's `patch` RBAC verb on kustomizations). Async — verify via the next metadata sync.",
    z.object({ namespace: z.string().min(1), name: z.string().min(1) }),
    async (p) =>
      jsonResult({
        status: "requested",
        name: p.name,
        requestedAt: await fluxReconcile("kustomization", p.namespace, p.name),
      }),
  );

  reg(
    "flux_helmrelease_reconcile",
    "Request a reconcile of a Flux HelmRelease by annotating reconcile.fluxcd.io/requestedAt (PATCH the CR; requires HITL flux.helmrelease.reconcile, and the SA's `patch` RBAC verb on helmreleases). Async — verify via the next metadata sync.",
    z.object({ namespace: z.string().min(1), name: z.string().min(1) }),
    async (p) =>
      jsonResult({
        status: "requested",
        name: p.name,
        requestedAt: await fluxReconcile("helm_release", p.namespace, p.name),
      }),
  );
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-flux", registerFluxTools);
}

if (import.meta.main) await startConnector();
