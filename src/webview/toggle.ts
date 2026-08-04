/**
 * A "toggle list" (collapsible) block for Milkdown/Crepe — Notion's toggle.
 *
 * Round-trip: a toggle is HTML `<details>`/`<summary>`, the form Notion exports
 * on pull and a standard collapsible in GitHub/VS Code markdown:
 *
 *   <details>
 *   <summary>Summary</summary>
 *
 *   body blocks…
 *
 *   </details>
 *
 * Schema: two nodes — `toggle` (content: a `toggle_summary` then block content)
 * and `toggle_summary` (inline content). Both the summary and the body edit
 * natively (no attribute syncing). A node view adds a collapse twistie; the open
 * state is editor-only (never serialized), so collapsing never dirties the file.
 *
 * Parsing relies on the markdown arriving in the canonical blank-line form (see
 * normalizeToggles in ../toggleMarkdown, applied before the editor parses): the
 * `<details>`+`<summary>` opener, the body blocks, and the `</details>` closer
 * land as separate mdast nodes, which the remark transform below folds into a
 * `toggle` node. Depth-aware, so nested toggles convert correctly.
 */
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Ctx } from "@milkdown/kit/ctx";

const NODE = "toggle";
const SUMMARY = "toggle_summary";

const noRunner = { match: () => false, runner: () => {} } as any;

// --- Schema -----------------------------------------------------------------

export const toggleSummarySchema = $nodeSchema(SUMMARY, () => ({
  content: "inline*",
  marks: "",
  defining: true,
  parseDOM: [{ tag: `div[data-${SUMMARY}]` }],
  toDOM: () => ["div", { [`data-${SUMMARY}`]: "true", class: "rn-toggle-summary" }, 0],
  // Only ever produced/consumed as a child of `toggle`, so it has no standalone
  // markdown representation.
  parseMarkdown: noRunner,
  toMarkdown: noRunner,
}));

export const toggleSchema = $nodeSchema(NODE, () => ({
  group: "block",
  content: `${SUMMARY} block+`,
  defining: true,
  isolating: true,
  attrs: { open: { default: true } },
  parseDOM: [
    {
      tag: `div[data-${NODE}]`,
      getAttrs: (dom: HTMLElement | string) => ({
        open: typeof dom === "string" ? true : dom.getAttribute("data-open") !== "false",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    { [`data-${NODE}`]: "true", "data-open": String(node.attrs.open !== false) },
    0,
  ],
  // mdast `toggle` (from the remark transform) -> prose node.
  parseMarkdown: {
    match: (node) => node.type === "toggle",
    runner: (state, node, type) => {
      const summaryType = state.schema.nodes[SUMMARY];
      state.openNode(type, { open: true });
      state.openNode(summaryType);
      const summary = (node as { summary?: string }).summary ?? "";
      if (summary) {
        state.addText(summary);
      }
      state.closeNode();
      const children = ((node as { children?: any[] }).children ?? []) as any[];
      if (children.length) {
        state.next(children as any);
      } else {
        state.openNode(state.schema.nodes.paragraph);
        state.closeNode();
      }
      state.closeNode();
    },
  },
  // prose node -> `<details>` html opener + body blocks + `</details>` closer,
  // serialized as sibling nodes so remark-stringify puts the blank lines that
  // keep the body parseable as markdown.
  toMarkdown: {
    match: (node) => node.type.name === NODE,
    runner: (state, node) => {
      const summary = node.childCount > 0 ? node.child(0).textContent : "";
      state.addNode("html", undefined, `<details>\n<summary>${summary}</summary>`);
      for (let i = 1; i < node.childCount; i++) {
        state.next(node.child(i));
      }
      state.addNode("html", undefined, "</details>");
    },
  },
}));

// --- Remark: fold `<details>`…`</details>` mdast nodes into a `toggle` node ----

const isOpener = (n: any) =>
  n?.type === "html" && /<details\b/i.test(n.value) && !/<\/details/i.test(n.value);
const isCloser = (n: any) => n?.type === "html" && /^\s*<\/details\s*>/i.test(n.value);
const summaryOf = (v: string) =>
  (/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(v)?.[1] ?? "").trim();

function foldToggles(nodes: any[]): any[] {
  const out: any[] = [];
  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (isOpener(n)) {
      const summary = summaryOf(n.value);
      let depth = 1;
      let j = i + 1;
      const body: any[] = [];
      for (; j < nodes.length; j++) {
        const m = nodes[j];
        if (isOpener(m)) {
          depth++;
          body.push(m);
        } else if (isCloser(m)) {
          depth--;
          if (depth === 0) {
            break;
          }
          body.push(m);
        } else {
          body.push(m);
        }
      }
      out.push({ type: "toggle", summary, children: foldToggles(body) });
      i = j + 1;
    } else {
      if (Array.isArray(n?.children)) {
        n.children = foldToggles(n.children);
      }
      out.push(n);
      i++;
    }
  }
  return out;
}

export const toggleRemark = $remark(
  "rnToggle",
  () => () => (tree: { children?: any[] }) => {
    if (Array.isArray(tree.children)) {
      tree.children = foldToggles(tree.children);
    }
  }
);

// --- Node view: collapse twistie over the natively-edited summary/body --------

// Chevron; rotates via CSS when the toggle is open.
const ICON_TWIST =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 6l6 6-6 6z"/></svg>';

export function toggleView() {
  return $view(toggleSchema.node, (): any => {
    return (node: any, view: any, getPos: () => number | undefined) => {
      const dom = document.createElement("div");
      dom.className = "rn-toggle";
      dom.classList.toggle("open", node.attrs.open !== false);

      const twist = document.createElement("button");
      twist.type = "button";
      twist.className = "rn-toggle-twist";
      twist.contentEditable = "false";
      twist.setAttribute("aria-label", "Toggle");
      twist.innerHTML = ICON_TWIST;
      twist.addEventListener("mousedown", (e) => e.preventDefault());
      twist.addEventListener("click", (e) => {
        e.preventDefault();
        const pos = getPos();
        if (pos == null) {
          return;
        }
        const cur = view.state.doc.nodeAt(pos);
        const open = cur?.attrs.open !== false;
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { open: !open }));
      });

      const content = document.createElement("div");
      content.className = "rn-toggle-inner";

      dom.append(twist, content);

      return {
        dom,
        contentDOM: content,
        update: (updated: any) => {
          if (updated.type.name !== NODE) {
            return false;
          }
          dom.classList.toggle("open", updated.attrs.open !== false);
          return true;
        },
        // The twistie handles its own click; everything else is normal editing.
        ignoreMutation: (m: MutationRecord) =>
          m.type === "attributes" && m.target === dom,
      };
    };
  });
}

// --- Slash-menu action ------------------------------------------------------

/** Clear the "/query" and insert an empty toggle (empty summary + paragraph). */
export function insertToggle(ctx: Ctx): void {
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const type = state.schema.nodes[NODE];
  if (!type) {
    return;
  }
  const node = type.createAndFill({ open: true });
  if (!node) {
    return;
  }
  const from = state.selection.from;
  const tr = state.tr.replaceSelectionWith(node);
  // Put the cursor inside the summary (from+2 steps into the toggle then the
  // summary node). Best-effort — clamp so an out-of-range position can't throw.
  try {
    tr.setSelection(TextSelection.create(tr.doc, Math.min(from + 2, tr.doc.content.size)));
  } catch {
    /* selection is best-effort */
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}
