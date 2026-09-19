import { randomInt } from "node:crypto";
import net from "node:net";

// Below every OS's ephemeral range (Linux 32768–60999; macOS and Windows 49152–65535), and above
// the ports a CI runner's own services use.
const SENTINEL_LOW = 20_000;
const SENTINEL_HIGH = 30_000;
const ATTEMPTS = 50;

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/**
 * A loopback port for a "nothing ever listens here" assertion: free when picked, and OUTSIDE the
 * ephemeral range, so it stays free unless the code under test binds it.
 *
 * The obvious picker — `listen(0)`, read the port, close — returns an EPHEMERAL port, and the
 * kernel hands those to every later `listen(0)`. These suites run in ONE process with the whole
 * repo (`bun test packages/gateway packages/cli scripts`), where dozens of tests bind port 0
 * during the minutes between the pick and the assertion. One of them landing on the released
 * number turned "the demo gateway started no HTTP sidecar" red on a release PR with no sidecar
 * anywhere. No `listen(0)` can return a port from this range.
 */
export async function pickSentinelPort(): Promise<number> {
  for (let i = 0; i < ATTEMPTS; i++) {
    const port = randomInt(SENTINEL_LOW, SENTINEL_HIGH);
    if (await canBind(port)) return port;
  }
  throw new Error(
    `no free loopback port in [${String(SENTINEL_LOW)}, ${String(SENTINEL_HIGH)}) after ${String(ATTEMPTS)} attempts`,
  );
}

export const SENTINEL_PORT_RANGE = { low: SENTINEL_LOW, high: SENTINEL_HIGH } as const;
