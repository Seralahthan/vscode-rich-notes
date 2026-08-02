import { Crepe } from "@milkdown/crepe";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import type { Ctx } from "@milkdown/kit/ctx";
import { canonicalizeForFile } from "../markdown";
import {
  videoEmbedSchema,
  videoEmbedRemark,
  videoEmbedView,
  insertVideoEmbed,
} from "./videoEmbed";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./theme.css";

// Open a URL in the user's browser via the extension host.
const openExternal = (url: string) => vscode.postMessage({ type: "openExternal", url });

// Minimal inline SVG icons (Crepe menu icons are raw SVG strings).
const ICON_VIDEO =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
const ICON_AUDIO =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12z"/></svg>';
const ICON_FILE =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5z"/></svg>';

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
    defaultValue: markdown,
    featureConfigs: {
      [Crepe.Feature.BlockEdit]: {
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
        },
      },
    },
  });
  // Custom video-embed block (renders recognized video links as a card; stays
  // clean `[url](url)` markdown).
  c.addFeature((editor: any) => {
    editor.use(videoEmbedRemark).use(videoEmbedSchema).use(videoEmbedView(openExternal));
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

vscode.postMessage({ type: "ready" });
