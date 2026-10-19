# Hosting an extension registry

A Nimbus extension registry is a folder of signed static files (see [architecture.md](./architecture.md#extension-marketplace--tauri-ui)). This page covers the one hosting shape Nimbus automates: a **public GitHub repository** whose CI validates publish pull requests and signs the index. The first registry, `nimbus-agent/extensions`, is the worked example. For offline or self-hosted registries, `nimbus registry maintain init|add|remove` in [cli-reference.md](./cli-reference.md#nimbus-registry-maintain-initaddremove) is all you need.

## What you get

- `main` holds sources: `extensions/<id>/<version>/{manifest.json,package.tgz,publish-request.json}`, the rules in `nimbus-registry.json`, and two workflows. It never holds a signed `index.json`.
- `gh-pages` holds the published site: the signed `index.json` and the files it references. Only the sign workflow writes it.
- **Registry check** runs on every pull request to `main` with a read-only token and no secrets. It is a reviewer aid.
- **Registry sign** runs after a merge (or by hand), behind the `registry-signing` environment's required reviewers, with the root key. It is the security boundary.

## Owner steps

Step 1 prints these steps (numbered there from "Make sure the repository is public") with your folder and key paths filled in; replace `<owner>/<repo>` in them with your repository. Below, `nimbus-agent/extensions` is the example.

1. **Scaffold.** `nimbus registry maintain init ./extensions --github`. This writes the repository folder, a sibling `./extensions-site` for `gh-pages`, and a root key at `~/.nimbus/registry-key`. The site folder holds the signed empty `index.json`, a copy of `nimbus-registry.json`, an empty `.nojekyll` (so GitHub Pages' Jekyll does not drop paths that start with `_` or `.`) and a `.gitattributes` of `* -text` (so git never rewrites the line endings of signed bytes); every sign run builds on the previous site tree and keeps both. It prints the key's fingerprint and the steps below with your paths filled in; it never prints the key. Nothing is pushed. The workflows reference the registry action pinned to the commit your CLI was built from; a development build needs `--action-ref <40-hex>`.
2. **Make the repository public.** The check workflow fetches `gh-pages` and `main` without credentials.
3. **Push the site.** Push `./extensions-site` as the `gh-pages` branch of `nimbus-agent/extensions`. Do not push `main` yet.
4. **Create the `registry-signing` environment** (Settings, Environments) and add **required reviewers**.
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

## Bounds, stated plainly

- **A force-push to `gh-pages` can roll the registry back.** The next sign publishes a different index at a sequence number that was already used, and today's client accepts an equal sequence. Protecting `gh-pages` (step 7) is the mitigation and is yours to keep; the sign workflow does not check it. Client-side refusal of an equal sequence belongs to the later trust-layer project.
- **The registry repository must be public**, because the check job fetches without credentials. Private registries are not supported.
- The check job is not a boundary: a pull request can change it. Only the approval on the sign job protects the key.
- GitHub is the only forge supported.
- `nimbus extension publish` always opens its pull request from a fork (`gh repo fork --remote --remote-name fork`, run inside the clone) and never pushes to the registry directly, even when you could. `gh` cannot fork a repository you own personally, so the owner of a registry under a personal account cannot publish through the automated path; run `nimbus extension publish <dir> --registry-repo <owner>/<repo> --no-pr` instead, which commits the `publish/<id>/<version>` branch in a kept clone and prints the commands to finish by hand (`gh repo fork`, `git push fork <branch>`, `gh pr create`). As the owner, skip the fork: `git push origin <branch>` from that clone, then run the printed `gh pr create` with your own account as the `--head` owner. The fork path is untested against live GitHub.
