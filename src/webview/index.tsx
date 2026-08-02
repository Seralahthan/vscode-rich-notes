import { Crepe } from "@milkdown/crepe";
import { canonicalizeForFile } from "../markdown";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import "./theme.css";

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
  const c = new Crepe({ root: rootEl(), defaultValue: markdown });
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
