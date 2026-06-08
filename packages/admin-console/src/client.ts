import type { GatewayStatus } from "./render.ts";

export interface AdminClient {
  status: () => Promise<GatewayStatus>;
  savePolicy: (toml: string) => Promise<Response>;
}

export function makeClient(token: string): AdminClient {
  const h: Record<string, string> = { authorization: `Bearer ${token}` };
  return {
    status: async () => {
      const res = await fetch("/v1/admin/status", { headers: h });
      if (!res.ok) {
        throw new Error(`Status request failed (HTTP ${res.status})`);
      }
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null || !("data" in body)) {
        throw new Error("Invalid status response shape");
      }
      return (body as { data: GatewayStatus }).data;
    },
    savePolicy: (toml: string) =>
      fetch("/v1/admin/policy", {
        method: "PUT",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ toml }),
      }),
  };
}
