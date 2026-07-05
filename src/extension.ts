import * as vscode from "vscode";
import { RichNotesEditorProvider } from "./richTextEditorProvider";
import { registerNotionCommands } from "./notionCommands";
import { registerAutoSync } from "./autoSync";
import { SyncedRegistry } from "./syncedRegistry";
import { registerNoteLifecycle } from "./noteLifecycle";
import { registerConflictCommands, checkRemoteOnOpen, isCancellation } from "./sync";

export function activate(context: vscode.ExtensionContext) {
  // Register the rich-text custom editor for markdown files.
  context.subscriptions.push(RichNotesEditorProvider.register(context));

  // Tracks which notes are linked to Notion (drives the per-file menu).
  const registry = new SyncedRegistry();
  void registry.init(context);

  // Notion sync commands (token, sync), auto-sync on save, delete handling.
  registerNotionCommands(context, registry);
  registerAutoSync(context);
  registerNoteLifecycle(context, registry);
  registerConflictCommands(context);

  // The note currently being edited (active custom-editor tab), or undefined.
  const activeNoteUri = (): vscode.Uri | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (
      input instanceof vscode.TabInputCustom &&
      input.viewType === RichNotesEditorProvider.viewType
    ) {
      return input.uri;
    }
    return undefined;
  };

  const syncActiveNote = () => {
    const uri = activeNoteUri();
    if (uri) {
      void checkRemoteOnOpen(context, uri).catch((err) => {
        if (!isCancellation(err)) {
          console.error("Rich Notes: active-note remote check failed", err);
        }
      });
    }
  };

  // Returning to VS Code (e.g. from Notion): sync ONLY the actively-edited note,
  // after a 3s settle delay so quick app-switches don't trigger a fetch. Cancel
  // the pending sync if focus is lost again before it fires.
  let wasFocused = vscode.window.state.focused;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && !wasFocused) {
        if (focusTimer) {
          clearTimeout(focusTimer);
        }
        focusTimer = setTimeout(syncActiveNote, 3000);
      } else if (!state.focused && focusTimer) {
        clearTimeout(focusTimer);
        focusTimer = undefined;
      }
      wasFocused = state.focused;
    })
  );

  // Switching to (or opening) a note tab syncs THAT note — this is how other
  // open-but-inactive notes get synced: when they become the active editor.
  let lastActiveNote: string | undefined;
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      const key = activeNoteUri()?.toString();
      if (key && key !== lastActiveNote) {
        lastActiveNote = key;
        syncActiveNote();
      } else if (!key) {
        lastActiveNote = undefined;
      }
    })
  );

  // Handle a note already open when the extension activates.
  syncActiveNote();

  // Open a .md file as raw markdown text (Rich Notes is the default editor).
  context.subscriptions.push(
    vscode.commands.registerCommand("richNotes.openSource", async (uri?: vscode.Uri) => {
      const target =
        uri ??
        RichNotesEditorProvider.activeDocument?.uri ??
        vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage("Open a .md file first.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, "default");
    })
  );

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
