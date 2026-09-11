import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueCard } from "./QueueCard";

afterEach(cleanup);

describe("QueueCard", () => {
  it("queued: renders eta_s + position copy with role=status", () => {
    render(<QueueCard queue={{ kind: "queued", position: 3, eta_s: 20 }} onTryAgain={() => {}} />);
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("Your office opens in about 20s");
    expect(card).toHaveTextContent("You're 3 in line.");
  });

  it("full: renders the full copy and a Try again button that calls onTryAgain on click", () => {
    const onTryAgain = vi.fn();
    render(<QueueCard queue={{ kind: "full" }} onTryAgain={onTryAgain} />);
    const card = screen.getByRole("status");
    expect(card).toHaveTextContent("Cubicle is full right now");
    expect(card).toHaveTextContent("Every desk is busy. Try again in a minute.");

    const button = screen.getByRole("button", { name: /try again/i });
    fireEvent.click(button);
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when queue is null", () => {
    const { container } = render(<QueueCard queue={null} onTryAgain={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
