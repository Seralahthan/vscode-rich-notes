/**
 * A mid-sentence "/" command menu (Notion-style) for INLINE insertions.
 *
 * Crepe's built-in slash menu only triggers when the block text *starts* with
 * "/" (start of an empty line) and inserts block-level content. This plugin adds
 * the complementary case: typing "/" after a space, inside a paragraph/heading,
 * opens a menu of things that make sense *in the middle of text* — an inline
 * equation, inline code, or an image/video/audio/file link. It never inserts a
 * block (no headings/lists/quotes here — nobody adds those mid-sentence).
 *
 * The two menus never overlap: Crepe fires when "/" is at offset 0, this fires
 * only when "/" is preceded by whitespace. Selecting a command deletes the
 * "/query" and inserts inline content at the cursor. Escape (or no match)
 * dismisses and leaves the "/" as literal text.
 */
import { $prose } from "@milkdown/kit/utils";
import { Plugin, TextSelection, NodeSelection } from "@milkdown/kit/prose/state";

interface Trigger {
  query: string;
  from: number; // position of the "/"
  to: number; // cursor position
}

interface Cmd {
  label: string;
  keywords: string;
  apply: (view: any, range: Trigger) => void;
}

/**
 * Inline equation: delete the "/query", insert a math_inline node, and node-select
 * it so Crepe's inline-LaTeX editor tooltip opens (it shows only for a
 * NodeSelection on a math_inline node).
 *
 * The node is seeded with a single space, NOT empty: Crepe's tooltip does
 * `schema.text(node.attrs.value)` in its shouldShow, which THROWS on an empty
 * string ("Empty text nodes are not allowed") — the throw crashes the tooltip so
 * it never appears (this is why an empty node showed nothing). A space is a valid
 * text node and katex ignores leading whitespace, so it renders like an empty
 * formula. No view.focus() afterwards — that would collapse the NodeSelection.
 */
function insertInlineEquation(view: any, range: Trigger): void {
  const { state } = view;
  const mathType = state.schema.nodes.math_inline;
  if (!mathType) {
    return;
  }
  const at = range.from;
  let tr = state.tr.delete(range.from, range.to);
  tr = tr.insert(at, mathType.create({ value: " " }));
  tr = tr.setSelection(NodeSelection.create(tr.doc, at));
  view.dispatch(tr.scrollIntoView());
}

/**
 * Inline code: insert a "code" placeholder carrying the inlineCode mark and
 * select it, so it's visible and the user can type over it (stored mark keeps
 * the replacement styled as code).
 */
