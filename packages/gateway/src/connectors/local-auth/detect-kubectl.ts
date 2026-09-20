import { join } from "node:path";

import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import type { KubectlFinding } from "./local-auth-types.ts";

export function kubeconfigValue(deps: LocalAuthHostDeps): string {
  const v = deps.env["KUBECONFIG"];
  return v !== undefined && v.trim() !== "" ? v.trim() : join(deps.homeDir, ".kube", "config");
}

/** For existence checks and display ONLY; the stored value stays verbatim. */
export function kubeconfigPaths(value: string, platform: NodeJS.Platform): string[] {
  return value
    .split(platform === "win32" ? ";" : ":")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export async function detectKubectl(
  deps: LocalAuthHostDeps,
  alreadyConfigured: boolean,
): Promise<KubectlFinding> {
  const kubeconfig = kubeconfigValue(deps);
  const base = { source: "kubectl" as const, kubeconfig, alreadyConfigured };
  const none = { contexts: [] as readonly string[], currentContext: null };
  if (!deps.which("kubectl")) {
    return {
      ...base,
      ...none,
      status: "cli_not_found",
      reason: "kubectl is not installed (not found on PATH)",
    };
  }
  if (!kubeconfigPaths(kubeconfig, deps.platform).some((p) => deps.exists(p))) {
    return {
      ...base,
      ...none,
      status: "not_logged_in",
      reason: `no kubeconfig file at ${kubeconfig}`,
    };
  }
  const env = { KUBECONFIG: kubeconfig };
  const listed = await deps.run(["kubectl", "config", "get-contexts", "-o", "name"], env);
  const contexts = listed.ok
    ? listed.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : [];
  if (contexts.length === 0) {
    return {
      ...base,
      ...none,
      status: "not_logged_in",
      reason: "the kubeconfig defines no contexts",
    };
  }
  const cur = await deps.run(["kubectl", "config", "current-context"], env);
  const current = cur.ok ? cur.stdout.trim() : "";
  return {
    ...base,
    contexts,
    currentContext: contexts.includes(current) ? current : null,
    status: "available",
  };
}
