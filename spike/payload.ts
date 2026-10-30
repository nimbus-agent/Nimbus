// THROWAWAY. The extension's view inside the sandbox.
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";

const status = readFileSync("/proc/self/status", "utf8");
for (const k of ["Uid", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs", "Seccomp"]) {
  console.log(status.split("\n").find((l) => l.startsWith(`${k}:`)));
}
const bind = (ip: string, port: number): Promise<string> =>
  new Promise((res) => {
    const s = createServer();
    s.on("error", (e: Error) => res(`refused: ${e.message}`));
    s.listen(port, ip, () => { s.close(); res("BOUND"); });
  });
const tcp = (host: string, port: number): Promise<string> =>
  new Promise((res) => {
    const s = connect({ host, port });
    const t = setTimeout(() => { s.destroy(); res("timeout"); }, 4000);
    s.on("connect", () => { clearTimeout(t); s.destroy(); res("CONNECTED"); });
    s.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(t); res(`refused: ${e.code}`); });
  });
const get = (u: string): Promise<string> =>
  fetch(u, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "nimbus-spike" } }).then(
    (r) => `status ${r.status}`,
    (e: unknown) => `refused: ${String(e).slice(0, 70)}`,
  );
console.log("bind 127.0.0.9:443        ", await bind("127.0.0.9", 443));
console.log("fetch declared (real TLS) ", await get("https://api.github.com/zen"));
console.log("fetch undeclared          ", await get("https://www.example.com/"));
console.log("tcp declared, wrong port  ", await tcp("api.github.com", 80));
console.log("tcp direct IP             ", await tcp("1.1.1.1", 443));
const sock = process.env["SPIKE_SOCK"] as string;
console.log("forward socket visible    ", existsSync(sock));
process.exit(0);
