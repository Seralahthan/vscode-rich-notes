import * as vscode from "vscode";
import { createHash } from "crypto";

/**
 * A CustomTextEditor that renders a markdown document with the BlockNote
 * Notion-style block editor (running as a React app inside the webview).
 *
 * The .md file stays plain, readable markdown (normal save / dirty / undo). To
 * preserve structures markdown cannot express (nested paragraphs, etc.) without
 * data loss, BlockNote's exact blocks are mirrored to a sidecar file
 * "<name>.md.blocks.json" alongside it. The sidecar records a hash of the
 * markdown it corresponds to; on load we restore the exact blocks only when that
 * hash still matches the .md (otherwise the .md was edited elsewhere and we fall
 * back to parsing the markdown).
 */
export class RichNotesEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "richNotes.editor";

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      RichNotesEditorProvider.viewType,
      new RichNotesEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.getHtml(webview);

    const sidecarUri = document.uri.with({
      path: document.uri.path + ".blocks.json",
    });

    // True while we push document text into the webview, and true while we apply
    // a webview-originated edit — both suppress the change->webview echo.
    let updatingFromDocument = false;
    let applyingFromWebview = false;

    const readSidecarBlocks = async (markdown: string): Promise<string | null> => {
      try {
        const raw = await vscode.workspace.fs.readFile(sidecarUri);
        const parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
        if (parsed && parsed.markdownHash === hashOf(markdown) && parsed.blocks) {
          return JSON.stringify(parsed.blocks);
        }
      } catch {
        // No sidecar, or unreadable — fall back to parsing markdown.
      }
      return null;
    };

    const writeSidecar = async (markdown: string, blocksJson: string) => {
      try {
        const payload = JSON.stringify({
          version: 1,
          markdownHash: hashOf(markdown),
          blocks: JSON.parse(blocksJson),
        });
        await vscode.workspace.fs.writeFile(
          sidecarUri,
          Buffer.from(payload, "utf8")
        );
      } catch (err) {
        console.error("Rich Notes: failed to write sidecar", err);
      }
    };

    const postDocumentToWebview = async () => {
      updatingFromDocument = true;
      const text = document.getText();
      const blocks = await readSidecarBlocks(text);
      webview.postMessage({ type: "setContent", text, blocks });
    };

    // Apply markdown coming from the webview back into the TextDocument.
    const applyEditFromWebview = async (text: string) => {
      if (text === document.getText()) {
        return;
      }
      applyingFromWebview = true;
      try {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, text);
        await vscode.workspace.applyEdit(edit);
      } finally {
        applyingFromWebview = false;
      }
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      // Only push to the webview for edits that did NOT originate there
      // (e.g. external file change, git checkout, find-and-replace).
      if (updatingFromDocument || applyingFromWebview) {
        return;
      }
      void postDocumentToWebview();
    });

    const messageSub = webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          await postDocumentToWebview();
          break;
        case "edit":
          await applyEditFromWebview(msg.text ?? "");
          // Persist full-fidelity blocks even when the markdown is unchanged
          // (e.g. nested paragraphs), so nothing is silently lost.
          if (typeof msg.blocks === "string") {
            await writeSidecar(msg.text ?? document.getText(), msg.blocks);
          }
          break;
        case "acked":
          // Webview confirmed it ingested the content we pushed.
          updatingFromDocument = false;
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaUri = (...p: string[]) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", ...p)
      );

    const webviewJs = mediaUri("webview.js");
    const webviewCss = mediaUri("webview.css");
    const nonce = getNonce();

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      // BlockNote/Mantine inject runtime <style> tags, so inline styles are
      // required; data: covers bundled fonts.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${webviewCss}" />
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${webviewJs}"></script>
</body>
</html>`;
  }
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
