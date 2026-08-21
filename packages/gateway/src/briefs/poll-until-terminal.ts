/**
 * Test-only: wait for a run to reach a terminal state, bounded by WALL-CLOCK time.
 *
 * WHY NOT AN ITERATION COUNT. Every caller of this used to loop a fixed number of times with a
 * 5 ms sleep between polls, which makes the real budget `n * (sleep + one loopback round trip)`
 * — a quantity that depends entirely on how fast the machine answers HTTP. On the `windows-2025`
 * CI runner a round trip can cost hundreds of milliseconds, and `briefs/brief-e2e.test.ts`'s
 * 200-iteration loop was measured hitting the harness's own 60 s timeout BEFORE exhausting its
 * iterations (run 32452626344: 60006.53 ms, a 6.53 ms overshoot, so the timer fired on schedule
 * and the loop was still going). The failure therefore surfaced as a bare
 * "this test timed out after 60000ms" rather than as this helper's own message, and the CI
 * retry wrapper re-ran the whole 831-file suite — about eleven extra minutes.
 *
 * A deadline fixes both halves. A slow runner spends its budget on fewer, more expensive polls
 * instead of falling off the end of a counter, and when the budget IS exhausted the throw says
 * what actually happened, well inside the harness timeout.
 *
 * The default sleep is deliberately larger than the old 5 ms: at 5 ms a slow runner spends its
 * whole budget issuing requests, and the polling itself becomes the load.
 */

const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_SLEEP_MS = 25;

export type TerminalBody = { status: string; report?: unknown; failureReason?: string };

export type PollOptions = {
  /** Wall-clock budget. Keep it well under the test timeout so this throws first. */
  budgetMs?: number;
  sleepMs?: number;
};

/**
 * Poll `GET {base}/v1/briefs/{id}` until `status` is `done` or `failed`.
 *
 * Throws — naming the elapsed time, the poll count and the last status seen — rather than
 * returning a non-terminal body, so a caller can never mistake "still running" for a result.
 */
export async function pollBriefUntilTerminal(
  base: string,
  token: string,
  id: string,
  opts?: PollOptions,
): Promise<TerminalBody> {
  const budgetMs = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const sleepMs = opts?.sleepMs ?? DEFAULT_SLEEP_MS;
  const deadline = Date.now() + budgetMs;

  let polls = 0;
  let lastStatus = "<never polled>";
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    const res = await fetch(`${base}/v1/briefs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    polls++;
    if (res.status !== 200) throw new Error(`unexpected GET status ${String(res.status)}`);
    const body = (await res.json()) as TerminalBody;
    lastStatus = body.status;
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  throw new Error(
    `brief run ${id} never reached a terminal state: ${String(polls)} polls over ` +
      `${String(Date.now() - startedAt)} ms (budget ${String(budgetMs)} ms), last status ` +
      `"${lastStatus}"`,
  );
}
