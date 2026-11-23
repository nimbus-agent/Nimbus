import pino from "pino";

export const runAskLog = pino({
  name: "run-ask",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});
