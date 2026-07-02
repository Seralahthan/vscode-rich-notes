/**
 * Canonicalize markdown so two stylistically-different but equivalent documents
 * compare/diff cleanly. Our local export uses "*" loose lists; notion-to-md
 * produces "-" tight lists — without this every list line looks changed.
 *
 * - list markers "*"/"+" -> "-"
 * - drop blank lines that sit strictly between two list items (loose -> tight)
 * - normalize nested-list indentation to 2 spaces per depth (notion-to-md uses
 *   4, BlockNote uses 2 — otherwise every nested line looks changed)
 * - strip trailing whitespace, collapse blank runs, trim ends
 */
export function canonicalizeMarkdown(md: string): string {
  const isListItem = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isBlank = (l: string) => l.trim() === "";

  const lines = md
    .replace(/[ \t]+$/gm, "")
    .split("\n")
    .map((l) => l.replace(/^(\s*)[*+](\s+)/, "$1-$2"))
    // Drop empty list items ("- " with no text): Notion doesn't store them, so
    // they never survive a round-trip and otherwise cause false differences.
    .filter((l) => !/^\s*([-*+]|\d+[.)])\s*$/.test(l));

  const tight: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) {
      const prev = tight[tight.length - 1];
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) {
        j++;
      }
      const next = j < lines.length ? lines[j] : null;
      if (prev !== undefined && next !== null && isListItem(prev) && isListItem(next)) {
        continue;
      }
    }
    tight.push(lines[i]);
  }

  return normalizeListIndent(tight).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Re-indent list items to 2 spaces per nesting depth. Depth is derived from the
 * relative indentation of successive items (not absolute widths), so both
 * 2-space (BlockNote) and 4-space (notion-to-md) inputs collapse to the same
 * canonical form.
 */
function normalizeListIndent(lines: string[]): string[] {
  const STEP = 2;
  const stack: number[] = []; // indent width at each open depth level
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)((?:[-*+]|\d+[.)])\s.*)$/);
    if (!m) {
      // A non-list line at column 0 closes any open list.
      if (line.trim() !== "" && !/^\s/.test(line)) {
        stack.length = 0;
      }
      out.push(line);
      continue;
    }
    const indent = m[1].length;
    while (stack.length && indent < stack[stack.length - 1]) {
      stack.pop();
    }
    if (!stack.length || indent > stack[stack.length - 1]) {
      stack.push(indent);
    }
    const depth = stack.length - 1;
    out.push(" ".repeat(depth * STEP) + m[2]);
  }
  return out;
}

/**
 * Notion in-block line breaks (Shift+Enter) serialize as a single "\n", which
 * CommonMark/BlockNote render as a space (lines merge). Split such soft breaks
 * between two plain top-level text lines into paragraph breaks so they stay on
 * separate lines. Leaves blank-separated paragraphs and structural lines (lists,
 * headings, quotes, code fences, tables, indented continuations) untouched.
 */
export function splitSoftBreaks(md: string): string {
  const structural = (l: string) =>
    l.trim() === "" || /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```)/.test(l);
  const plain = (l: string) =>
    l.trim() !== "" && !/^\s/.test(l) && !structural(l);

  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const next = lines[i + 1];
    if (next !== undefined && plain(lines[i]) && plain(next)) {
      out.push(""); // split the soft break into two paragraphs
    }
  }
  return out.join("\n");
}
