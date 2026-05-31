import type { PlatformPaths } from "../platform/paths.ts";
import type { ClassifiedIntent, IntentClass } from "./router.ts";
import type { PlannedAction } from "./types.ts";

function ent(entities: Record<string, string>, key: string): string {
  const v = entities[key];
  return typeof v === "string" ? v : "";
}

export type PlanResult =
  | { kind: "reply"; text: string }
  | { kind: "actions"; actions: PlannedAction[] };

type IntentPlanner = (classified: ClassifiedIntent, paths: PlatformPaths) => PlanResult;

const LOW_CONFIDENCE_REPLY: PlanResult = {
  kind: "reply",
  text: "I am not sure what you meant. Try asking to search for files by name, or to move a file (you will be asked to approve moves).",
};

const UNKNOWN_INTENT_REPLY: PlanResult = {
  kind: "reply",
  text: "I can search your indexed sandbox for files or move files with your approval. Try: “find files named *.md” or “move ./a.txt to ./b.txt”.",
};

const BUILTIN_INTENT_PLANNERS: Record<IntentClass, IntentPlanner> = {
  file_search: (classified, paths) => {
    const pattern = ent(classified.entities, "pattern").trim();
    if (pattern.length === 0) {
      return {
        kind: "reply",
        text: "What file name or pattern should I search for?",
      };
    }
    const rootRaw = ent(classified.entities, "path").trim();
    const root = rootRaw.length > 0 ? rootRaw : paths.dataDir;
    return {
      kind: "actions",
      actions: [
        {
          type: "filesystem_search_files",
          payload: {
            input: { path: root, pattern },
          },
        },
      ],
    };
  },
  file_organize: (classified) => {
    const source = ent(classified.entities, "source").trim();
    const destination = ent(classified.entities, "destination").trim();
    if (source.length === 0 || destination.length === 0) {
      return {
        kind: "reply",
        text: "Please specify both source and destination paths for the move.",
      };
    }
    return {
      kind: "actions",
      actions: [
        {
          type: "file.move",
          payload: {
            mcpToolId: "filesystem_move_file",
            input: { source, destination },
          },
        },
      ],
    };
  },
  unknown: () => UNKNOWN_INTENT_REPLY,
};

export function planFromIntent(classified: ClassifiedIntent, paths: PlatformPaths): PlanResult {
  if (classified.confidence < 0.6) {
    return LOW_CONFIDENCE_REPLY;
  }
  return BUILTIN_INTENT_PLANNERS[classified.intent](classified, paths);
}
