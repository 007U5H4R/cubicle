"use client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

// TKT-14 Dispatch B — safe markdown renderer for (user-influenced, model-generated) artifact
// content. react-markdown@9 never renders raw HTML by default (no `rehype-raw`, ever) and
// `rehypeSanitize` strips any HTML-like nodes GFM/remark still surfaces (e.g. an inline `<script>`
// or `<img onerror>` written into the markdown source) — this is the TC-096 security acceptance
// criterion. The competitor-scan table is the only artifact content wide enough to overflow at
// 375px, so `table` gets its own `overflow-x:auto` wrapper — it must never cause page-level
// horizontal scroll.

const components: Components = {
  table: ({ children }) => (
    <div style={{ overflowX: "auto" }}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border text-left">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1.5 font-semibold text-text">{children}</th>,
  td: ({ children }) => <td className="border-t border-border px-2 py-1.5 align-top text-text">{children}</td>,
  a: ({ children, ...props }) => (
    <a {...props} rel="noopener noreferrer" target="_blank" className="text-brand-500 underline underline-offset-2">
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="mt-4 text-lg font-bold text-text first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 text-base font-bold text-text first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 text-sm font-semibold text-text first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mt-2 text-sm text-text first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc pl-5 text-sm text-text first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal pl-5 text-sm text-text first:mt-0">{children}</ol>,
  li: ({ children }) => <li className="mt-1 first:mt-0">{children}</li>,
};

export interface MarkdownProps {
  children: string;
  className?: string;
}

/** Renders artifact `content_md` (or any other model-generated markdown) through the sanitized
 * pipeline. Never pass `rehype-raw` in here — TC-096 depends on raw HTML staying unrendered. */
export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
