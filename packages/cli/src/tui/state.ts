export interface HitlRequest {
  actionId: string;
  action: string;
  params: Record<string, unknown>;
}

export interface HitlBatchState {
  batchId: string;
  requests: HitlRequest[];
  cursor: number;
  decisions: Array<{ actionId: string; approved: boolean }>;
}

export type TuiMode = "idle" | "streaming" | "awaiting-hitl" | "disconnected";

export interface TuiState {
  mode: TuiMode;
  activeStreamId: string | null;
  liveBuffer: string;
  hitlBatch: HitlBatchState | null;
  lastError: string | null;
}

export type TuiAction =
  | { type: "submit"; streamId: string; query: string }
  | { type: "stream-token"; streamId: string; text: string }
  | { type: "stream-done"; streamId: string }
  | { type: "stream-error"; streamId: string; error: string }
  | { type: "hitl-requested"; batchId: string; requests: HitlRequest[] }
  | { type: "hitl-advance"; approved: boolean }
  | { type: "hitl-resolve" }
  | { type: "cancel" }
  | { type: "disconnect" }
  | { type: "reconnect" }
  | { type: "flush-live" };

export const initialTuiState: TuiState = {
  mode: "idle",
  activeStreamId: null,
  liveBuffer: "",
  hitlBatch: null,
  lastError: null,
};

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "submit":
      return {
        ...state,
        mode: "streaming",
        activeStreamId: action.streamId,
        liveBuffer: "",
        lastError: null,
      };

    case "stream-token":
      if (state.activeStreamId !== action.streamId) {
        return state;
      }
      return { ...state, liveBuffer: state.liveBuffer + action.text };

    case "stream-done":
      if (state.activeStreamId !== action.streamId) {
        return state;
      }
      return { ...state, mode: "idle", activeStreamId: null };

    case "stream-error":
      if (state.activeStreamId !== action.streamId) {
        return state;
      }
      return {
        ...state,
        mode: "idle",
        activeStreamId: null,
        lastError: action.error,
      };

    case "hitl-requested":
      return {
        ...state,
        mode: "awaiting-hitl",
        hitlBatch: {
          batchId: action.batchId,
          requests: action.requests,
          cursor: 0,
          decisions: [],
        },
      };

    case "hitl-advance": {
      if (state.hitlBatch === null) {
        return state;
      }
      const { requests, cursor, decisions } = state.hitlBatch;
      const currentRequest = requests[cursor];
      if (currentRequest === undefined) {
        return state;
      }
      const nextDecisions = [
        ...decisions,
        { actionId: currentRequest.actionId, approved: action.approved },
      ];
      return {
        ...state,
        hitlBatch: {
          ...state.hitlBatch,
          cursor: cursor + 1,
          decisions: nextDecisions,
        },
      };
    }

    case "hitl-resolve":
      return {
        ...state,
        mode: state.activeStreamId === null ? "idle" : "streaming",
        hitlBatch: null,
      };

    case "cancel":
      return { ...state, mode: "idle", activeStreamId: null };

    case "disconnect":
      return {
        ...state,
        mode: "disconnected",
        activeStreamId: null,
        hitlBatch: null,
      };

    case "reconnect":
      return { ...state, mode: "idle" };

    case "flush-live":
      return { ...state, liveBuffer: "" };

    default: {
      action satisfies never;
      return state;
    }
  }
}
