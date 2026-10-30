// THROWAWAY. Outside the sandbox: forward each connection to the one allowed host.
import { connect, createServer } from "node:net";

createServer((c) => {
  console.log("TARGET: connection, forwarding to api.github.com:443");
  const up = connect({ host: "api.github.com", port: 443 });
  c.pipe(up).pipe(c);
  c.on("error", () => up.destroy());
  up.on("error", () => c.destroy());
}).listen(process.argv[2]);
