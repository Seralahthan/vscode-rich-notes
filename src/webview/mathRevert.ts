/**
 * "Un-equation" escape hatch. Once text is formatted as an inline equation, the
 * only exits Crepe offers are editing the LaTeX or deleting the node — there's no
 * way to turn it back into normal text (accidental format-as-equation is a dead
 * end). This plugin makes **Escape**, while an inline-math node is selected,
 * replace it with its plain text (the LaTeX value), i.e. cancel the equation
 * formatting. An empty/whitespace-only equation is simply removed.
 */
import { $prose } from "@milkdown/kit/utils";
import { Plugin, NodeSelection } from "@milkdown/kit/prose/state";

export const mathRevert = $prose(() => {
  return new Plugin({
    props: {
      handleKeyDown: (view: any, event: KeyboardEvent) => {
        if (event.key !== "Escape") {
          return false;
        }
        const sel: any = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "math_inline") {
          return false;
        }
        const from = sel.from;
        const value = String(sel.node.attrs.value ?? "").trim();
        let tr = view.state.tr.delete(from, from + 1);
        if (value) {
          tr = tr.insertText(value, from);
        }
        view.dispatch(tr.scrollIntoView());
        view.focus();
        return true;
      },
    },
  });
});
