/**
 * The `federation.*` methods a gateway SERVES: every key of the handler map in `ipc/federation-rpc.ts`,
 * plus the ones `federation/federation-server.ts` answers before the map (`method === "federation.x"`,
 * today `federation.freeBusy`, I17 (b)). `audit:status-drift` derives the LAN-admitted set from this.
 */
export function servedFederationMethods(handlerMapSource: string, serverSource: string): string[] {
  const keys = [...handlerMapSource.matchAll(/^\s*"(federation\.[A-Za-z]+)"\s*:/gm)];
  const direct = [...serverSource.matchAll(/method === "(federation\.[A-Za-z]+)"/g)];
  return [...new Set([...keys, ...direct].map((m) => m[1] as string))];
}
