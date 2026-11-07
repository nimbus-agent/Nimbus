// packages/gateway/src/connectors/connector-writes/preview-credential.ts
// The ONE builder of the typed preview's credential/instance resolver, shared by the model door,
// the ChatOps executor and the MCP act door. DISPLAY ONLY: nothing here decides whether a write
// needs approval (I3) or which credential it uses (that is `credentialFor`'s own call).
import type { PreviewCredentialResolver } from "./types.ts";

/**
 * `Credential:` is read from the same per-connector pin the write itself uses. `Instance:` is the
 * GitHub Enterprise Server host the GitHub child was spawned with (the mesh's snapshot, never a
 * fresh Vault read), and only for `github`: no other service gets an instance from this resolver.
 */
export function previewCredentialResolver(
  deps: {
    readonly credentialFor: (service: string) => { readonly credential: "personal" | "team" };
  },
  mesh: { readonly githubInstance: () => string | undefined },
): PreviewCredentialResolver {
  return (service) => {
    const { credential } = deps.credentialFor(service);
    if (service !== "github") return credential;
    const instance = mesh.githubInstance();
    return instance === undefined ? credential : { credential, instance };
  };
}
