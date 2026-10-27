/**
 * The README `nimbus trust maintain init --github` writes into the Nimbus trust-feed repository, and
 * the owner's next steps it prints once.
 */
import { bashQuote, pwshQuote } from "../../lib/shell-quote.ts";
import { TRUST_ROOT_KEY_SECRET, TRUST_SIGNING_ENVIRONMENT } from "./workflows.ts";

export function trustReadme(defaultBranch: string): string {
  return `# Nimbus trust feed

This repository is the Nimbus trust feed's source. Every Nimbus install fetches the signed
\`trust.json\` it produces (from the \`gh-pages\` branch) and applies it: key revocations and
extension takedowns block extensions everywhere, and verified publishers get their badge.

\`${defaultBranch}\` holds the SOURCE, never a signed document:

- \`publishers/<publisherId>.json\` — one per verified publisher: \`{ "publisherId", "keys", "github" }\`.
  This is the feed's current verification state. Removing the file un-verifies the publisher.
- \`requests/<name>.json\` — a block signed with the Nimbus trust root: \`key.revoke\` or
  \`extension.takedown\` (which must name \`publisherId\`). A block is permanent: deleting the
  file later removes nothing.
- \`statements/<statement id>.json\` — a verified publisher's own signed rotation or revocation.

Write them with the CLI, then open a pull request:

\`\`\`bash
nimbus trust maintain verify-publisher . <publisherId> --key <public key file|base64> --github <handle>
nimbus trust maintain unverify-publisher . <publisherId>
nimbus trust maintain revoke-key . <fingerprint> --publisher <id> --reason <text>
nimbus trust maintain takedown . <id>[@<version>] --publisher <id> --reason <text>
nimbus trust maintain add-statement . <statement file>
nimbus trust maintain plan .
\`\`\`

\`verify-publisher\` records that you checked the publisher's GitHub identity; it does not check it.

The **Trust feed check** workflow summarises what the merged result would sign. It is a reviewer aid,
not a guarantee: a pull request may only change \`publishers/\`, \`requests/\` and \`statements/\`,
and one that edits a workflow fails the check — but it could also edit the check itself. The
boundary is merging into \`${defaultBranch}\` and the **Trust feed sign** workflow's required
approval: whoever can do both decides what every Nimbus install trusts.
`;
}

const REPO_PLACEHOLDER = "<owner>/<repo>";

export function trustOwnerNextSteps(opts: {
  dir: string;
  site: string;
  keyPath: string;
  defaultBranch: string;
}): string {
  const secret = `${TRUST_ROOT_KEY_SECRET} --env ${TRUST_SIGNING_ENVIRONMENT} --repo ${REPO_PLACEHOLDER}`;
  return `Next steps (nothing has been pushed; replace ${REPO_PLACEHOLDER} with the trust-feed repository):
  1. Make sure the repository is public: clients fetch trust.json from GitHub Pages.
  2. Push ${opts.site} as the gh-pages branch.
  3. Create the environment "${TRUST_SIGNING_ENVIRONMENT}" with required reviewers, and set its
     deployment branches to ${opts.defaultBranch} only.
  4. Store the trust root key as a secret of THAT environment:
       bash/zsh:    gh secret set ${secret} < ${bashQuote(opts.keyPath)}
       PowerShell:  Get-Content -Raw ${pwshQuote(opts.keyPath)} | gh secret set ${secret}
  5. Set GitHub Pages to serve the gh-pages branch.
  6. Protect gh-pages against force-push and deletion (no required reviews or checks, so the
     sign workflow's push still lands).
  7. Only now push ${opts.dir} to the ${opts.defaultBranch} branch.
  8. Protect ${opts.defaultBranch}: require pull requests, and set it as the default branch.
  9. Hand the Pages URL (with its trailing slash) and the root public key above to the Nimbus
     release that bakes the feed (trust layer PR 5).
Keep the key file offline and backed up: it signs what every Nimbus install trusts. On Windows the
CLI sets no ACL on it; keep it under your user profile, never on a shared or synced path.
`;
}
