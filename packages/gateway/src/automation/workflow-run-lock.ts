// packages/gateway/src/automation/workflow-run-lock.ts
// One in-process lock per workflow (Phase 10 SA4, plan task 7). A scheduled fire AND a resume hold it
// for the whole run, so the two can never execute the same workflow's write steps at once: a resume
// that finds it held is refused (`ERR_WORKFLOW_BUSY`), and a fire that finds it held is recorded as
// skipped. It is released in a `finally` on every path, a throw and a client abort included.

export interface WorkflowRunLock {
  /** Takes the lock for `workflowId`; false when it is already held. */
  tryAcquire(workflowId: string): boolean;
  release(workflowId: string): void;
  isHeld(workflowId: string): boolean;
  /**
   * Runs `fn` while holding the lock and releases it in a `finally`; `undefined` (and `fn` never
   * called) when the lock is held. A result of `{ held: true }` carries `fn`'s value.
   */
  withLock<T>(
    workflowId: string,
    fn: () => Promise<T>,
  ): Promise<{ held: true; value: T } | undefined>;
}

export function createWorkflowRunLock(): WorkflowRunLock {
  const held = new Set<string>();
  return {
    tryAcquire(workflowId) {
      if (held.has(workflowId)) return false;
      held.add(workflowId);
      return true;
    },
    release(workflowId) {
      held.delete(workflowId);
    },
    isHeld(workflowId) {
      return held.has(workflowId);
    },
    async withLock(workflowId, fn) {
      if (held.has(workflowId)) return undefined;
      held.add(workflowId);
      try {
        return { held: true as const, value: await fn() };
      } finally {
        held.delete(workflowId);
      }
    },
  };
}

/** The gateway's one lock: the scheduler and `workflow.resume` share it. */
export const workflowRunLock: WorkflowRunLock = createWorkflowRunLock();
