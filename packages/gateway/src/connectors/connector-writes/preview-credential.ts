// packages/gateway/src/connectors/connector-writes/preview-credential.ts
// The ONE builder of the typed preview's credential/instance resolver, shared by the model door,
// the ChatOps executor and the MCP act door. DISPLAY ONLY: nothing here decides whether a write
// needs approval (I3) or which credential it uses (that is `credentialFor`'s own call). The one
// decision it adds is a REFUSAL: a github credential whose stored base is present but invalid is
// refused (fail closed) instead of being shown with a line that does not describe where it would run.
import { createTeamVaultView } from "../../teamvault/team-vault-view.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { resolveGithubBase } from "../github-api-base.ts";
import type { PreviewCredentialResolver } from "./types.ts";

/** How long a refreshed instance is trusted by the sync resolver (a gate reads it right away). */
const FRESH_MS = 5_000;

/**
 * `Credential:` is read from the same per-connector pin the write itself uses. `Instance:` is the
 * GitHub Enterprise Server host of the credential that WILL RUN, and only for `github`:
 *
 * - the executor awaits `refresh("github")` before it builds the prompt, which reads `github.api_base`
 *   FRESH from the Vault the write will use (the owner's, or the pinned team entry's keyspace, the
 *   same view the spawn reads) and throws if it is present but invalid, so the write is refused
 *   before any prompt;
 * - a sync call with no fresh read (the MCP submit-time preview) falls back to the mesh's snapshot
 *   for a PERSONAL credential, and names no instance for a team one (never the owner's host).
 *
 * github.com shows no `Instance:` line for either credential.
 */
export function previewCredentialResolver(
  deps: {
    readonly credentialFor: (service: string) => {
      readonly credential: "personal" | "team";
      readonly teamEntry?: string | undefined;
    };
    readonly vault?: NimbusVault;
  },
  mesh: { readonly githubInstance: () => string | undefined },
): PreviewCredentialResolver {
  const fresh = new Map<string, { readonly instance: string | undefined; readonly at: number }>();
  const keyOf = (cfg: { credential: string; teamEntry?: string | undefined }): string =>
    cfg.credential === "team" ? `team:${cfg.teamEntry ?? ""}` : "personal";

  const resolver: PreviewCredentialResolver = (service) => {
    const cfg = deps.credentialFor(service);
    const { credential } = cfg;
    if (service !== "github") return credential;
    const hit = fresh.get(keyOf(cfg));
    let instance: string | undefined;
    if (hit !== undefined && Date.now() - hit.at < FRESH_MS) instance = hit.instance;
    else if (credential === "personal") instance = mesh.githubInstance();
    return instance === undefined ? credential : { credential, instance };
  };

  return Object.assign(resolver, {
    refresh: async (service: string): Promise<void> => {
      const vault = deps.vault;
      if (service !== "github" || vault === undefined) return;
      const cfg = deps.credentialFor(service);
      let view: NimbusVault = vault;
      if (cfg.credential === "team") {
        if (cfg.teamEntry === undefined || cfg.teamEntry === "") {
          throw new Error("the team credential names no team entry");
        }
        view = createTeamVaultView(vault, cfg.teamEntry);
      }
      const resolved = resolveGithubBase(await readConnectorSecret(view, "github", "api_base"));
      if (!resolved.ok) throw new Error("the stored GitHub Enterprise Server base is not valid");
      fresh.set(keyOf(cfg), { instance: resolved.host ?? undefined, at: Date.now() });
    },
  });
}
