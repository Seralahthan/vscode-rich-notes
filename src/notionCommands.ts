import * as vscode from "vscode";
import * as path from "path";
import { RichNotesEditorProvider } from "./richTextEditorProvider";
import { readSidecar, updateNotionLink } from "./sidecar";
import { SyncedRegistry } from "./syncedRegistry";
import { manualSync, forcePull, forcePush, syncStatus } from "./sync";
import {
  getToken,
  setTokenInteractive,
  clearToken,
  getParentPageId,
  createLinkedPage,
  pushToPage,
  deriveTitle,
} from "./notionSync";

/** Resolve the note a command should act on. */
async function resolveTarget(
  uri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    return vscode.workspace.openTextDocument(uri);
  }
  if (RichNotesEditorProvider.activeDocument) {
    return RichNotesEditorProvider.activeDocument;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === "markdown") {
    return editor.document;
  }
  return undefined;
}

async function ensureToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  let token = await getToken(context);
  if (!token) {
    if (await setTokenInteractive(context)) {
      token = await getToken(context);
    }
  }
  return token;
}

async function syncCommand(
  context: vscode.ExtensionContext,
  registry: SyncedRegistry,
  uri?: vscode.Uri
): Promise<void> {
  const doc = await resolveTarget(uri);
  if (!doc) {
    vscode.window.showWarningMessage("Open a note first, then sync it to Notion.");
    return;
  }
  const token = await ensureToken(context);
  if (!token) {
    return;
  }

  const markdown = doc.getText();
  const link = (await readSidecar(doc.uri))?.notion;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: link?.pageId ? "Pushing to Notion…" : "Linking to Notion…",
    },
    async () => {
      try {
        let newLink;
        if (link?.pageId) {
          newLink = await pushToPage(token, link.pageId, markdown);
        } else {
          const parent = getParentPageId();
          if (!parent) {
            vscode.window.showErrorMessage(
              "Set Settings → Rich Notes → Notion: Parent Page Id (a Notion page shared with your integration) before linking a note."
            );
            return;
          }
          const title = deriveTitle(markdown, path.basename(doc.uri.fsPath, ".md"));
          newLink = await createLinkedPage(token, parent, title, markdown);
        }
        await updateNotionLink(doc.uri, markdown, newLink);
        registry.markSynced(doc.uri);
        vscode.window.showInformationMessage(
          link?.pageId
            ? "Note pushed to Notion."
            : "Note linked and pushed to Notion."
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(
          "Notion sync failed: " + (err?.message ?? String(err))
        );
      }
    }
  );
}

async function unlinkCommand(
  registry: SyncedRegistry,
  uri?: vscode.Uri
): Promise<void> {
  const doc = await resolveTarget(uri);
  if (!doc) {
    vscode.window.showWarningMessage("Open a note first.");
    return;
  }
  const sidecar = await readSidecar(doc.uri);
  if (!sidecar?.notion?.pageId) {
    vscode.window.showInformationMessage("This note isn’t linked to Notion.");
    return;
  }
  await updateNotionLink(doc.uri, doc.getText(), undefined);
  registry.markUnsynced(doc.uri);
  vscode.window.showInformationMessage(
    "Unlinked from Notion. The Notion page was left intact; auto-sync is off for this note."
  );
}

export function registerNotionCommands(
  context: vscode.ExtensionContext,
  registry: SyncedRegistry
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("richNotes.setNotionToken", async () => {
      if (await setTokenInteractive(context)) {
        vscode.window.showInformationMessage("Notion token saved.");
      }
    }),
    vscode.commands.registerCommand("richNotes.clearNotionToken", async () => {
      await clearToken(context);
      vscode.window.showInformationMessage("Notion token cleared.");
    }),
    vscode.commands.registerCommand(
      "richNotes.syncToNotion",
      (uri?: vscode.Uri) => syncCommand(context, registry, uri)
    ),
    vscode.commands.registerCommand(
      "richNotes.unlinkFromNotion",
      (uri?: vscode.Uri) => unlinkCommand(registry, uri)
    ),
    vscode.commands.registerCommand("richNotes.syncNow", async (uri?: vscode.Uri) => {
      const doc = await resolveTarget(uri);
      if (!doc) {
        vscode.window.showWarningMessage("Open a note first.");
        return;
      }
      await manualSync(context, doc.uri);
    }),
    vscode.commands.registerCommand("richNotes.pullFromNotion", async (uri?: vscode.Uri) => {
      const doc = await resolveTarget(uri);
      if (doc) {
        await forcePull(context, doc.uri);
      }
    }),
    vscode.commands.registerCommand("richNotes.pushToNotion", async (uri?: vscode.Uri) => {
      const doc = await resolveTarget(uri);
      if (doc) {
        await forcePush(context, doc.uri);
      }
    }),
    vscode.commands.registerCommand("richNotes.syncStatus", async (uri?: vscode.Uri) => {
      const doc = await resolveTarget(uri);
      if (doc) {
        await syncStatus(context, doc.uri);
      }
    })
  );
}
