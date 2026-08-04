import { Crepe } from "@milkdown/crepe";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { undoCommand, redoCommand } from "@milkdown/kit/plugin/history";
import {
  clearTextInCurrentBlockCommand,
  wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import type { Ctx } from "@milkdown/kit/ctx";
import { canonicalizeForFile } from "../markdown";
import {
  videoEmbedSchema,
  videoEmbedRemark,
  videoEmbedView,
  insertVideoEmbed,
} from "./videoEmbed";
import { bareLinkSync } from "./linkSync";
import {
  toggleSchema,
  toggleSummarySchema,
  toggleRemark,
  toggleView,
  insertToggle,
} from "./toggle";
import { normalizeToggles } from "../toggleMarkdown";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./theme.css";

// Open a URL in the user's browser / write to the clipboard via the extension
// host (webview clipboard access is unreliable).
const openExternal = (url: string) => vscode.postMessage({ type: "openExternal", url });
const copyText = (text: string) => vscode.postMessage({ type: "copyText", text });

// Minimal inline SVG icons (Crepe menu icons are raw SVG strings).
const ICON_VIDEO =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
const ICON_AUDIO =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12z"/></svg>';
const ICON_FILE =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5z"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
const ICON_TOGGLE =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 6l6 6-6 6V6z"/><path d="M2 4h2v16H2z" opacity="0"/></svg>';
// "H1"/"H2"/"H3" labels for the selection toolbar's heading controls.
// The `rn-heading-tool` class is a CSS hook: the selection toolbar hides these
// heading buttons unless the caret is inside a heading (see headingContext +
// theme.css). DOMPurify (Crepe's icon sanitizer) preserves the class.
const headingIcon = (level: number) =>
  `<svg class="rn-heading-tool" viewBox="0 0 24 24" width="24" height="24"><text x="12" y="17" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor" font-family="inherit">H${level}</text></svg>`;

/** The heading level of the block the selection is in, or 0 for a paragraph. */
function currentHeadingLevel(ctx: Ctx): number {
  const node = ctx.get(editorViewCtx).state.selection.$from.parent;
  return node?.type.name === "heading" ? (node.attrs.level as number) ?? 0 : 0;
}

/** A selection-toolbar item that toggles the current block to heading `level`. */
function headingToolbarItem(level: number) {
  return {
    icon: headingIcon(level),
    active: (ctx: Ctx) => currentHeadingLevel(ctx) === level,
    // Clicking the active level again turns the heading back into plain text
    // (level < 1 → paragraph), matching the previous editor's behaviour.
    onRun: (ctx: Ctx) => {
      const target = currentHeadingLevel(ctx) === level ? 0 : level;
      ctx.get(commandsCtx).call(wrapInHeadingCommand.key, target);
    },
  };
}

/**
 * Insert a markdown link at the cursor (clearing the "/query" first). Notion
 * represents File/Video/Audio blocks as plain markdown links, so these stay
 * clean, portable markdown that round-trips to Notion. The user edits the URL
 * via Milkdown's link tooltip after inserting.
 */
function insertLink(ctx: Ctx, label: string, href: string): void {
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const linkMark = state.schema.marks.link;
  const from = state.selection.from;
  const tr = state.tr.insertText(label, from);
  if (linkMark) {
    tr.addMark(from, from + label.length, linkMark.create({ href }));
  }
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// Minimal typing for the VS Code webview bridge.
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};
const vscode = acquireVsCodeApi();

const rootEl = () => document.getElementById("root")!;

let crepe: Crepe | null = null;
// True while we apply content pushed from the host, so the resulting
// markdownUpdated events are not echoed back as user edits.
let applyingRemote = false;
// The canonical markdown the editor currently serializes to (change detection).
let lastSerialized: string | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

/** The editor's current content, canonicalized to the on-disk form. */
function currentMarkdown(): string {
  return crepe ? canonicalizeForFile(crepe.getMarkdown()) : "";
}

/** Debounced push of a user edit back to the host. */
function scheduleEdit(): void {
  if (debounce) {
    clearTimeout(debounce);
  }
  debounce = setTimeout(() => {
    const markdown = currentMarkdown();
    if (markdown === lastSerialized) {
      return; // nothing changed
    }
    lastSerialized = markdown;
    vscode.postMessage({ type: "edit", text: markdown });
  }, 250);
}

/** (Re)create the Crepe editor with the given markdown as its content. */
async function mountCrepe(markdown: string): Promise<void> {
  if (crepe) {
    await crepe.destroy();
    crepe = null;
  }
  rootEl().innerHTML = "";
  const c = new Crepe({
    root: rootEl(),
    // Canonicalize toggles to the blank-line <details> form so the remark fold
    // sees a clean opener/body/closer regardless of how they were stored.
    defaultValue: normalizeToggles(markdown),
    featureConfigs: {
      // Code blocks work out of the box (Crepe ships a copy button that reaches
      // the OS clipboard); we only swap its default emoji icon for an SVG that
      // matches the rest of the toolbar.
      [Crepe.Feature.CodeMirror]: {
        copyIcon: ICON_COPY,
      },
      // Selection toolbar: add H1/H2/H3 controls (Crepe ships only bold/italic/
      // strikethrough/code/link) so heading level can be changed from the
      // toolbar, as in the previous editor. buildToolbar extends the defaults.
      [Crepe.Feature.Toolbar]: {
        buildToolbar: (builder) => {
          const g = builder.addGroup("rn-heading", "Heading");
          g.addItem("rn-h1", headingToolbarItem(1));
          g.addItem("rn-h2", headingToolbarItem(2));
          g.addItem("rn-h3", headingToolbarItem(3));
          g.addItem("rn-h4", headingToolbarItem(4));
        },
      },
      [Crepe.Feature.BlockEdit]: {
        // Notion only has heading levels 1–4, so drop H5/H6 from the slash menu
        // (setting the item to null removes it) to keep parity and clean sync.
        textGroup: { h5: null, h6: null },
        // Extend the default slash menu with a Media group. These insert plain
        // markdown links (how Notion represents File/Video/Audio), so they stay
        // clean, portable markdown.
        buildMenu: (builder) => {
          const media = builder.addGroup("rn-media", "Media");
          media.addItem("rn-video", {
            label: "Video",
            icon: ICON_VIDEO,
            onRun: (ctx) => insertVideoEmbed(ctx),
          });
          media.addItem("rn-audio", {
            label: "Audio",
            icon: ICON_AUDIO,
            onRun: (ctx) => insertLink(ctx, "audio", "https://"),
          });
          media.addItem("rn-file", {
            label: "File",
            icon: ICON_FILE,
            onRun: (ctx) => insertLink(ctx, "file", "https://"),
          });
          // Toggle (collapsible) list, alongside the built-in lists. Serializes
          // to <details>/<summary> markdown and pushes to Notion as a real
          // toggle block (see ../toggleMarkdown + notionSync).
          builder.getGroup("list").addItem("rn-toggle", {
            label: "Toggle list",
            icon: ICON_TOGGLE,
            onRun: (ctx) => insertToggle(ctx),
          });
        },
      },
    },
  });
  // Custom video-embed block (renders recognized video links as a card; stays
  // clean `[url](url)` markdown).
  c.addFeature((editor: any) => {
    editor
      .use(videoEmbedRemark)
      .use(videoEmbedSchema)
      .use(videoEmbedView(openExternal, copyText))
      .use(bareLinkSync)
      // Toggle-list (collapsible) block: remark fold + schema + node view.
      .use(toggleRemark)
      .use(toggleSummarySchema)
      .use(toggleSchema)
      .use(toggleView());
  });
  c.on((listener) => {
    listener.markdownUpdated(() => {
      if (!applyingRemote) {
        scheduleEdit();
      }
    });
  });
  await c.create();
  crepe = c;
}

/**
 * Apply content from the host. Crepe has no in-place "replace all", so we
 * recreate the editor — remote pushes (initial load, external file change,
 * Notion pull) are infrequent, so the cost is acceptable.
 */
async function setContent(markdown: string): Promise<void> {
  const canon = canonicalizeForFile(markdown);
  if (canon === lastSerialized && crepe) {
    vscode.postMessage({ type: "acked" });
    return; // already showing this content
  }
  applyingRemote = true;
  try {
    await mountCrepe(markdown);
    lastSerialized = currentMarkdown();
  } finally {
    // Let the create-time markdownUpdated events settle before re-enabling edit
    // echoes.
    setTimeout(() => {
      applyingRemote = false;
      vscode.postMessage({ type: "acked" });
    }, 0);
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data;
  if (msg && msg.type === "setContent") {
    void setContent(String(msg.text ?? ""));
  }
});

/** Run Milkdown's own undo/redo on the current editor. */
function runHistory(command: "undo" | "redo"): void {
  if (!crepe) {
    return;
  }
  crepe.editor.action((ctx) => {
    ctx.get(commandsCtx).call(command === "undo" ? undoCommand.key : redoCommand.key);
  });
}

// Own undo/redo entirely inside the editor. Each webview edit is applied to the
// underlying TextDocument as a whole-document WorkspaceEdit; if Cmd+Z reaches VS
// Code it undoes that edit and pushes fresh text back, forcing a full re-mount
// (scroll/cursor jump to the very top of a long note). Intercepting in the
// capture phase and stopping the event means only Milkdown's granular history
// runs — undo happens in place, right where the edit was. stopImmediatePropagation
// also prevents Crepe's own keymap from double-undoing.
window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || !crepe) {
      return;
    }
    const key = e.key.toLowerCase();
    const isUndo = key === "z" && !e.shiftKey;
    const isRedo = (key === "z" && e.shiftKey) || key === "y";
    if (!isUndo && !isRedo) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    runHistory(isUndo ? "undo" : "redo");
  },
  true
);

vscode.postMessage({ type: "ready" });
