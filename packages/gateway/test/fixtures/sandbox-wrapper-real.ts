/**
 * The real `runSandboxWrapper` with its production dependencies: the platform's own runner, its own
 * connection source and the OS resolver. `argv[2..]` is the command, as after the
 * `__nimbus-sandbox` sentinel. For `observe/wrapper-observation-os.test.ts`, which runs it on a real
 * Windows or macOS sandbox without compiling the gateway.
 *
 * Test-only: production reaches `runSandboxWrapper` through the gateway executable's sentinel role.
 */
import { runSandboxWrapper } from "../../src/platform/sandbox/sandbox-wrapper.ts";

await runSandboxWrapper(process.argv.slice(2));
