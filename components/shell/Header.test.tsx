import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Header } from "./Header";

describe("Header", () => {
  it("renders the logo link, a status slot, and the sign-in control", () => {
    render(<Header status={<span data-testid="status">Running</span>} />);
    expect(screen.getByRole("link", { name: /cubicle/i })).toHaveAttribute("href", "/");
    expect(screen.getByTestId("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });
});
