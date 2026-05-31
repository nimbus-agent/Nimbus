import { MIN_HEIGHT_THRESHOLD } from "./constants.ts";

export type FallbackReason = "TERM=dumb" | "NO_COLOR" | "non-TTY" | "CI=true" | "rows-too-small";

export interface FallbackEnv {
  TERM: string | undefined;
  NO_COLOR: string | undefined;
  CI: string | undefined;
  isTTY: boolean;
  columns: number | undefined;
  rows: number | undefined;
}

export function detectFallbackReason(env: FallbackEnv): FallbackReason | null {
  if (env.TERM === "dumb") {
    return "TERM=dumb";
  }
  if (env.NO_COLOR !== undefined) {
    return "NO_COLOR";
  }
  if (!env.isTTY) {
    return "non-TTY";
  }
  if (env.CI === "true") {
    return "CI=true";
  }
  if (env.rows !== undefined && env.rows < MIN_HEIGHT_THRESHOLD) {
    return "rows-too-small";
  }
  return null;
}

export function currentFallbackEnv(): FallbackEnv {
  return {
    TERM: process.env["TERM"],
    NO_COLOR: process.env["NO_COLOR"],
    CI: process.env["CI"],
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  };
}
