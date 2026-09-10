import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeaBox } from "./IdeaBox";

afterEach(cleanup);

describe("IdeaBox", () => {
  it("blocks submit and shows nothing sent when empty", () => {
    const onSubmit = vi.fn();
    render(<IdeaBox value="" onChange={() => {}} onSubmit={onSubmit} />);
    const start = screen.getByRole("button", { name: /start/i });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks submit when over 500 characters", () => {
    const onSubmit = vi.fn();
    render(<IdeaBox value={"a".repeat(501)} onChange={() => {}} onSubmit={onSubmit} />);
    const start = screen.getByRole("button", { name: /start/i });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter submits, Shift+Enter inserts a newline instead", () => {
    const onSubmit = vi.fn();
    render(<IdeaBox value="a good idea" onChange={() => {}} onSubmit={onSubmit} />);
    const textarea = screen.getByPlaceholderText(/subscription tracker/i);

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);

    onSubmit.mockClear();
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the textarea and Start button after start", () => {
    render(<IdeaBox value="an idea" onChange={() => {}} onSubmit={() => {}} disabled />);
    expect(screen.getByPlaceholderText(/subscription tracker/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /start/i })).toBeDisabled();
  });

  it("renders the limit sign-in placeholder for a limit error", () => {
    render(
      <IdeaBox value="an idea" onChange={() => {}} onSubmit={() => {}} error={{ kind: "limit", message: "" }} />,
    );
    expect(screen.getByText(/sign in to run more/i)).toBeInTheDocument();
  });

  it("renders the server-down message for a server error", () => {
    render(
      <IdeaBox
        value="an idea"
        onChange={() => {}}
        onSubmit={() => {}}
        error={{ kind: "server", message: "Our office is down, try in a few minutes." }}
      />,
    );
    expect(screen.getByText(/our office is down/i)).toBeInTheDocument();
  });

  it("renders the server-supplied message for a validation error", () => {
    render(
      <IdeaBox
        value="an idea"
        onChange={() => {}}
        onSubmit={() => {}}
        error={{ kind: "validation", message: "Tell us the idea in up to 500 characters." }}
      />,
    );
    expect(screen.getByText(/up to 500 characters/i)).toBeInTheDocument();
  });

  it("always shows the provider notice, unscrolled", () => {
    render(<IdeaBox value="" onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByText(/sent to google's gemini/i)).toBeInTheDocument();
  });
});
