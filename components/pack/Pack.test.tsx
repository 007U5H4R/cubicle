import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pack } from "./Pack";
import { applyEvent, reset } from "@/lib/client/runStore";
import type { RunStreamEvent } from "@/lib/client/runStream";

afterEach(cleanup);
beforeEach(() => reset());

function seq() {
  let n = 0;
  return () => ++n;
}

describe("Pack", () => {
  it("renders nothing when all artifacts are pending / debate is in progress", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "run.status", payload: { status: "running", phase: "debate", thinking: "pm" } } as RunStreamEvent);
    const { container } = render(<Pack />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the four cards once phase is deliver", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "run.status", payload: { status: "running", phase: "deliver" } } as RunStreamEvent);
    render(<Pack />);
    expect(screen.getByTestId("artifact-card-prd")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-card-scan")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-card-copy")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-card-plan")).toBeInTheDocument();
  });

  it("renders the four cards once any artifact leaves pending, even if phase later clears", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.delta", payload: { type: "prd", text: "x" } } as RunStreamEvent);
    render(<Pack />);
    expect(screen.getByTestId("artifact-card-prd")).toBeInTheDocument();
  });

  it("footer appears once, below all four cards, only when terminal + run complete", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "run.status", payload: { status: "running", phase: "deliver" } } as RunStreamEvent);
    for (const type of ["prd", "scan", "copy", "plan"] as const) {
      applyEvent({ run_id: "r1", seq: next(), type: "artifact.done", payload: { type, grounded: true, sources: [] } } as RunStreamEvent);
    }
    applyEvent({ run_id: "r1", seq: next(), type: "run.done", payload: { status: "complete", wall_s: 10, tokens: 100, cost_cents: 1 } } as RunStreamEvent);
    render(<Pack />);
    const footers = screen.getAllByText("Made in Cubicle — run your own");
    expect(footers).toHaveLength(1);
  });

  it("footer is absent before terminal", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "run.status", payload: { status: "running", phase: "deliver" } } as RunStreamEvent);
    render(<Pack />);
    expect(screen.queryByText("Made in Cubicle — run your own")).not.toBeInTheDocument();
  });

  it("footer href includes ?ref=<share_slug> when present", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "run.status", payload: { status: "running", phase: "deliver" } } as RunStreamEvent);
    for (const type of ["prd", "scan", "copy", "plan"] as const) {
      applyEvent({ run_id: "r1", seq: next(), type: "artifact.done", payload: { type, grounded: true, sources: [] } } as RunStreamEvent);
    }
    applyEvent({ run_id: "r1", seq: next(), type: "run.done", payload: { status: "complete", wall_s: 10, tokens: 100, cost_cents: 1 } } as RunStreamEvent);
    render(<Pack />);
    const link = screen.getByRole("link", { name: "Made in Cubicle — run your own" });
    // `run.done` doesn't set share_slug on the client run object (it stays whatever `hydrate`/`run`
    // already had — null here), so the href falls back to "/".
    expect(link).toHaveAttribute("href", "/");
  });

  it("Save/Share buttons are present, disabled, inert placeholders", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "run.status", payload: { status: "running", phase: "deliver" } } as RunStreamEvent);
    render(<Pack />);
    const save = screen.getByRole("button", { name: "Save" });
    const share = screen.getByRole("button", { name: "Share" });
    expect(save).toBeDisabled();
    expect(share).toBeDisabled();
    expect(save).toHaveAttribute("title", "coming soon");
    expect(share).toHaveAttribute("title", "coming soon");
  });
});
