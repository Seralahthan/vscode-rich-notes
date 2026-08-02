import * as vscode from "vscode";

/**
 * Dev-only command for the Phase 0 Milkdown spike. Opens a webview panel that
 * loads the Crepe editor bundle (media/spike.js) and runs a round-trip check.
 * Registered only to validate the migration; it ships in no release.
 */
export function registerMilkdownSpike(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("richNotes.openMilkdownSpike", () => {
      const panel = vscode.window.createWebviewPanel(
        "richNotes.milkdownSpike",
        "Milkdown spike",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
        }
      );

      const webview = panel.webview;
      const uri = (...p: string[]) =>
        webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", ...p));
      const nonce = getNonce();
      const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data: blob:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource} data:`,
        `script-src 'nonce-${nonce}'`,
      ].join("; ");

      webview.html = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${uri("spike.css")}" />
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${uri("spike.js")}"></script>
</body>
</html>`;
    })
  );
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
