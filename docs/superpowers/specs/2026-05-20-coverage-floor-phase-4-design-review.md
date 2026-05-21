# Design Review: Coverage Floor Phase 4 — Long Tail

**Date:** 2026-05-20
**Reviewer:** Antigravity

The spec is well-structured and aligns with the previous coverage floor phase precedents. The commit ordering is logical, handling low-risk changes before higher-risk ones.

Here are a few questions, suggestions, and minor corrections to consider:

## Suggestions & Questions

1. **Commit 6 Bundling (`mesh.ts`)**:
   `lazy-mesh/mesh.ts` is noted as the largest Tier B file and carries a higher risk of needing substantial mock surface (e.g. `MockMcpClient`). Since it's bundled with `auth/notion-access-token.ts` in Commit 6, consider breaking `mesh.ts` out into its own dedicated commit. Isolating it could simplify reverts or debugging if CI behaves differently than the local environment.

2. **Worker Exclusions (`query-guard-worker.ts`, `embedding-worker.ts`)**:
   Adding worker entry points to structural exclusions makes sense for in-process limitations. However, by permanently excluding them, they will require zero coverage going forward. Has the team considered a lightweight worker test harness for a future phase, or is the consensus that the logic inside these entry points is minimal enough that the bridge tests sufficiently cover the contract? 

3. **ONNX Mocking (`embedding/model.ts`)**:
   For `embedding/model.ts`, the plan accepts partial coverage because `createLocalEmbedder` requires a real ONNX runtime. Would it be feasible to mock the ONNX `InferenceSession` constructor using `bun:test` to achieve ≥80% without loading a real model, or is that too deep of a mock for this phase's scope?

## Corrections

4. **Phase 4 → Phase 5 Transition Math**:
   In the transition section, the math for `cli` entries states:
   > ~52 cli entries (53 minus `interactive-ipc-handlers.ts` raised in this PR)
   
   However, `packages/cli/src/tui/test-helpers/stub-client.ts` is also in the `cli` package and is being raised in Tier A. 
   Therefore, the transition should likely reflect 53 minus 2 = 51 CLI entries remaining.

## Conclusion

Overall, the plan is extremely solid and well thought out. The above points are minor refinements and the plan is ready for execution.
