import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Typewriter } from "./Typewriter";

afterEach(cleanup);

const LONG_BODY =
  "This is an eighty word body used to prove the typewriter caps its total reveal time at one point four seconds " +
  "regardless of length by accelerating the per character interval so that even a long paragraph like this one, " +
  "padded out with extra filler words to reach the target word count for the test case, finishes fully within the " +
  "fourteen hundred millisecond budget the design spec calls for in section four of the motion specification file " +
  "so that speaking desks never feel sluggish no matter how verbose the underlying agent message body happens to be today more words here now";

describe("Typewriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("TC-050: an 80-word body reaches full text within 1.4s of advanced timers", () => {
    const { container } = render(<Typewriter text={LONG_BODY} />);
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(container.textContent).toBe(LONG_BODY);
  });

  it("reduced renders the full text immediately, no caret", () => {
    render(<Typewriter text="hello world" reduced />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });
});
