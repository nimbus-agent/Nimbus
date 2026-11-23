// Types shared by every structure-audit invariant module.

export type FileEntry = { relPath: string; contents: string };
export type Violation = { rule: string; file: string; line: number; snippet: string };

export type Mode =
  | "spawn"
  | "wrap-spec"
  | "vault-key"
  | "db-run"
  | "db-run-exec"
  | "binary-only"
  | "all";
