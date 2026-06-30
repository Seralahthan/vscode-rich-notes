import * as vscode from "vscode";
import { RichNotesEditorProvider } from "./richTextEditorProvider";

export function activate(context: vscode.ExtensionContext) {
  // Register the rich-text custom editor for markdown files.
  context.subscriptions.push(RichNotesEditorProvider.register(context));

  // Open the currently active markdown file in the rich-text editor.
  context.subscriptions.push(
    vscode.commands.registerCommand("richNotes.openWith", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage("Open a .md file first.");
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        target,
        RichNotesEditorProvider.viewType
      );
    })
  );

  // Create a new note and open it directly in the rich-text editor.
  context.subscriptions.push(
    vscode.commands.registerCommand("richNotes.newNote", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const defaultUri = folder
        ? vscode.Uri.joinPath(folder.uri, "untitled-note.md")
        : undefined;
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ["md"] },
        saveLabel: "Create note",
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, new Uint8Array());
      await vscode.commands.executeCommand(
        "vscode.openWith",
        target,
        RichNotesEditorProvider.viewType
      );
    })
  );
}

export function deactivate() {}
