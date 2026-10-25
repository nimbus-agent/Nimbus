import type React from "react";
import type { ReactNode } from "react";

/** The small uppercase "Step N" label every onboarding step opens with. */
export function StepLabel({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        fontSize: 11,
        textTransform: "uppercase",
        letterSpacing: 1.5,
        color: "var(--color-fg-muted)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

export function buttonStyle(
  variant: "primary" | "ghost" | "outline",
  disabled = false,
): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "8px 20px",
    borderRadius: "var(--radius-md)",
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
  };
  if (variant === "primary") {
    return {
      ...base,
      background: disabled ? "var(--color-surface)" : "var(--color-accent)",
      color: disabled ? "var(--color-fg-muted)" : "white",
      border: "1px solid var(--color-accent)",
    };
  }
  if (variant === "outline") {
    return {
      ...base,
      background: "transparent",
      color: "var(--color-fg)",
      border: "1px solid var(--color-border)",
    };
  }
  return {
    ...base,
    background: "transparent",
    color: "var(--color-fg-muted)",
    border: "1px solid transparent",
  };
}

export function cardStyle(selected: boolean): React.CSSProperties {
  return {
    textAlign: "left",
    padding: 14,
    border: `1px solid ${selected ? "var(--color-accent)" : "var(--color-border)"}`,
    borderRadius: "var(--radius-md)",
    background: selected ? "rgba(120, 144, 255, 0.12)" : "transparent",
    color: "var(--color-fg)",
    cursor: "pointer",
  };
}

/** A gateway error message without its `ERR_*:` code prefix, for plain-language display. */
export function plainError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^ERR_[A-Z_]+:\s*/, "");
}
