/**
 * A source-line gutter for the block editor. Each top-level block is labelled
 * with the line it starts on in the actual `.md` file, so a line reference (a
 * diff, a linter hit, a conflict) can be located in the rich view.
 *
 * The editor is block-based, so numbers are sparse (one per block start, not one
 * per visual row) and computed from the exact text that is written to disk:
 * `canonicalizeForFile(serializer(doc))` — the file body — plus the frontmatter
 * line offset the host supplies (so linked notes with a `notion:` block still
 * match the file).
 *
 * Mapping is anchor-based: each block is serialized on its own, canonicalized the
 * same way, and its first line is matched forward in the whole-body text. Both
 * sides are canonicalized identically, so the match is exact in practice; a
 * forward cursor keeps duplicate lines in order. Recompute is driven from the
 * debounced edit path (see index.tsx), never per keystroke.
 */
import { $prose } from "@milkdown/kit/utils";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { canonicalizeForFile } from "../markdown";

const key = new PluginKey("rnLineNumbers");

// Number of file lines before the body begins (the YAML frontmatter block). Set
// by the host with each content push.
let lineOffset = 0;
let enabled = true;
export function setLineOffset(n: number): void {
  lineOffset = Number.isFinite(n) ? n : 0;
}
export function setLineNumbersEnabled(on: boolean): void {
  enabled = on;
}

export const lineNumbers = $prose(() => {
  return new Plugin({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, old) => {
        const meta = tr.getMeta(key);
        if (meta) {
          return meta as DecorationSet;
        }
        // Keep decorations attached to their blocks between recomputes.
        return (old as DecorationSet).map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => key.getState(state) as DecorationSet,
    },
  });
});

const firstContentLine = (md: string): string => {
  for (const l of md.replace(/\n+$/, "").split("\n")) {
    if (l.trim() !== "") {
      return l;
    }
  }
  return "";
};

/**
 * Recompute the gutter for the current document and push it into the plugin via
 * a meta-only transaction (no doc change, so it never re-triggers an edit).
 */
export function recomputeLineNumbers(ctx: Ctx): void {
  const view = ctx.get(editorViewCtx);
  if (!enabled) {
    view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty));
    return;
  }
  const serializer = ctx.get(serializerCtx);
  const doc = view.state.doc;
  const bodyLines = canonicalizeForFile(serializer(doc)).replace(/\n+$/, "").split("\n");

  const decos: Decoration[] = [];
  let cursor = 0;
  doc.forEach((node, offset) => {
    let blockLines: string[];
    try {
      const single = view.state.schema.topNodeType.create(null, node);
      blockLines = canonicalizeForFile(serializer(single)).replace(/\n+$/, "").split("\n");
    } catch {
      blockLines = [];
    }
    const anchor = firstContentLine(blockLines.join("\n"));
    let found = -1;
    if (anchor) {
      for (let k = cursor; k < bodyLines.length; k++) {
        if (bodyLines[k] === anchor) {
          found = k;
          break;
        }
      }
    }
    if (found === -1) {
      found = Math.min(cursor, Math.max(bodyLines.length - 1, 0));
    }
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, {
        "data-rn-line": String(found + 1 + lineOffset),
      })
    );
    cursor = found + Math.max(blockLines.length, 1);
  });

  view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(doc, decos)));
}
