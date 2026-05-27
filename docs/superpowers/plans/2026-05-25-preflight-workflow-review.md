# Pre-flight Workflow Overhaul Implementation Plan Review

**Date:** 2026-05-25

This document captures open questions, suggestions, and potential improvements based on a review of the `2026-05-25-preflight-workflow.md` implementation plan.

## Open Questions

1. **Drift Test Regex Limitations (Task 2):**
   * *Question:* The drift test `scripts/preflight.test.ts` uses regex `/\bbun run ([a-z][\w:-]+)/g` to extract gates from CI files. Will this correctly catch instances where `bun` is invoked with the `--bun` runtime flag (e.g., `bun --bun run audit:boundaries`)? If the team adopts the `--bun` flag for certain Node.js scripts in the future, the drift test regex will silently fail to register them.

2. **Cross-Platform Audit Noise (Task 3):**
   * *Question:* The `looksLikePathWithSeparator` heuristic handles collapsed backslashes and URL schemes. However, tests often include JSON strings, regex compilations, or mock string data that might coincidentally look like path separators. Will this pure string-matching approach create too much noise during the initial rollout, leading to a sprawling proliferation of `// cross-platform-ok` comments?

## Suggestions & Improvements

1. **Git Hook `$PATH` Safety for IDEs (Task 5):**
   * *Suggestion:* The `.githooks/pre-commit` and `pre-push` shell scripts invoke `bun run`. When a developer uses an IDE's GUI (e.g., VS Code Source Control, IntelliJ, or Tower) to commit or push, the IDE often executes the Git binary outside of the developer's standard shell profile. This means `bun` might not be on the `$PATH`, causing the hook to fail with a cryptic "command not found" error. It would be safer to add a quick command existence check at the top of the hook:
     ```sh
     if ! command -v bun >/dev/null 2>&1; then
       echo "✗ 'bun' not found on PATH. If using a GUI IDE, ensure your shell profile is loaded." >&2
       exit 1
     fi
     ```

2. **Runner Error Output Visibility (Task 1):**
   * *Suggestion:* The `scripts/preflight.ts` runner uses `stdout: "inherit", stderr: "inherit"` for spawned processes. When multiple gates run (especially in `--no-bail` mode), the specific error output of a failing gate might scroll hundreds of lines off-screen, leaving the user with only the summary at the bottom. Consider buffering the `stderr` of failing jobs and re-printing it beneath the final `── preflight summary ──` block so developers don't have to scroll up to find the actual failure reason.
