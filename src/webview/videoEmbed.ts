/**
 * A "video embed" block for Milkdown/Crepe.
 *
 * Round-trip design: in plain markdown a video is just a link — Notion exports
 * `[url](url)` for a video block and re-embeds it on import by recognizing the
 * URL. We do the same: the block serializes to `[url](url)` (clean, portable,
 * Notion-compatible), and on load a `$remark` transform recognizes a lone
 * video-host link and turns it back into a video block.
 *
 * Rendering: inline iframe playback is IMPOSSIBLE in a VS Code webview — it runs
 * in a sandboxed iframe with an opaque `vscode-webview://` origin that YouTube's
 * player rejects ("Error 153"); microsoft/vscode#196975 is closed as not
 * planned. So we render:
 *   - YouTube  -> a real thumbnail (images are allowed) + play overlay; clicking
 *                 opens the video externally.
 *   - direct media file (.mp4/.webm/.mov) -> a native <video> player.
 *   - anything else -> a click-to-open card.
 *
 * Each embed carries a floating toolbar (View original / More) whose menu offers
 * Replace, Open in browser, Copy link, and Delete.
 */
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { clearTextInCurrentBlockCommand } from "@milkdown/kit/preset/commonmark";
import type { Ctx } from "@milkdown/kit/ctx";

const NODE = "video_embed";
// Marker stored as the link title (`[url](url "video")`) so an embed is
// distinguishable from a plain link in the markdown — see toMarkdown / the
// remark transform below.
const EMBED_TITLE = "video";

/** The YouTube video id for a watch/share/embed/shorts URL, or null. */
function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host === "youtu.be") {
    return u.pathname.slice(1) || null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = u.searchParams.get("v");
    if (v) {
      return v;
    }
    const m = u.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)/);
    return m ? m[1] : null;
  }
  return null;
}

/** A direct-media file a native `<video>` element can play, or null. */
function directMedia(url: string): string | null {
  try {
    return /\.(mp4|webm|mov|m4v)$/i.test(new URL(url).pathname) ? url : null;
  } catch {
    return null;
  }
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
  // prose node -> a paragraph with a single link carrying the `"video"` title,
  // i.e. `[url](url "video")`. The title is what distinguishes an embed from a
  // plain link in the markdown (a pasted link has no title, so it stays a link),
  // which is how the embed survives a reload while keeping the file clean.
  toMarkdown: {
    match: (node) => node.type.name === NODE,
    runner: (state, node) => {
      const url = (node.attrs.src as string) || "";
      state.openNode("paragraph");
      state.openNode("link", undefined, { url, title: EMBED_TITLE });
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
      const link = node?.children?.[0];
      // Only a lone link carrying the `"video"` title becomes an embed; a plain
      // link (e.g. one the user pasted) is left as a link.
      if (
        node?.type === "paragraph" &&
        node.children?.length === 1 &&
        link?.type === "link" &&
        typeof link.url === "string" &&
        link.title === EMBED_TITLE
      ) {
        children[i] = { type: "videoEmbed", url: link.url };
      }
    }
  }
);

// --- Node view: placeholder -> link input -> thumbnail / <video> / card --------

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_MORE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
// Diagonal "open original" arrow (↗).
const ICON_ARROW =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
const ICON_REPLACE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>';
const ICON_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z"/></svg>';
const ICON_LINK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 1 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const ICON_DUPLICATE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

/**
 * Build the node view. `openExternal` opens a URL in the browser and `copyText`
 * writes to the clipboard — both go through the extension host.
 */
