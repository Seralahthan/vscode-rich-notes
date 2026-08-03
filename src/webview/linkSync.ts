/**
 * Keep "bare-URL" links consistent: when a link's visible text is itself a URL
 * (e.g. a pasted `https://…`), editing its target via Crepe's link tooltip only
 * changes the href, leaving the displayed URL stale. This ProseMirror plugin
 * watches for that mismatch and rewrites the text to match the href, so editing
 * a bare-URL link updates what you see too.
 *
 * Scope: only links whose visible text is a URL. A link with real label text
 * (`[docs](https://…)`) is never touched. Crepe's link tooltip isn't
 * configurable for this (only icons/labels/copy-callback), so we react to the
 * document change rather than override the tooltip.
 */
import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);

export const bareLinkSync = $prose(() => {
  return new Plugin({
    appendTransaction: (trs, _oldState, newState) => {
      if (!trs.some((t) => t.docChanged)) {
        return null;
      }
      const linkType = newState.schema.marks.link;
      if (!linkType) {
        return null;
      }
      const edits: { from: number; to: number; href: string; attrs: any }[] = [];
      newState.doc.descendants((node: any, pos: number) => {
        if (!node.isText || !node.text) {
          return true;
        }
        const mark = node.marks.find((m: any) => m.type === linkType);
        if (!mark) {
          return true;
        }
        const href = mark.attrs.href as string;
        const text = node.text as string;
        if (isUrl(text) && isUrl(href) && text !== href) {
          edits.push({ from: pos, to: pos + node.nodeSize, href, attrs: { ...mark.attrs } });
        }
        return true;
      });
      if (edits.length === 0) {
        return null;
      }
      const tr = newState.tr;
      // Apply last-to-first so earlier positions stay valid as text lengths change.
      for (const e of edits.reverse()) {
        tr.insertText(e.href, e.from, e.to);
        tr.addMark(e.from, e.from + e.href.length, linkType.create(e.attrs));
      }
      return tr;
    },
  });
});
