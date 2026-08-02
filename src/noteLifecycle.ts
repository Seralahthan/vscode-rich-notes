import * as vscode from "vscode";
import * as path from "path";
import { noteLink } from "./frontmatter";
import { getToken, archivePage } from "./notionSync";
import { SyncedRegistry } from "./syncedRegistry";

const isNote = (uri: vscode.Uri) => uri.fsPath.endsWith(".md");

async function readLinkPageId(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return noteLink(Buffer.from(bytes).toString("utf8"))?.pageId;
  } catch {
    return undefined;
  }
}

/**
 * On deleting a note that was linked to Notion, ask whether to keep or archive
 * the Notion page. The page id is captured in `onWillDeleteFiles` because the
 * file is gone by the time the deletion completes.
 */
export function registerNoteLifecycle(
  context: vscode.ExtensionContext,
  registry: SyncedRegistry
): void {
  const pendingPageIds = new Map<string, string>(); // note fsPath -> pageId

  context.subscriptions.push(
    vscode.workspace.onWillDeleteFiles((e) => {
      e.waitUntil(
        (async () => {
          for (const uri of e.files) {
            if (!isNote(uri)) {
              continue;
            }
            const pageId = await readLinkPageId(uri);
            if (pageId) {
              pendingPageIds.set(uri.fsPath, pageId);
            }
          }
        })()
      );
    }),

    vscode.workspace.onDidDeleteFiles(async (e) => {
      for (const uri of e.files) {
        if (!isNote(uri)) {
          continue;
        }
        registry.markUnsynced(uri);

        const pageId = pendingPageIds.get(uri.fsPath);
        pendingPageIds.delete(uri.fsPath);
        if (pageId) {
          await promptDeleteRemote(context, uri, pageId);
        }
      }
    })
  );
}

async function promptDeleteRemote(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri,
  pageId: string
): Promise<void> {
  const name = path.basename(noteUri.fsPath);
  const choice = await vscode.window.showInformationMessage(
    `“${name}” was synced to Notion. Keep the Notion page or archive it?`,
    "Keep page",
    "Archive in Notion"
  );
  if (choice !== "Archive in Notion") {
    return;
  }
  const token = await getToken(context);
  if (!token) {
    vscode.window.showWarningMessage(
      "No Notion token set — the Notion page was left in place."
    );
    return;
  }
  try {
    await archivePage(token, pageId);
    vscode.window.showInformationMessage("Notion page archived (moved to trash).");
  } catch (err: any) {
    vscode.window.showErrorMessage(
      "Couldn’t archive the Notion page: " + (err?.message ?? String(err))
    );
  }
}
