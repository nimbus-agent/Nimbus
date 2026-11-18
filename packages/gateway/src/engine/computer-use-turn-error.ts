// packages/gateway/src/engine/computer-use-turn-error.ts
// A turn that named a computer-use session (`nimbus ask --computer <id>`, I35 OR-MCU-1) and cannot drive it.
// Thrown, never folded into an ordinary answer: a turn that silently answered without the session's
// tools would read as if the model had tried.

/** Why a `--computer` turn cannot drive its session. Fixed texts: nothing from the request is echoed. */
export const COMPUTER_USE_TURN_REFUSALS = {
  notTerminal: "only `nimbus ask` in a terminal can drive a computer-use session",
  demo: "a demo gateway cannot drive a computer-use session",
  notOpen:
    "that computer-use session is not open in this gateway (open one with `nimbus computer`, then pass the id it prints)",
  noAgent:
    "a computer-use turn needs the tool-calling agent, and this turn would be answered by the local model, which has no tools (check `[llm] prefer_local` and `enforce_air_gap`, or configure a remote model)",
} as const;

export class ComputerUseTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerUseTurnError";
  }
}
