/**
 * A "video embed" block for Milkdown/Crepe.
 *
 * Round-trip design: in plain markdown a video is just a link — Notion exports
 * `[url](url)` for a video block, and re-embeds it on import by recognizing the
 * URL. We do the same: the block serializes to `[url](url)` (clean, portable,
 * Notion-compatible), and on load a `$remark` transform recognizes a lone
 * video-host link and turns it back into a video block. Rendering is a link
 * CARD (no iframe, so nothing external loads into the webview).
 *
 * UX (matches the requested design): inserting shows a placeholder with a video
 * icon; clicking it reveals a "Paste the video link…" input + Embed button
 * (Link only, no upload); once set it becomes a card that opens the URL
 * externally on click.
 */
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import type { Ctx } from "@milkdown/kit/ctx";
import { $view } from "@milkdown/kit/utils";

const NODE = "video_embed";

/** Recognize common video hosts / files (used for insert + reload detection). */
export function isVideoUrl(url: string): boolean {
  return /(?:youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|loom\.com|\.(?:mp4|webm|mov|m4v))/i.test(
    url
  );
}

// --- Schema: block atom with a `src` attr, serialized as a markdown link ------

export const videoEmbedSchema = $nodeSchema(NODE, () => ({
  group: "block",
  atom: true,
  isolating: true,
  marks: "",
  attrs: { src: { default: "" } },
  parseDOM: [
    {
      tag: `div[data-${NODE}]`,
      getAttrs: (dom: HTMLElement | string) => ({
        src: typeof dom === "string" ? "" : dom.getAttribute("data-src") || "",
      }),
    },
  ],
  toDOM: (node) => [
    "div",
    { [`data-${NODE}`]: "true", "data-src": node.attrs.src as string },
  ],
  // mdast `videoEmbed` (produced by the remark transform below) -> prose node.
  parseMarkdown: {
    match: (node) => node.type === "videoEmbed",
    runner: (state, node, type) => {
      state.addNode(type, { src: (node as { url?: string }).url ?? "" });
    },
  },
  // prose node -> a paragraph containing a single link, i.e. `[url](url)`.
  toMarkdown: {
    match: (node) => node.type.name === NODE,
    runner: (state, node) => {
      const url = (node.attrs.src as string) || "";
      state.openNode("paragraph");
      state.openNode("link", undefined, { url });
      state.addNode("text", undefined, url);
      state.closeNode();
      state.closeNode();
    },
  },
}));

// --- Remark: a lone video-host link becomes a videoEmbed node on parse --------

export const videoEmbedRemark = $remark(
  "rnVideoEmbed",
  () => () => (tree: { children?: any[] }) => {
    const children = tree.children ?? [];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (
        node?.type === "paragraph" &&
        node.children?.length === 1 &&
        node.children[0]?.type === "link" &&
        typeof node.children[0].url === "string" &&
        isVideoUrl(node.children[0].url)
      ) {
        children[i] = { type: "videoEmbed", url: node.children[0].url };
      }
    }
  }
);

// --- Node view: placeholder -> link input -> card -----------------------------

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

/** Build the node view. `openExternal` opens a URL via the extension host. */
export function videoEmbedView(openExternal: (url: string) => void) {
  return $view(videoEmbedSchema.node, (): any => {
    return (node: any, view: any, getPos: () => number | undefined) => {
      const dom = document.createElement("div");
      dom.className = "rn-video-embed";

      const setSrc = (src: string) => {
        const pos = getPos();
        if (pos == null) {
          return;
        }
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { src }));
      };

      const render = (currentSrc: string) => {
        dom.innerHTML = "";
        if (currentSrc) {
          // Card
          const card = document.createElement("button");
          card.type = "button";
          card.className = "rn-video-card";
          card.innerHTML = `<span class="rn-video-icon">${ICON_PLAY}</span><span class="rn-video-url"></span>`;
          card.querySelector(".rn-video-url")!.textContent = currentSrc;
          card.addEventListener("mousedown", (e) => e.preventDefault());
          card.addEventListener("click", () => openExternal(currentSrc));
          dom.appendChild(card);
          return;
        }
        // Placeholder -> expands to a link input.
        const placeholder = document.createElement("button");
        placeholder.type = "button";
        placeholder.className = "rn-video-placeholder";
        placeholder.innerHTML = `<span class="rn-video-icon">${ICON_PLAY}</span><span>Embed a video</span>`;
        placeholder.addEventListener("mousedown", (e) => e.preventDefault());
        placeholder.addEventListener("click", () => showInput());
        dom.appendChild(placeholder);
      };

      const showInput = () => {
        dom.innerHTML = "";
        const panel = document.createElement("div");
        panel.className = "rn-video-input";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Paste the video link…";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rn-video-embed-btn";
        btn.textContent = "Embed video";
        const hint = document.createElement("div");
        hint.className = "rn-video-hint";
        hint.textContent = "Works with YouTube, Vimeo, and more";
        const commit = () => {
          const url = input.value.trim();
          if (url) {
            setSrc(url);
          }
        };
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        btn.addEventListener("click", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        });
        panel.appendChild(input);
        panel.appendChild(btn);
        panel.appendChild(hint);
        dom.appendChild(panel);
        setTimeout(() => input.focus(), 0);
      };

      render(node.attrs.src || "");

      return {
        dom,
        update: (updated: any) => {
          if (updated.type.name !== NODE) {
            return false;
          }
          render(updated.attrs.src || "");
          return true;
        },
        stopEvent: () => true, // the view manages its own inputs/clicks
        ignoreMutation: () => true,
      };
    };
  });
}

/** Slash-menu action: clear the "/query" and insert an empty video block. */
export function insertVideoEmbed(ctx: Ctx): void {
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const type = state.schema.nodes[NODE];
  if (!type) {
    return;
  }
  view.dispatch(state.tr.replaceSelectionWith(type.create({ src: "" })).scrollIntoView());
  view.focus();
}
