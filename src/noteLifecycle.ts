import * as vscode from "vscode";
import * as path from "path";
import { readSidecar, sidecarUriFor } from "./sidecar";
import { getToken, archivePage } from "./notionSync";
import { SyncedRegistry } from "./syncedRegistry";

const isNote = (uri: vscode.Uri) => uri.fsPath.endsWith(".md");

/**
 * On deleting a note: clean up its orphaned sidecar, and — if it was linked to
 * Notion — ask whether to keep or archive the Notion page. The page id is
 * captured in `onWillDeleteFiles` because the sidecar may be gone by the time
 * the deletion completes.
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
            const pageId = (await readSidecar(uri))?.notion?.pageId;
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
        // Remove the orphaned sidecar (the watcher will drop it from the registry).
        try {
          await vscode.workspace.fs.delete(sidecarUriFor(uri));
        } catch {
          /* already gone */
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
