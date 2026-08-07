/**
 * Mermaid diagram support for code blocks.
 *
 * A ` ```mermaid ` code block renders its text as a diagram (binary trees,
 * flowcharts, graphs, sequence/ER diagrams, …) using the SAME preview mechanism
 * equations use: Crepe's code block exposes a `renderPreview(language, content,
 * applyPreview)` hook, and the LaTeX feature taps it for ` ```latex `. We chain
 * onto it for ` ```mermaid `, falling back to the previous handler otherwise.
 *
 * It stays a plain ` ```mermaid ` fence in the markdown, so it round-trips
 * losslessly (GitHub and Notion also render Mermaid code blocks).
 *
 * Mermaid is heavy, so it's dynamically imported and initialized only when the
 * first diagram is actually rendered.
 */
import { codeBlockConfig } from "@milkdown/kit/component/code-block";

let mermaidPromise: Promise<any> | null = null;
let idCounter = 0;

/** Lazily load + initialize Mermaid (matched to the VS Code light/dark theme). */
function getMermaid(): Promise<any> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      const dark =
        document.body.classList.contains("vscode-dark") ||
        document.body.classList.contains("vscode-high-contrast");
      mermaid.initialize({
        startOnLoad: false,
        theme: dark ? "dark" : "default",
        securityLevel: "strict",
        fontFamily: "var(--vscode-font-family)",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/**
 * Render `content` as a Mermaid diagram. Returns a "rendering…" placeholder
 * immediately and swaps in the SVG (or an error message) via `applyPreview` once
 * Mermaid resolves.
 */
function renderMermaidPreview(
  content: string,
  applyPreview: (value: HTMLElement) => void
): HTMLElement {
  const loading = document.createElement("div");
  loading.className = "rn-mermaid rn-mermaid-loading";
  loading.textContent = "Rendering diagram…";

  getMermaid()
    .then(async (mermaid) => {
      const id = `rn-mermaid-${++idCounter}`;
      const { svg } = await mermaid.render(id, content);
      const el = document.createElement("div");
      el.className = "rn-mermaid";
      el.innerHTML = svg;
      applyPreview(el);
    })
    .catch((err) => {
      const el = document.createElement("div");
      el.className = "rn-mermaid-error";
      el.textContent = "Diagram error: " + (err?.message ?? String(err));
      applyPreview(el);
    });

  return loading;
}

/**
 * Milkdown feature (use via `crepe.addFeature`) that teaches the code block to
 * render ` ```mermaid ` as a diagram, chaining to the existing renderPreview.
 */
export function mermaidFeature(editor: any): void {
  editor.config((ctx: any) => {
    ctx.update(codeBlockConfig.key, (prev: any) => ({
      ...prev,
      renderPreview: (language: string, content: string, applyPreview: any) => {
        if (language.toLowerCase() === "mermaid" && content.trim().length > 0) {
          return renderMermaidPreview(content, applyPreview);
        }
        return prev.renderPreview(language, content, applyPreview);
      },
    }));
  });
}
