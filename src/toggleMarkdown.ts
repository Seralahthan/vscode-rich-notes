/**
 * Toggle-list (collapsible) markdown helpers, shared by the webview editor and
 * the host Notion push path.
 *
 * Representation: a toggle is HTML `<details>`/`<summary>` — the same form Notion
 * exports on pull (via notion-to-md) and the standard collapsible in GitHub/VS
 * Code markdown:
 *
 *   <details>
 *   <summary>Summary text</summary>
 *
 *   body markdown (may contain nested toggles)
 *
 *   </details>
 *
 * These functions are pure string transforms (no editor or Notion deps) so they
 * can run in both the browser bundle and the extension host.
 */

export interface ToggleSegment {
  type: "toggle";
  summary: string;
  body: string;
}
export interface MarkdownSegment {
  type: "md";
  text: string;
}
export type Segment = ToggleSegment | MarkdownSegment;

const OPEN_RE = /<details\b[^>]*>/gi;
const OPEN_OR_CLOSE_RE = /<details\b[^>]*>|<\/details\s*>/gi;
const SUMMARY_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

/**
 * Split markdown into an ordered list of plain-markdown and top-level toggle
 * segments. Nested toggles stay inside a segment's `body` (parse recursively).
 * Depth-aware, so a `</details>` belonging to a nested toggle doesn't close an
 * outer one.
 */
export function splitToggles(md: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  while (i < md.length) {
    OPEN_RE.lastIndex = i;
    const open = OPEN_RE.exec(md);
    if (!open) {
      if (i < md.length) {
        segments.push({ type: "md", text: md.slice(i) });
      }
      break;
    }
    if (open.index > i) {
      segments.push({ type: "md", text: md.slice(i, open.index) });
    }
    // Find the matching close, tracking nesting depth.
    let depth = 1;
    let close = -1;
    OPEN_OR_CLOSE_RE.lastIndex = open.index + open[0].length;
    let tag: RegExpExecArray | null;
    while ((tag = OPEN_OR_CLOSE_RE.exec(md))) {
      if (/^<\//.test(tag[0])) {
        depth--;
        if (depth === 0) {
          close = tag.index;
          break;
        }
      } else {
        depth++;
      }
    }
    if (close === -1) {
      // Unbalanced — treat the remainder as plain markdown rather than lose it.
      segments.push({ type: "md", text: md.slice(open.index) });
      break;
    }
    const inner = md.slice(open.index + open[0].length, close);
    const sm = SUMMARY_RE.exec(inner);
    const summary = sm ? sm[1].trim() : "";
    const body = (sm ? inner.slice(sm.index + sm[0].length) : inner).trim();
    segments.push({ type: "toggle", summary, body });
    i = close + tag![0].length;
  }
  return segments;
}

/** True if the markdown contains at least one `<details>` toggle. */
export function hasToggle(md: string): boolean {
  OPEN_RE.lastIndex = 0;
  return OPEN_RE.test(md);
}

/**
 * Rewrite every toggle into the canonical blank-line-delimited form (blank lines
 * around the summary and body). This is what the editor parses and what we write
 * to disk: with the blank lines, a CommonMark parser sees the `<details>` opener,
 * the body blocks, and the `</details>` closer as separate nodes — the compact
 * form Notion exports would otherwise glue the first body block onto the opener.
 * Recursive, so nested toggles are normalized too.
 */
export function normalizeToggles(md: string): string {
  if (!hasToggle(md)) {
    return md;
  }
  const segments = splitToggles(md);
  let out = "";
  for (const seg of segments) {
    if (seg.type === "md") {
      out += seg.text;
      continue;
    }
    const inner = normalizeToggles(seg.body);
    if (out && !/\n\n$/.test(out)) {
      out = out.replace(/\n*$/, "\n\n");
    }
    out += `<details>\n<summary>${seg.summary}</summary>\n\n${inner}\n\n</details>\n\n`;
  }
  // Collapse the blank runs the joins may have introduced.
  return out.replace(/\n{3,}/g, "\n\n");
}
