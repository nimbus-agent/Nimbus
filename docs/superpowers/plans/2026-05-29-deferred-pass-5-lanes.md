# Deferred Pass-5 SOLID lanes (not Sonar-driven)

These lanes from `2026-05-28-monorepo-cleanup-pass.md` Pass 5 were NOT executed
in cleanup pass 2 because they had no SonarCloud finding driving them. Tracked
here so they are not forgotten.

- **5.5 vault Liskov** — confirm win32/darwin/linux conform to `NimbusVault` with no signature widening. Trigger: any new vault backend or `NimbusVault` method.
- **5.6 llm/voice provider DI** — `LlmRouter` constructor injection instead of direct `OllamaProvider`/`LlamaCppProvider` imports. Trigger: adding a 3rd LLM provider, or a `mock.module` test flake on the llm suite.
- **5.8 UI component splits** — React files >250 LOC. Trigger: a UI file crossing the threshold with a real maintainability cost.
- **5.9 sdk/client conservative SOLID** — API-preserving only; needs a version bump if exports change. Trigger: a published-surface refactor.
- **5.10 vscode-extension** — minimal pass; small package. Trigger: opportunistic.

## Also deferred from cleanup pass 2 itself

- **WS-C.7 — `sandbox-helper/main.c` complexity (`c:S3776` line 316 cc 66, line 88 cc 26; `c:S134` nesting)**: BLOCKED on the execution machine — no C toolchain (`gcc`/`clang`/`cl`) present, so the refactor cannot be compiled/verified locally. Other `c:*` smells (`c:S125`, `c:S923`, `c:S5281`) likewise. Trigger: pick up on a Linux/CI image with `gcc`. The C buffer-overflow hotspot (`main.c:92` strlen) was reviewed and marked Safe (NUL-terminated argv, length re-checked) rather than edited unverified.
- **A handful of deliberately-skipped TS smells** (judged not safely mechanical / behavior-risk): `S3735` `void` unused-binding silencers (removal cascades to unused-var lint errors), `S107` 8-param `dependency-graph` signature, `S5843` zoom-transcript security-allowlist regex, `S6551` non-string title stringification, and a few `S5914` intentional compile-time/discovery-smoke placeholder tests. Trigger: revisit if any becomes load-bearing.
