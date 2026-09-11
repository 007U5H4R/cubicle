import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(cleanup);

// TC-096 (security) — artifact markdown is model-generated, user-influenced text. `rehypeSanitize`
// must strip any HTML-like content react-markdown surfaces so nothing executes.
describe("Markdown", () => {
  it("TC-096: strips a <script> tag — no script element mounts, no alert node renders", () => {
    render(<Markdown>{"before\n\n<script>alert(1)</script>\n\nafter"}</Markdown>);
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText("before")).toBeInTheDocument();
    expect(screen.getByText("after")).toBeInTheDocument();
  });

  it("TC-096: strips an onerror handler from an <img> tag", () => {
    const { container } = render(<Markdown>{'<img src="x" onerror="alert(1)">'}</Markdown>);
    const img = container.querySelector("img");
    // rehype-sanitize either drops the whole node or strips the disallowed `onerror` attribute —
    // either way, no `onerror` attribute may reach the DOM.
    if (img) {
      expect(img.getAttribute("onerror")).toBeNull();
    } else {
      expect(container.innerHTML).not.toMatch(/onerror/i);
    }
  });

  it("does not render an <iframe> tag written into the markdown body", () => {
    render(<Markdown>{'before\n\n<iframe src="https://evil.example"></iframe>\n\nafter'}</Markdown>);
    // react-markdown@9 without rehype-raw never turns markdown-embedded HTML into live elements;
    // rehype-sanitize belt-and-suspenders drops it even if a future plugin change enabled raw HTML.
    expect(document.querySelector("iframe")).not.toBeInTheDocument();
  });

  it("renders a GFM table inside its own overflow-x:auto wrapper", () => {
    const table = "| Name | Gap |\n| --- | --- |\n| Acme | slow |\n";
    const { container } = render(<Markdown>{table}</Markdown>);
    const tableEl = container.querySelector("table");
    expect(tableEl).toBeInTheDocument();
    const wrapper = tableEl!.parentElement;
    expect(wrapper?.style.overflowX).toBe("auto");
  });

  it("renders links with rel=noopener noreferrer", () => {
    render(<Markdown>{"[link](https://example.com)"}</Markdown>);
    const link = screen.getByRole("link", { name: "link" });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
