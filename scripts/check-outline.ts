import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";

// TKT-17 — CI guard for Design.md §5's "no `outline: none` without a visible replacement" rule.
// Scans CSS/TSX/TS source for bare `outline: none` (or `outline:none`, including quoted inline-style
// values like `outline: "none"`) and fails any occurrence that has no `box-shadow`/`outline-color`
// replacement within a small line window — the pattern this codebase already uses at the single real
// site (`:focus-visible { outline: none; box-shadow: var(--focus-ring); }` in app/globals.css).

export interface Violation {
  file: string;
  line: number;
  snippet: string;
}

const TARGET_EXT = new Set([".css", ".ts", ".tsx"]);
const CONTEXT_WINDOW = 4; // lines of surrounding context checked for a replacement focus style

const OUTLINE_NONE_RE = /outline\s*:\s*(["'`]?)\s*none\s*\1/i;
const REPLACEMENT_RE = /box-shadow|boxShadow|outline-color|outlineColor/i;

/** Finds bare `outline: none` occurrences in `source` lacking a nearby focus-visible replacement. */
export function findViolations(source: string, file = "<inline>"): Violation[] {
  const lines = source.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!OUTLINE_NONE_RE.test(lines[i])) continue;
    const start = Math.max(0, i - CONTEXT_WINDOW);
    const end = Math.min(lines.length, i + CONTEXT_WINDOW + 1);
    const windowText = lines.slice(start, end).join("\n");
    if (!REPLACEMENT_RE.test(windowText)) {
      violations.push({ file, line: i + 1, snippet: lines[i].trim() });
    }
  }

  return violations;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TARGET_EXT.has(extname(full))) out.push(full);
  }
  return out;
}

/** Runs `findViolations` over every CSS/TS/TSX file under each root directory. */
export function checkTree(roots: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, "utf8");
      violations.push(...findViolations(source, file));
    }
  }
  return violations;
}

// Path (not string) comparison — repo paths containing spaces ("E Drive", "Case Study 6") would
// otherwise mismatch a naive `file://${process.argv[1]}` template against the percent-encoded
// import.meta.url, silently skipping the CLI branch.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const violations = checkTree(["app", "components"]);
  if (violations.length > 0) {
    console.error("outline guard: bare `outline: none` without a focus-visible replacement:");
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    process.exit(1);
  }
  console.log("outline guard: clean (app/** + components/** scanned).");
}
