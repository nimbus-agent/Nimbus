import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type LlmTaskType = "classification" | "reasoning" | "summarisation" | "agent_step";

type TaskDecision = {
  providerId: string;
  modelName: string;
  isAvailable: boolean;
  reason: string;
  fallback?: { providerId: string; modelName: string };
};

type RouterStatusResponse = {
  decisions: Record<LlmTaskType, TaskDecision | undefined>;
};

const TASK_TYPES: LlmTaskType[] = ["classification", "reasoning", "summarisation", "agent_step"];

const COL_WIDTHS = {
  task: 14,
  provider: 10,
  model: 24,
  available: 9,
  reason: 14,
};

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printStatusTable(decisions: Record<LlmTaskType, TaskDecision | undefined>): void {
  const header =
    pad("Task type", COL_WIDTHS.task) +
    pad("Provider", COL_WIDTHS.provider) +
    pad("Model", COL_WIDTHS.model) +
    pad("Available", COL_WIDTHS.available) +
    "Reason";
  const divider = "-".repeat(header.length);
  console.log(header);
  console.log(divider);
  for (const task of TASK_TYPES) {
    const d = decisions[task];
    if (d === undefined) {
      console.log(
        pad(task, COL_WIDTHS.task) +
          pad("—", COL_WIDTHS.provider) +
          pad("—", COL_WIDTHS.model) +
          pad("no", COL_WIDTHS.available) +
          "unavailable",
      );
    } else {
      const reason = d.fallback
        ? `${d.reason} (falls back to ${d.fallback.providerId}/${d.fallback.modelName})`
        : d.reason;
      console.log(
        pad(task, COL_WIDTHS.task) +
          pad(d.providerId, COL_WIDTHS.provider) +
          pad(d.modelName || "—", COL_WIDTHS.model) +
          pad(d.isAvailable ? "yes" : "no", COL_WIDTHS.available) +
          reason,
      );
    }
  }
}

export async function runLlmStatusImpl(client: IPCClient, opts: { json: boolean }): Promise<void> {
  const res = await client.call<RouterStatusResponse>("llm.status", {});
  if (opts.json) {
    const normalized: Record<LlmTaskType, TaskDecision | null> = {
      classification: res.decisions.classification ?? null,
      reasoning: res.decisions.reasoning ?? null,
      summarisation: res.decisions.summarisation ?? null,
      agent_step: res.decisions.agent_step ?? null,
    };
    console.log(JSON.stringify(normalized, null, 2));
    return;
  }
  printStatusTable(res.decisions);
}

export async function runLlm(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (subcommand === undefined || subcommand === "help" || subcommand === "--help") {
    console.log("Usage: nimbus llm <subcommand>");
    console.log("");
    console.log("Subcommands:");
    console.log("  status    Show selected LLM provider/model per task type");
    console.log("");
    console.log("Flags:");
    console.log("  --json    Emit machine-readable JSON");
    return;
  }

  if (subcommand === "status") {
    const json = rest.includes("--json");
    await withGatewayIpc((c) => runLlmStatusImpl(c, { json }));
    return;
  }

  throw new Error(`Unknown llm subcommand: ${subcommand}`);
}
