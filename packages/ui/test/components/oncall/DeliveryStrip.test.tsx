import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeliveryStrip } from "../../../src/components/oncall/DeliveryStrip";

describe("DeliveryStrip", () => {
  it("renders an outcome with its reason", () => {
    render(
      <DeliveryStrip
        delivery={{
          chatops: { outcome: "skipped", reason: "no [oncall.push] chatops_namespace", at: 1 },
        }}
      />,
    );
    expect(screen.getByText("chatops: skipped")).toBeTruthy();
    expect(screen.getByText("no [oncall.push] chatops_namespace")).toBeTruthy();
  });
  it("renders no stray separator or reason text when there is no reason", () => {
    const { container } = render(
      <DeliveryStrip delivery={{ event: { outcome: "delivered", at: 1 } }} />,
    );
    expect(container.querySelector("li")?.textContent).toBe("event: delivered");
    expect(screen.queryByText(/undefined|null/)).toBeNull();
  });
  it("renders nothing for an empty delivery", () => {
    const { container } = render(<DeliveryStrip delivery={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
