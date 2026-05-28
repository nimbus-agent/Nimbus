function getGlobalOrigin(): string {
  const g = globalThis as typeof globalThis & { origin?: unknown };
  return typeof g.origin === "string" ? g.origin : "";
}

export function isAcceptableWorkerOrigin(ev: MessageEvent): boolean {
  const o = ev.origin;
  if (o === "" || o === "null") {
    return true;
  }
  const selfO = getGlobalOrigin();
  if (selfO === "") {
    return true;
  }
  return o === selfO;
}
