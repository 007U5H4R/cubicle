import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactCard } from "./ArtifactCard";
import { applyEvent, reset } from "@/lib/client/runStore";
import type { RunStreamEvent } from "@/lib/client/runStream";

afterEach(cleanup);
beforeEach(() => reset());

function seq() {
  let n = 0;
  return () => ++n;
}

describe("ArtifactCard", () => {
  it("shows the §10 title and the owning role's header color class per type", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.delta", payload: { type: "prd", text: "hello" } } as RunStreamEvent);
    render(<ArtifactCard type="prd" />);
    expect(screen.getByText("PRD")).toBeInTheDocument();
    const card = screen.getByTestId("artifact-card-prd");
    expect(card.innerHTML).toMatch(/bg-role-pm/);
  });

  it.each([
    ["prd", "PRD"],
    ["scan", "Competitor scan"],
    ["copy", "Landing copy"],
    ["plan", "Build plan"],
  ] as const)("renders the exact §10 title for type=%s", (type, title) => {
    render(<ArtifactCard type={type} />);
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it("copy button copies raw content_md via navigator.clipboard.writeText and shows a brief affirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.delta", payload: { type: "prd", text: "# Problem\n\nRaw markdown." } } as RunStreamEvent);

    render(<ArtifactCard type="prd" />);
    screen.getByRole("button", { name: /copy prd/i }).click();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Problem\n\nRaw markdown."));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("does not throw when clipboard is unavailable", () => {
    Object.assign(navigator, { clipboard: undefined });
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.delta", payload: { type: "prd", text: "x" } } as RunStreamEvent);
    render(<ArtifactCard type="prd" />);
    expect(() => screen.getByRole("button", { name: /copy prd/i }).click()).not.toThrow();
  });

  it("TC-059: grounded=false scan shows the exact unverified line at the top of the body", () => {
    // Mirrors real server behavior: lib/engine/deliver.ts's UNVERIFIED_PREFIX is prepended into
    // content_md server-side before any model text streams, so it is already the first content —
    // byte-for-byte the same literal as deliver.ts:45.
    const next = seq();
    applyEvent({
      run_id: "r1",
      seq: next(),
      type: "artifact.delta",
      payload: { type: "scan", text: "From memory, unverified — could not reach search.\n\n## Three competitors\n\nBody." },
    } as RunStreamEvent);
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.done", payload: { type: "scan", grounded: false, sources: [] } } as RunStreamEvent);

    render(<ArtifactCard type="scan" />);
    expect(screen.getByText(/From memory, unverified — could not reach search\./)).toBeInTheDocument();
  });

  it("TC-059: sources render as links when present (string and object shapes)", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.delta", payload: { type: "scan", text: "## Three competitors" } } as RunStreamEvent);
    applyEvent({
      run_id: "r1",
      seq: next(),
      type: "artifact.done",
      payload: { type: "scan", grounded: true, sources: ["https://a.example.com", { url: "https://b.example.com", title: "B Co" }] },
    } as RunStreamEvent);

    render(<ArtifactCard type="scan" />);
    const linkA = screen.getByRole("link", { name: "https://a.example.com" });
    expect(linkA).toHaveAttribute("href", "https://a.example.com");
    const linkB = screen.getByRole("link", { name: "B Co" });
    expect(linkB).toHaveAttribute("href", "https://b.example.com");
  });

  it("renders no Sources section when sources is empty", () => {
    const next = seq();
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.delta", payload: { type: "plan", text: "content" } } as RunStreamEvent);
    applyEvent({ run_id: "r1", seq: next(), type: "artifact.done", payload: { type: "plan", grounded: false, sources: [] } } as RunStreamEvent);
    render(<ArtifactCard type="plan" />);
    expect(screen.queryByText("Sources")).not.toBeInTheDocument();
  });
});