export function videoEmbedView(
  openExternal: (url: string) => void,
  copyText: (text: string) => void
) {
  return $view(videoEmbedSchema.node, (): any => {
    return (node: any, view: any, getPos: () => number | undefined) => {
      const dom = document.createElement("div");
      dom.className = "rn-video-embed";
      // Document listener registered while an actions menu is open.
      let detachMenu: (() => void) | null = null;

      const setSrc = (src: string) => {
        const pos = getPos();
        if (pos == null) {
          return;
        }
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { src }));
      };

      /** Remove the whole video block from the document. */
      const deleteSelf = () => {
        const pos = getPos();
        if (pos == null) {
          return;
        }
        const target = view.state.doc.nodeAt(pos);
        if (!target) {
          return;
        }
        view.dispatch(view.state.tr.delete(pos, pos + target.nodeSize));
        view.focus();
      };

      /** Insert a copy of this video block right after it. */
      const duplicateSelf = () => {
        const pos = getPos();
        if (pos == null) {
          return;
        }
        const target = view.state.doc.nodeAt(pos);
        if (!target) {
          return;
        }
        view.dispatch(view.state.tr.insert(pos + target.nodeSize, target.copy()));
        view.focus();
      };

      /** Floating toolbar (View original / More) + its actions menu. */
      const buildOverlay = (url: string): HTMLElement => {
        const overlay = document.createElement("div");
        overlay.className = "rn-video-overlay";

        const tools = document.createElement("div");
        tools.className = "rn-video-tools";

        const viewBtn = document.createElement("button");
        viewBtn.type = "button";
        viewBtn.className = "rn-video-tool";
        viewBtn.setAttribute("aria-label", "View original");
        viewBtn.setAttribute("data-tip", "View original");
        viewBtn.innerHTML = ICON_ARROW;

        const moreBtn = document.createElement("button");
        moreBtn.type = "button";
        moreBtn.className = "rn-video-tool rn-video-more";
        moreBtn.setAttribute("aria-label", "More");
        moreBtn.setAttribute("data-tip", "More");
        moreBtn.innerHTML = ICON_MORE;

        const menu = document.createElement("div");
        menu.className = "rn-video-menu";

        const onDocDown = (e: MouseEvent) => {
          if (!menu.contains(e.target as Node) && !moreBtn.contains(e.target as Node)) {
            closeMenu();
          }
        };
        const closeMenu = () => {
          menu.classList.remove("open");
          if (detachMenu) {
            detachMenu();
            detachMenu = null;
          }
        };
        const openMenu = () => {
          menu.classList.add("open");
          document.addEventListener("mousedown", onDocDown, true);
          detachMenu = () =>
            document.removeEventListener("mousedown", onDocDown, true);
        };

        const addItem = (label: string, icon: string, run: () => void) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "rn-video-menu-item";
          const ic = document.createElement("span");
          ic.className = "rn-video-menu-icon";
          ic.innerHTML = icon;
          const text = document.createElement("span");
          text.textContent = label;
          item.append(ic, text);
          item.addEventListener("mousedown", (e) => e.preventDefault());
          item.addEventListener("click", (e) => {
            e.stopPropagation();
            closeMenu();
            run();
          });
          menu.appendChild(item);
        };

        addItem("Replace", ICON_REPLACE, () => showInput());
        addItem("Open in browser", ICON_OPEN, () => openExternal(url));
        addItem("Copy link", ICON_LINK, () => copyText(url));
        addItem("Duplicate", ICON_DUPLICATE, () => duplicateSelf());
        addItem("Delete", ICON_TRASH, () => deleteSelf());

        for (const b of [viewBtn, moreBtn]) {
          b.addEventListener("mousedown", (e) => e.preventDefault());
        }
        viewBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openExternal(url);
        });
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (menu.classList.contains("open")) {
            closeMenu();
          } else {
            openMenu();
          }
        });

        tools.append(viewBtn, moreBtn);
        overlay.append(tools, menu);
        return overlay;
      };

      const renderThumb = (id: string, url: string) => {
        const wrap = document.createElement("div");
        wrap.className = "rn-video-thumb";
        const img = document.createElement("img");
        img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
        img.alt = "Video thumbnail";
        const play = document.createElement("span");
        play.className = "rn-video-play";
        play.innerHTML = ICON_PLAY;
        const badge = document.createElement("span");
        badge.className = "rn-video-badge";
        badge.textContent = "Watch on YouTube";
        wrap.append(img, play, badge);
        // Clicking the thumbnail itself opens the video.
        wrap.addEventListener("mousedown", (e) => e.preventDefault());
        wrap.addEventListener("click", () => openExternal(url));
        dom.appendChild(wrap);
      };

      const renderVideo = (src: string) => {
        const frame = document.createElement("div");
        frame.className = "rn-video-frame";
        const video = document.createElement("video");
        video.src = src;
        video.controls = true;
        frame.appendChild(video);
        dom.appendChild(frame);
      };

      const renderCard = (url: string) => {
        const card = document.createElement("div");
        card.className = "rn-video-card";
        const icon = document.createElement("span");
        icon.className = "rn-video-icon";
        icon.innerHTML = ICON_PLAY;
        const label = document.createElement("span");
        label.className = "rn-video-url";
        label.textContent = url;
        card.append(icon, label);
        card.addEventListener("mousedown", (e) => e.preventDefault());
        card.addEventListener("click", () => openExternal(url));
        dom.appendChild(card);
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
        hint.textContent = "Works with YouTube, Vimeo, and direct video files";
        const commit = () => {
          const url = input.value.trim();
          if (!url) {
            return;
          }
          setSrc(url);
          // setNodeMarkup is a no-op when the URL is unchanged (Replace with the
          // same link), so ProseMirror won't call the view's update(). Render
          // directly so the input still swaps back to the embed.
          render(url);
        };
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        btn.addEventListener("click", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        });
        panel.append(input, btn, hint);
        dom.appendChild(panel);
        setTimeout(() => input.focus(), 0);
      };

      const render = (currentSrc: string) => {
        dom.innerHTML = "";
        if (currentSrc) {
          const yt = youtubeId(currentSrc);
          const media = directMedia(currentSrc);
          if (yt) {
            renderThumb(yt, currentSrc);
          } else if (media) {
            renderVideo(media);
          } else {
            renderCard(currentSrc);
          }
          // Overlay lives at the embed root (a sibling of the media), so its
          // tooltip and actions menu aren't clipped by the thumbnail's
          // overflow:hidden.
          dom.appendChild(buildOverlay(currentSrc));
          return;
        }
        // Placeholder -> expands to the link input.
        const placeholder = document.createElement("button");
        placeholder.type = "button";
        placeholder.className = "rn-video-placeholder";
        placeholder.innerHTML = `<span class="rn-video-icon">${ICON_PLAY}</span><span>Embed a video</span>`;
        placeholder.addEventListener("mousedown", (e) => e.preventDefault());
        placeholder.addEventListener("click", () => showInput());
        dom.appendChild(placeholder);
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
        destroy: () => {
          if (detachMenu) {
            detachMenu();
            detachMenu = null;
          }
        },
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