function insertInlineCode(view: any, range: Trigger): void {
  const { state } = view;
  const mark = state.schema.marks.inlineCode;
  const at = range.from;
  const placeholder = "code";
  let tr = state.tr.delete(range.from, range.to).insertText(placeholder, at);
  if (mark) {
    tr = tr
      .addMark(at, at + placeholder.length, mark.create())
      .setSelection(TextSelection.create(tr.doc, at, at + placeholder.length))
      .setStoredMarks([mark.create()]);
  } else {
    tr = tr.setSelection(TextSelection.create(tr.doc, at + placeholder.length));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Insert inline linked text (image/video/audio/file) at the cursor. */
function insertInlineLink(view: any, range: Trigger, label: string, href: string): void {
  const { state } = view;
  const link = state.schema.marks.link;
  const at = range.from;
  let tr = state.tr.delete(range.from, range.to).insertText(label, at);
  if (link) {
    tr = tr.addMark(at, at + label.length, link.create({ href })).removeStoredMark(link);
  }
  tr = tr.setSelection(TextSelection.create(tr.doc, at + label.length));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// Inline-only commands. Media items insert a plain inline link (no preview/iframe,
// since it lives in the middle of a line).
const COMMANDS: Cmd[] = [
  { label: "Inline equation", keywords: "math latex formula equation", apply: (v, r) => insertInlineEquation(v, r) },
  { label: "Inline code", keywords: "code monospace inline", apply: (v, r) => insertInlineCode(v, r) },
  { label: "Image link", keywords: "picture photo img image", apply: (v, r) => insertInlineLink(v, r, "image", "https://") },
  { label: "Video link", keywords: "youtube media video", apply: (v, r) => insertInlineLink(v, r, "video", "https://") },
  { label: "Audio link", keywords: "sound music audio", apply: (v, r) => insertInlineLink(v, r, "audio", "https://") },
  { label: "File link", keywords: "attachment document file", apply: (v, r) => insertInlineLink(v, r, "file", "https://") },
];

function detect(view: any): Trigger | null {
  const { selection } = view.state;
  if (!(selection.empty && selection instanceof TextSelection)) {
    return null;
  }
  const $from = selection.$from;
  const name = $from.parent.type.name;
  if (name !== "paragraph" && name !== "heading") {
    return null;
  }
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, " ");
  // "/" preceded by whitespace (mid-sentence) — NOT at offset 0, which Crepe owns.
  const m = /\s\/([^/\n]*)$/.exec(textBefore);
  if (!m) {
    return null;
  }
  const query = m[1];
  if (query.startsWith(" ")) {
    return null; // "/ " is not a command
  }
  return { query, from: $from.pos - query.length - 1, to: $from.pos };
}

function filterCommands(query: string): Cmd[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return COMMANDS;
  }
  return COMMANDS.filter(
    (c) => c.label.toLowerCase().includes(q) || c.keywords.includes(q)
  );
}

export const slashMenu = $prose(() => {
  let active: { trigger: Trigger; items: Cmd[] } | null = null;
  let selected = 0;
  let dom: HTMLElement | null = null;

  const ensureDom = (): HTMLElement => {
    if (!dom) {
      dom = document.createElement("div");
      dom.className = "rn-slash";
      dom.setAttribute("role", "listbox");
      document.body.appendChild(dom);
    }
    return dom;
  };

  const hide = () => {
    active = null;
    if (dom) {
      dom.style.display = "none";
    }
  };

  const runSelected = (view: any) => {
    if (!active || !active.items.length) {
      return;
    }
    const cmd = active.items[Math.min(selected, active.items.length - 1)];
    const range = active.trigger;
    hide();
    cmd.apply(view, range);
  };

  const render = (view: any) => {
    if (!active) {
      hide();
      return;
    }
    const el = ensureDom();
    el.style.display = "block";
    el.innerHTML = "";
    active.items.forEach((cmd, i) => {
      const item = document.createElement("div");
      item.className = "rn-slash-item" + (i === selected ? " selected" : "");
      item.textContent = cmd.label;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selected = i;
        runSelected(view);
      });
      item.addEventListener("mousemove", () => {
        if (selected !== i) {
          selected = i;
          render(view);
        }
      });
      el.appendChild(item);
    });
    const coords = view.coordsAtPos(active.trigger.from);
    el.style.left = `${Math.round(coords.left)}px`;
    el.style.top = `${Math.round(coords.bottom + 4)}px`;
  };

  return new Plugin({
    view: (view: any) => {
      // Handle menu navigation in the CAPTURE phase, before ProseMirror's own
      // keymap (Enter→split, arrows→move cursor) can consume the key. Using
      // props.handleKeyDown doesn't work: Crepe's base keymap is earlier in the
      // plugin order and wins Enter/Arrow first.
      const onKeyDown = (event: KeyboardEvent) => {
        if (!active) {
          return;
        }
        const key = event.key;
        if (
          key !== "ArrowDown" &&
          key !== "ArrowUp" &&
          key !== "Enter" &&
          key !== "Tab" &&
          key !== "Escape"
        ) {
          return; // let typing through so the query keeps filtering
        }
        // Prevent BEFORE acting, so even if an action throws, the key never leaks
        // to ProseMirror (which would e.g. split the line on Enter).
        event.preventDefault();
        event.stopImmediatePropagation();
        const len = active.items.length;
        if (key === "ArrowDown") {
          selected = (selected + 1) % len;
          render(view);
        } else if (key === "ArrowUp") {
          selected = (selected - 1 + len) % len;
          render(view);
        } else if (key === "Enter" || key === "Tab") {
          runSelected(view);
        } else if (key === "Escape") {
          hide();
        }
      };
      document.addEventListener("keydown", onKeyDown, true);

      return {
        update: () => {
          const trigger = detect(view);
          if (!trigger) {
            if (active) {
              hide();
            }
            return;
          }
          const items = filterCommands(trigger.query);
          if (!items.length) {
            hide();
            return;
          }
          const wasActive = active;
          active = { trigger, items };
          if (!wasActive) {
            selected = 0;
          } else {
            selected = Math.min(selected, items.length - 1);
          }
          render(view);
        },
        destroy: () => {
          document.removeEventListener("keydown", onKeyDown, true);
          if (dom) {
            dom.remove();
            dom = null;
          }
        },
      };
    },
  });
});
