// Prints the exact shell block the `.deb` runs, so CI can run the real thing on a real kernel.
import {
  bwrapApparmorInstallShell,
  bwrapApparmorRemoveShell,
} from "../../packages/cli/src/commands/doctor-bwrap.ts";

const which = process.argv[2];
if (which === "install") {
  process.stdout.write(bwrapApparmorInstallShell(false));
} else if (which === "remove") {
  process.stdout.write(bwrapApparmorRemoveShell(false));
} else {
  console.error("usage: print-bwrap-apparmor-shell.ts install|remove");
  process.exit(2);
}
