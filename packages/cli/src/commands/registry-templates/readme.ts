/**
 * The README `nimbus registry maintain init --github` writes into a registry repository, and the
 * owner's next steps it prints once (design § 7.5, § 7.6).
 */
import { bashQuote, pwshQuote } from "../../lib/shell-quote.ts";
import { ROOT_KEY_SECRET, SIGNING_ENVIRONMENT } from "./workflows.ts";

export function registryReadme(opts: {
  requirePublisherNamespace: boolean;
  defaultBranch: string;
}): string {
  const main = opts.defaultBranch;
  const namespace = opts.requirePublisherNamespace
    ? "Extension ids must be `<publisher>/<name>`, and `<publisher>` must equal the manifest's `publisher.id`.\n\n"
    : "";
  return `# Nimbus extension registry

This repository is a signed Nimbus extension registry. \`${main}\` holds the sources: one
\`extensions/<id>/<version>/\` directory per published version (\`manifest.json\`,
\`package.tgz\`, \`publish-request.json\`), the registry rules in \`nimbus-registry.json\`, and the
two workflows. It never holds a signed \`index.json\`. The published site (the signed
\`index.json\` and the files it references) lives on the \`gh-pages\` branch, written only by the
sign workflow.

The repository must stay **public**: the check workflow fetches \`gh-pages\` and the base
branch without credentials, and GitHub Pages serves the site to every client.

## Publishing an extension

Build and sign your extension, then open a publish pull request:

\`\`\`bash
nimbus extension publish <extension-dir> --registry-repo <owner>/<repo>
\`\`\`

A publish pull request may only ADD the three files of exactly one new \`<id>@<version>\`.
${namespace}The **Registry check** workflow validates it against the signed index and writes a summary for the
reviewer. A green check is a reviewer aid, not a guarantee: a pull request can edit the check
workflow itself, and no runtime check of the package is performed.

## Approving a signing run

After a merge to \`${main}\`, the **Registry sign** workflow waits for approval in the
\`${SIGNING_ENVIRONMENT}\` environment. Before approving, open that run and check:

- the workflow file it runs is the one you expect (\`.github/workflows/registry-sign.yml\`
  unchanged, or changed only as you reviewed); the approval is what stops a changed workflow
  from using the root key;
- the versions it will add are the ones that were reviewed and merged.

The run re-validates every unsigned version, skips (and names) any that fail, signs the rest at
the next sequence number and pushes the site to \`gh-pages\`. A version that is already signed
must not change on \`${main}\`; a run that finds one changed refuses to sign anything.
`;
}

const REPO_PLACEHOLDER = "<owner>/<repo>";

export function ownerNextSteps(opts: {
  dir: string;
  site: string;
  keyPath: string;
  defaultBranch: string;
}): string {
  const secret = `${ROOT_KEY_SECRET} --env ${SIGNING_ENVIRONMENT} --repo ${REPO_PLACEHOLDER}`;
  return `Next steps (nothing has been pushed; replace ${REPO_PLACEHOLDER} with the registry repository):
  1. Make sure the repository is public: the check workflow fetches without credentials.
  2. Push ${opts.site} as the gh-pages branch.
  3. Create the environment "${SIGNING_ENVIRONMENT}" with required reviewers, and set its
     deployment branches to ${opts.defaultBranch} only (Deployment branches and tags: Selected
     branches), so a by-hand run from another branch, with its own copy of the sign workflow,
     cannot reach the root key.
  4. Store the root key as a secret of THAT environment (--env matters: a repository-level
     secret is not gated by the environment's required reviewers):
       bash/zsh:    gh secret set ${secret} < ${bashQuote(opts.keyPath)}
       PowerShell:  Get-Content -Raw ${pwshQuote(opts.keyPath)} | gh secret set ${secret}
  5. Set GitHub Pages to serve the gh-pages branch.
  6. Protect gh-pages against force-push and deletion, without requiring pull requests,
     reviews or status checks, so the sign workflow's GITHUB_TOKEN push still lands.
     Without this, anyone with write access can force-push gh-pages back to an older signed
     index, and the next signing run then publishes a different index at a sequence number
     that was already used. The sign workflow does not check this setting; it is yours to keep.
  7. Only now push ${opts.dir} to the repository's ${opts.defaultBranch} branch. The push starts
     the first sign run, which needs the environment and its secret: pushed earlier, that run
     fails and GitHub creates "${SIGNING_ENVIRONMENT}" itself, with no required reviewers.
  8. Protect ${opts.defaultBranch}: require pull requests. If the repository was empty, step 2 made
     gh-pages its default branch: set the default branch to ${opts.defaultBranch} (Settings, General)
     so pull requests and forks target it.
On Windows the CLI sets no ACL on the key file: it inherits its folder's permissions. Keep it
under your user profile (the default ~/.nimbus/registry-key), never on a shared or synced path.
`;
}
