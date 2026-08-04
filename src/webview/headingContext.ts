/**
 * Makes the selection toolbar context-aware. Crepe's toolbar is static — every
 * item is always shown — so heading (H1–H4) buttons appear even when the caret
 * is in a plain paragraph, where changing heading level is meaningless.
 *
 * This plugin marks `<html data-rn-heading="true">` whenever the selection sits
 * inside a heading, and clears it otherwise. theme.css then hides the toolbar's
 * heading buttons (tagged with `svg.rn-heading-tool`) unless the flag is set, so
 * heading options show only for headings. Cheap DOM toggle on selection change;
 * no toolbar reimplementation required.
 */
import { $prose } from "@milkdown/kit/utils";
import { Plugin } from "@milkdown/kit/prose/state";

const ATTR = "data-rn-heading";

function selectionInHeading(state: any): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "heading") {
      return true;
    }
  }
  return false;
}

export const headingContext = $prose(() => {
  return new Plugin({
    view: () => ({
      update: (view: any) => {
        const root = document.documentElement;
        if (selectionInHeading(view.state)) {
          root.setAttribute(ATTR, "true");
        } else {
          root.removeAttribute(ATTR);
        }
      },
      destroy: () => document.documentElement.removeAttribute(ATTR),
    }),
  });
});
