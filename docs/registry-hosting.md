# Hosting an extension registry

A Nimbus extension registry is a folder of signed static files (see [architecture.md](./architecture.md#extension-marketplace--tauri-ui)). This page covers the one hosting shape Nimbus automates: a **public GitHub repository** whose CI validates publish pull requests and signs the index. The first registry, `nimbus-agent/extensions`, is the worked example. For offline or self-hosted registries, `nimbus registry maintain init|add|remove` in [cli-reference.md](./cli-reference.md#nimbus-registry-maintain-initaddremove) is all you need.

## What you get

- `main` holds sources: `extensions/<id>/<version>/{manifest.json,package.tgz,publish-request.json}`, the rules in `nimbus-registry.json`, and two workflows. It never holds a signed `index.json`.
- `gh-pages` holds the published site: the signed `index.json` and the files it references. Only the sign workflow writes it.
- **Registry check** runs on every pull request to `main` with a read-only token and no secrets. It is a reviewer aid.
- **Registry sign** runs after a merge (or by hand), behind the `registry-signing` environment's required reviewers, with the root key. It is the security boundary.

## Owner steps

Replace `nimbus-agent/extensions` with your own `<owner>/<repo>`.

1. **Scaffold.** `nimbus registry maintain init ./extensions --github`. This writes the repository folder, a sibling `./extensions-site` for `gh-pages`, and a root key at `~/.nimbus/registry-key`. It prints the key's fingerprint and the steps below with your paths filled in; it never prints the key. Nothing is pushed. The workflows reference the registry action pinned to the commit your CLI was built from; a development build needs `--action-ref <40-hex>`.
2. **Make the repository public.** The check workflow fetches `gh-pages` and `main` without credentials.
3. **Push both branches.** Push `./extensions` as `main` and `./extensions-site` as `gh-pages` of `nimbus-agent/extensions`.
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
7. **Protect `main`:** require pull requests. If you used `--default-branch`, protect that branch; both workflows follow it.
8. **Protect `gh-pages` against force-push and deletion**, without requiring pull requests, reviews or status checks, so the sign workflow's `GITHUB_TOKEN` push still lands.

## Approving a signing run

After a merge, the **Registry sign** run waits in the `registry-signing` environment. A reviewer opens the run and checks:

- the workflow file it runs is the one expected. A publish pull request can edit the sign workflow file (`registry-sign.yml`), and the required approval is what stops a changed copy from using the key;
- the versions it will add are the ones that were reviewed and merged.

Then they approve. The run re-validates every unsigned version, skips and names any that fail (fix the directory and a later run signs it), signs the rest at `sequence + 1` and pushes `gh-pages`. If a version that is already signed has changed on `main`, or the `nimbus-registry.json` rules were loosened, the run refuses and signs nothing. Runs are serialised (`concurrency: registry-sign`).

## Bounds, stated plainly

- **A force-push to `gh-pages` can roll the registry back.** The next sign publishes a different index at a sequence number that was already used, and today's client accepts an equal sequence. Protecting `gh-pages` (step 8) is the mitigation and is yours to keep; the sign workflow does not check it. Client-side refusal of an equal sequence belongs to the later trust-layer project.
- **The registry repository must be public**, because the check job fetches without credentials. Private registries are not supported.
- The check job is not a boundary: a pull request can change it. Only the approval on the sign job protects the key.
- GitHub is the only forge supported.
- `nimbus extension publish` falls back to forking the registry when you cannot push to it; that path is untested against live GitHub.
