# Hosting an extension registry

A Nimbus extension registry is a folder of signed static files (see [architecture.md](./architecture.md#extension-marketplace--tauri-ui)). This page covers the one hosting shape Nimbus automates: a **public GitHub repository** whose CI validates publish pull requests and signs the index. The first registry, `nimbus-agent/extensions`, is the worked example. For offline or self-hosted registries, `nimbus registry maintain init|add|remove` in [cli-reference.md](./cli-reference.md#nimbus-registry-maintain-initaddremove) is all you need.

## What you get

- `main` holds sources: `extensions/<id>/<version>/{manifest.json,package.tgz,publish-request.json}`, publishers' signed key statements under `statements/<statement id>.json` (a `key.rotate` or `key.revoke` sent with `nimbus extension publish --statement`; the sign run admits them into the index, and one never leaves it once signed), maintainers' block requests under `trust-requests/<name>.json` (an unsigned `key.revoke` or `extension.takedown` written by `nimbus registry maintain revoke-key|takedown --github <clone>`; the sign run signs it with the root key, once), the rules in `nimbus-registry.json`, and two workflows. It never holds a signed `index.json`. The first sign run also sets the index's `reportUrl` to this repository's issue form, where `nimbus extension report` sends users.
- `gh-pages` holds the published site: the signed `index.json` and the files it references. Only the sign workflow writes it.
- **Registry check** runs on every pull request to `main` with a read-only token and no secrets, and scores the new version's eval suites (see [Eval scores](#eval-scores)). It is a reviewer aid.
- **Registry sign** runs after a merge (or by hand): a `score` job with no secrets runs the unsigned versions' eval suites, then the `sign` job runs behind the `registry-signing` environment's required reviewers, with the root key. It is the security boundary.

## Owner steps

Step 1 prints these steps (numbered there from "Make sure the repository is public") with your folder and key paths filled in; replace `<owner>/<repo>` in them with your repository. Below, `nimbus-agent/extensions` is the example.

1. **Scaffold.** `nimbus registry maintain init ./extensions --github`. This writes the repository folder, a sibling `./extensions-site` for `gh-pages`, and a root key at `~/.nimbus/registry-key`. The site folder holds the signed empty `index.json`, a copy of `nimbus-registry.json`, an empty `.nojekyll` (so GitHub Pages' Jekyll does not drop paths that start with `_` or `.`) and a `.gitattributes` of `* -text` (so git never rewrites the line endings of signed bytes); every sign run builds on the previous site tree and keeps both. It prints the key's fingerprint and the steps below with your paths filled in; it never prints the key. Nothing is pushed. The workflows reference the registry action pinned to the commit your CLI was built from; a development build needs `--action-ref <40-hex>`.
2. **Make the repository public.** The check job and the sign workflow's score job fetch `gh-pages` and `main` without credentials; in a private repository the score job fails, and a failed score job skips every sign run.
3. **Push the site.** Push `./extensions-site` as the `gh-pages` branch of `nimbus-agent/extensions`. Do not push `main` yet.
4. **Create the `registry-signing` environment** (Settings, Environments) and add **required reviewers**. Under **Deployment branches and tags**, choose **Selected branches** and allow only `main` (or your `--default-branch`). The sign workflow can also be started by hand (`workflow_dispatch`) from any branch, and that branch's own copy of the workflow would then be the one offered the key; the branch rule stops that run at the environment, without depending on the reviewer spotting a changed workflow.
5. **Store the root key as a secret of that environment.** The `--env` flag matters: a repository-level secret is not gated by the reviewers.

   ```bash
   gh secret set NIMBUS_REGISTRY_ROOT_KEY --env registry-signing --repo nimbus-agent/extensions < '/home/me/.nimbus/registry-key'
   ```

   ```powershell
   Get-Content -Raw 'C:\Users\me\.nimbus\registry-key' | gh secret set NIMBUS_REGISTRY_ROOT_KEY --env registry-signing --repo nimbus-agent/extensions
   ```

   On Windows the CLI sets no ACL on the key file; it inherits its folder's permissions. Keep it under your user profile and never on a shared or synced path.
6. **Serve `gh-pages` with GitHub Pages** (Settings, Pages, branch `gh-pages`). Clients add the registry at the Pages URL with `nimbus registry add`.
7. **Protect `gh-pages` against force-push and deletion**, without requiring pull requests, reviews or status checks, so the sign workflow's `GITHUB_TOKEN` push still lands.
8. **Only now push `main`.** Push `./extensions` as `main`. The push starts the first **Registry sign** run, which needs the environment and its secret: pushed before steps 4 and 5, that run fails, and GitHub creates `registry-signing` itself, with no required reviewers.
9. **Protect `main`:** require pull requests. If you used `--default-branch`, push and protect that branch instead; both workflows follow it. If the repository was empty when you pushed `gh-pages` in step 3, GitHub made `gh-pages` its default branch: set the default branch back to `main` (Settings, General) so pull requests and forks target it.

## Approving a signing run

After a merge, the **Registry sign** run waits in the `registry-signing` environment. A reviewer opens the run and checks:

- the workflow file it runs is the one expected. A publish pull request can edit the sign workflow file (`registry-sign.yml`), and the required approval is what stops a changed copy from using the key;
- the versions it will add are the ones that were reviewed and merged.

Then they approve. The run re-validates every unsigned version, skips and names any that fail (fix the directory and a later run signs it), signs the rest at `sequence + 1` and pushes `gh-pages`. Each skipped version also gets a `::warning::` annotation and a line in the run summary. The run refuses outright, signing and pushing nothing, if the `gh-pages` index does not verify against its own root key, if the `root-key` secret is not that index's root key, if `main` has no `nimbus-registry.json` or its copy loosens the one `gh-pages` last used (`requirePublisherNamespace` true to false), or if an already-signed version's `manifest.json` or `package.tgz` changed or was deleted on `main`. Runs are serialised (`concurrency: registry-sign`).

**Build provenance (optional).** For a version whose manifest declares `repository` (`owner/repo`), the sign run also runs `gh attestation verify` over the package and, when a SLSA build-provenance attestation from that repository verifies, records it in the version entry (repository, commit, workflow, runner); clients then show "Provenance verified by <registry>". A failure is a warning and the version is signed anyway. The sign workflow `init --github` writes passes `github-token: ${{ github.token }}` for this. The check workflow passes no token: it runs extension code (below), so provenance is left to the sign run.

## Eval scores

A version whose package holds `evals/` gets a quality score, measured by the registry and signed into the index; clients show `quality N/100 (measured by <registry>)`. Extension code runs only in jobs that hold no secret:

- the sign workflow's **`score` job** runs every unsigned version's eval suites in the platform sandbox (bubblewrap, no network; on a release that carries no sandbox helper the job log shows `sandbox: degraded mode (no per-host network gating)`, which is harmless: evals run with no network, so per-host gating never applies) with the `nimbus-gateway-linux-x64` of the pinned Nimbus release, checked against that release's `SHA256SUMS`. It has a read-only token, no environment and no persisted credentials, and uploads `scores.json` as the `registry-scores` artifact;
- the **`sign` job** needs `score`, downloads that artifact into the runner's temp directory (`${{ runner.temp }}/registry-scores`, never the checkout: the score job controls the artifact, and extracted into the workspace it could write into `.git/` of the job that holds the root key) and reads `scores.json` from there as untrusted input: each entry must match its version's id, version and package digest. A version with `evals/` and no valid score is not signed (the next sign run scores it again; see below); a version without `evals/` is signed with no score, though it may carry a baseline (below);
- the **check job** runs the pull request's version the same way and shows its score (or the error) in the summary.

**The score job's time budget.** One score run has 14 minutes for all its role runs, inside the job's 20-minute timeout. Each run gets the role's own 12-minute deadline or what is left of the budget, whichever is shorter; when the budget set the shorter deadline, a timeout says so (`ERR_EVAL_TIMEOUT`, "did not finish within N minutes (the score job's remaining time budget; the cap is 12 minutes)"), so a slow but legitimate suite is not blamed for time earlier versions used. Once under a minute is left, every further version with `evals/` gets an `ERR_EVAL_BUDGET` entry without running and is not signed by that run. So suites that hang, even on purpose, cannot turn the score job red.

**A version whose eval failed comes back on every run, and spends budget each time.** `sign` never signs a version whose eval errored (a timeout, a crash, `ERR_EVAL_BUDGET`), so it stays unsigned on `main`, and every sign run scores it again: the next run means the next push to the default branch, or a `workflow_dispatch`. Nothing is remembered between runs. A suite that hangs therefore spends 12 of the 14 budget minutes on every run, and later versions get `ERR_EVAL_BUDGET` or a shortened deadline on every run too, until the version scores or its directory is removed from `main`. The score job's summary lists the versions it could not score, and each gets a warning annotation with this remedy. The check job scores one version and keeps the 12-minute deadline.

**A red score job skips the whole sign run, trust requests included.** `sign` needs `score`, so when the score job fails for an infrastructure reason (the apt install, the sandbox probe, the release download), the sign job does not run at all: no version is signed, and no takedown or key revocation in `trust-requests/` or `statements/` is published either. The fix is to re-run the workflow (Actions, the failed run, **Re-run all jobs**) once the cause has cleared.

**The baseline.** Beside the score, the score job starts each version's server once under the same sandbox (no network, no write, no credential) with `__nimbus-eval --baseline`, lists its tool definitions and checks each one structurally. The result is signed into the version entry's `baseline`, and clients show it as its own `Baseline:` line naming your registry (see [the CLI reference](./cli-reference.md)). It is a stated fact about what happened when your job checked, never a score and never a reason to refuse a publish.

- **What it checks.** A tool name of 1 to 128 characters with no whitespace or control character, and an `inputSchema` that is an object with `type: "object"`, `properties` absent or an object whose values are objects or booleans, and `required` absent or an array of strings. The schema is not compiled. A pass means the server started and every tool it listed had a well-formed definition. It says nothing about what the tools do, and because it runs with no network it says nothing about the service the extension talks to.
- **Which versions.** Every version that is not a starter pack, with or without `evals/`. A starter pack never runs and has no baseline.
- **Two attempts.** A listing that fails or times out is tried once more from a fresh stage before it is recorded, and the role has its own 3-minute deadline inside the run's budget. A version that gets no baseline (the budget was spent, or the sandbox refused) is signed without one, with a warning, and reads `no baseline check published` for good.
- **A failed baseline is displayed and signed into that version.** Versions are immutable, so a failure is not retried on the next sign run. A run where no child could start at all (a runner whose sandbox cannot start children) would record that failure on a good version too, so read the score job's summary.
- **Two stated limits.** Mastra drops a tool with an empty name before the check sees it, and a tool with no `inputSchema` makes the whole listing fail, so it reads as `no-listing`.
- **A gateway older than the release that added `--baseline`.** The role exits 2 on the flag. The score job records a warning naming the version and writes only the suite result (nothing for a version without a suite), and the run stays green. Clients of an older Nimbus show no `Baseline:` line at all, and a baseline reaches owners only from the next version your registry signs with a release that has it; versions already signed stay as they are.

`scores.json` is `{ "<id>@<version>": entry }`. An entry is one of these shapes and no other:

```json
{ "packageSha256": "<hex>", "quality": { "scorer": 1, "score": 71, "cases": 7, "passed": 5, "rubrics": { } } }
{ "packageSha256": "<hex>", "error": { "code": "ERR_EVAL_TIMEOUT", "message": "..." } }
{ "packageSha256": "<hex>", "baseline": { "scorer": 1, "passed": true, "tools": 5 } }
{ "packageSha256": "<hex>", "baseline": { "scorer": 1, "passed": false, "tools": 0, "failure": "no-listing" } }
```

A version with `evals/` takes `quality` or `error`, and may add `baseline` beside either. A version without `evals/` takes the `baseline` entry alone. `failure` is one of `no-listing`, `listing-timeout` and `invalid-tool`, never text from the extension. A malformed `baseline`, or a baseline-only entry that is not exactly `packageSha256` and `baseline`, is ignored with a warning and the version is signed without it, even beside a valid `quality`.

**A registry that publishes with `maintain add`.** Pull requests are not the only way in: `nimbus registry maintain add <dir> <package> --scores <scores.json>` signs the same fields from a file (see `registry maintain add` in [the CLI reference](./cli-reference.md)). The action's `score-package` mode makes that file for one package: set `package` to a directory or a `.tgz` and `nimbus-gateway` to the absolute path of a gateway executable, in a job with no secrets (it refuses `root-key` and `github-token`). A directory is packed with the same deterministic packer `maintain add` uses, so the `packageSha256` in the file is the hash `maintain add` computes, and an entry whose hash differs is not used: `maintain add` refuses it for a package with `evals/`, and ignores a baseline-only one with a notice. `score-package` does not validate the package against your index; `maintain add` does that afterwards. A starter pack gets an empty `scores.json`.

**Sign before you score.** If your flow signs the package (`nimbus extension sign`) as part of publishing, sign it first and score the signed package. The publisher signature is part of the hashed bytes, so a package scored before it was signed hashes differently from the one `maintain add` receives, and `maintain add` does not use the entry. Run `score-package` in a keyless job on the signed package, hand `scores.json` to the keyed job as an artifact, and run `maintain add` there.

Both jobs set up the sandbox with `sudo`: install `bubblewrap` and set `kernel.apparmor_restrict_unprivileged_userns=0`, then probe bubblewrap as the runner user. On GitHub-hosted runners each job gets a fresh VM, so the change ends with the job. **On a self-hosted runner, do not lift the user-namespace restriction**: the sysctl changes the whole machine, for every later job and user on it. Run these jobs on GitHub-hosted runners, or on a dedicated, ephemeral self-hosted runner that already allows unprivileged user namespaces, and remove the `sysctl` lines.

**Adopting it in an existing registry.** Do not re-run `init --github` in your registry folder: it refuses there without `--force` because its files exist, and with `--force` it overwrites the root key file (by default `~/.nimbus/registry-key`, the key your registry is signed with) along with the workflows. Either run it into a scratch folder with a throwaway key (`nimbus registry maintain init ./scratch --github --key ./scratch-key --site ./scratch-site --default-branch <yours>`) and copy only its two workflow files, `registry-check.yml` and `registry-sign.yml` (under `.github/workflows/`), over yours, then delete the scratch folders and key; or apply the change by hand:

- `registry-sign.yml`: add a `score` job before `sign` (checkout with `persist-credentials: false`, job-level `permissions: contents: read`, the two setup steps, the action with `mode: score`, `default-branch` and `nimbus-gateway: ${{ github.workspace }}/nimbus-gateway-linux-x64`, then `actions/upload-artifact` of `scores.json` with `if-no-files-found: error`); in `sign`, add `needs: score`, an `actions/download-artifact` step for `registry-scores` with `path: ${{ runner.temp }}/registry-scores` before the action (never without `path`, which extracts into the checkout), and `scores: ${{ runner.temp }}/registry-scores/scores.json` under the action's `with:`;
- `registry-check.yml`: add the two setup steps before the action, replace `github-token: ${{ github.token }}` with `nimbus-gateway: ${{ github.workspace }}/nimbus-gateway-linux-x64` (the action refuses both together), and raise `timeout-minutes` to 20.

Take the exact steps and pins from a scratch `init --github` run. A registry that does not adopt this keeps working as before: without the `scores` input, sign records no quality.

## Bounds, stated plainly

- **A force-push to `gh-pages` breaks the registry for clients that already saw it.** After a force-push rolls `gh-pages` back, the next sign publishes a different index at a sequence number that was already used. Since the trust layer (2026-10-26), a client that accepted the original index at that sequence refuses the new one with `ERR_REGISTRY_EQUIVOCATION` (it stores a hash of the index it accepted at each sequence). The fix is another sign: the index after that has a sequence no client has seen. A client that never saw the original cannot tell the difference. Protecting `gh-pages` (step 7) is still the way to avoid this, and it is yours to keep; the sign workflow does not check it.
- **The registry repository must be public**, because the check job and the score job fetch without credentials. Private registries are not supported: in a private repository the score job fails, and a failed score job skips every sign run, trust requests included.
- The check job is not a boundary: a pull request can change it. Only the approval on the sign job protects the key.
- GitHub is the only forge supported.
- `nimbus extension publish` always opens its pull request from a fork (`gh repo fork --remote --remote-name fork`, run inside the clone) and never pushes to the registry directly, even when you could. `gh` cannot fork a repository you own personally, so the owner of a registry under a personal account cannot publish through the automated path; run `nimbus extension publish <dir> --registry-repo <owner>/<repo> --no-pr` instead, which commits the `publish/<id>/<version>` branch in a kept clone and prints the commands to finish by hand (`gh repo fork`, `git push fork <branch>`, `gh pr create`). As the owner, skip the fork: `git push origin <branch>` from that clone, then run the printed `gh pr create` with your own account as the `--head` owner. The fork path is untested against live GitHub.
