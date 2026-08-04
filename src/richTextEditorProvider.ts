import * as vscode from "vscode";
import { parseNote, serializeNote } from "./frontmatter";
import { checkRemoteOnOpen, isCancellation } from "./sync";

/**
 * A CustomTextEditor that renders a markdown document with the Milkdown (Crepe)
 * editor running as a webview app.
 *
 * The `.md` file is the single source of truth — Milkdown round-trips markdown
 * losslessly, so there is no fidelity sidecar. A note's Notion link lives in the
 * file's YAML frontmatter; the host strips the frontmatter before the editor
 * sees it and re-attaches it on save, so the editor only ever shows the body.
 */
export class RichNotesEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "richNotes.editor";

  /**
   * The note shown in the currently-focused Rich Notes editor. Custom editors
   * are not reported via `window.activeTextEditor`, so sync commands invoked
   * from the command palette use this instead.
   */
  public static activeDocument: vscode.TextDocument | undefined;

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

    // True while we push document text into the webview, and true while we apply
    // a webview-originated edit — both suppress the change->webview echo.
    let updatingFromDocument = false;
    let applyingFromWebview = false;

    // Debounced auto-save so notes persist shortly after editing (which also
    // drives Notion auto-sync via onDidSaveTextDocument).
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAutoSave = () => {
      const cfg = vscode.workspace.getConfiguration("richNotes");
      if (!cfg.get<boolean>("autoSave", true)) {
        return;
      }
      const delay = cfg.get<number>("autoSaveDelay", 1000);
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => {
        if (document.isDirty) {
          void document.save();
        }
      }, delay);
    };

    // Send the note's body (frontmatter stripped) to the editor, plus the
    // frontmatter line offset and gutter setting so the editor's source-line
    // numbers line up with the actual file.
    const postDocumentToWebview = () => {
      updatingFromDocument = true;
      const full = document.getText();
      const { body } = parseNote(full);
      // Lines the frontmatter block occupies before the body begins (body is the
      // tail of `full`, so the stripped prefix is everything before it).
      const prefix = full.slice(0, Math.max(0, full.length - body.length));
      const lineOffset = prefix ? (prefix.match(/\n/g)?.length ?? 0) : 0;
      const showLineNumbers = vscode.workspace
        .getConfiguration("richNotes")
        .get<boolean>("showLineNumbers", true);
      webview.postMessage({ type: "setContent", text: body, lineOffset, showLineNumbers });
    };

    // Apply an edited body from the webview: re-attach the current frontmatter
    // (Notion link + any user keys) and write the full document back.
    const applyEditFromWebview = async (body: string) => {
      const { link, frontmatter } = parseNote(document.getText());
      const full = serializeNote(body, link, frontmatter);
      if (full === document.getText()) {
        return;
      }
      applyingFromWebview = true;
      try {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        edit.replace(document.uri, fullRange, full);
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
      // (external file change, git checkout, find-and-replace, Notion pull).
      if (updatingFromDocument || applyingFromWebview) {
        return;
      }
      postDocumentToWebview();
    });

    const messageSub = webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          postDocumentToWebview();
          break;
        case "edit":
          await applyEditFromWebview(msg.text ?? "");
          scheduleAutoSave();
          break;
        case "acked":
          // Webview confirmed it ingested the content we pushed.
          updatingFromDocument = false;
          break;
        case "copyText":
          // Clipboard access from a webview is unreliable; the host writes it.
          if (typeof msg.text === "string") {
            await vscode.env.clipboard.writeText(msg.text);
          }
          break;
        case "openExternal":
          if (typeof msg.url === "string") {
            try {
              await vscode.env.openExternal(vscode.Uri.parse(msg.url));
            } catch {
              /* invalid url */
            }
          }
          break;
      }
    });

    let wasActive = webviewPanel.active;
    const trackActive = () => {
      if (webviewPanel.active) {
        RichNotesEditorProvider.activeDocument = document;
        // Rising edge: the panel just regained focus (returning from Notion in a
        // browser tab, or refocusing the editor). Pull any remote changes — the
        // cooldown inside checkRemoteOnOpen dedupes against the window-focus,
        // tab-activation and first-open triggers.
        if (!wasActive) {
          void checkRemoteOnOpen(this.context, document.uri).catch((err) => {
            if (!isCancellation(err)) {
              console.error("Rich Notes: remote check on refocus failed", err);
            }
          });
        }
      } else if (RichNotesEditorProvider.activeDocument === document) {
        RichNotesEditorProvider.activeDocument = undefined;
      }
      wasActive = webviewPanel.active;
    };
    trackActive();
    const viewStateSub = webviewPanel.onDidChangeViewState(trackActive);

    // Guaranteed "note opened" signal: sync on first open (deduped by the
    // cooldown inside checkRemoteOnOpen against the tab-activation trigger).
    void checkRemoteOnOpen(this.context, document.uri).catch((err) => {
      if (!isCancellation(err)) {
        console.error("Rich Notes: remote check on open failed", err);
      }
    });

    webviewPanel.onDidDispose(() => {
      if (RichNotesEditorProvider.activeDocument === document) {
        RichNotesEditorProvider.activeDocument = undefined;
      }
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      changeSub.dispose();
      messageSub.dispose();
      viewStateSub.dispose();
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
      // img-src covers video thumbnails (e.g. YouTube); media-src covers the
      // native <video> player for direct .mp4/.webm files.
      `img-src ${webview.cspSource} https: data: blob:`,
      // Milkdown/Crepe inject runtime <style> tags, so inline styles are
      // required; data: covers bundled fonts.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
      `media-src ${webview.cspSource} https: blob: data:`,
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

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
