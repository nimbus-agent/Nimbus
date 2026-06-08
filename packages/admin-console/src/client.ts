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
      const body = (await res.json()) as { data: GatewayStatus };
      return body.data;
    },
    savePolicy: (toml: string) =>
      fetch("/v1/admin/policy", {
        method: "PUT",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ toml }),
      }),
  };
}
