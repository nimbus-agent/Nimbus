## Summary

<!-- What does this PR do? One paragraph or a short bullet list. -->

## Related Issue

<!-- Link the issue this PR addresses: "Closes #123" or "Relates to #456" -->

Closes #

## Linked Discussion

<!-- Optional but encouraged. If this PR implements an idea agreed in Discussions Ideas, answers a Q&A, or addresses something flagged in General, paste the discussion URL here so a maintainer can update or mark-answered the thread after merge. Note: GitHub does NOT auto-close Discussions from PR merges (only Issues via `Closes #N`); this is a manual maintainer follow-up. -->

## Type of Change

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behaviour)
- [ ] Refactor (no behaviour change)
- [ ] Test improvement
- [ ] Documentation only
- [ ] CI / tooling

## Non-Negotiables Checklist

<!-- Every PR must satisfy these. A failed item blocks merge. -->

- [ ] `bun run typecheck` passes with zero errors
- [ ] `bun run lint` passes (Biome — format + lint)
- [ ] All existing tests pass (`bun test`)
- [ ] New behaviour is covered by tests
- [ ] No `any` types introduced — `unknown` is used for external data
- [ ] No credentials, tokens, or secret values appear in logs, IPC messages, config, or test fixtures
- [ ] Platform-specific code is behind the `PlatformServices` abstraction (no OS checks in business logic)
- [ ] The HITL consent gate has not been weakened, bypassed, or made configurable
- [ ] If this PR touches `docs/README.md`, a screenshot of the rendered page (light + dark) is attached in the Screenshots / Output section below

## Coverage (if you added or changed source files)

<!-- CI enforces coverage on Linux only: `audit:coverage-floor` (every non-exempt file ≥85% line and ≥80% branch) and `audit:coverage-scopes` (per-directory floors, e.g. engine/ ≥85%, vault/ ≥90%). A local run on Windows or macOS is not authoritative — reproduce CI with `bun run verify:docker --full`. See docs/CONTRIBUTING.md § The per-file coverage floor. -->

- [ ] New or changed source files are covered by tests, or the PR description says why a file is excluded

## Testing

<!-- Describe what you tested and how. Include platform(s) tested if relevant. -->

<!-- Desktop E2E (Tauri + Playwright) on PRs: add the `ci:e2e-desktop` label to run the optional Ubuntu job after `pr-quality`. -->

## Screenshots / Output

<!-- Optional — include terminal output, logs, or screenshots if helpful for review. -->

## Notes for Reviewers

<!-- Anything the reviewer should know: tricky areas, intentional trade-offs, follow-up issues. -->
