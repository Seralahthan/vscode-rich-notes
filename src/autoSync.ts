import * as vscode from "vscode";
import { readSidecar, hashOf } from "./sidecar";
import { syncLinkedNote } from "./sync";

// How long after a save to wait before pushing (coalesces rapid saves and
// respects Notion's rate limits).
const DEBOUNCE_MS = 2500;

/**
 * Pushes linked notes to Notion automatically when they are saved. Skips notes
 * that aren't linked, are unchanged since the last sync, or whose Notion page
 * has been edited remotely (to avoid clobbering — full conflict handling is a
 * later step).
 */
export function registerAutoSync(context: vscode.ExtensionContext): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();

  const schedule = (uri: vscode.Uri) => {
    const key = uri.toString();
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void run(uri);
      }, DEBOUNCE_MS)
    );
  };

  const run = async (uri: vscode.Uri) => {
    const key = uri.toString();
    if (inFlight.has(key)) {
      schedule(uri); // a push is running; retry after it settles
      return;
    }
    if (!vscode.workspace.getConfiguration("richNotes").get<boolean>("notion.autoSync", true)) {
      return;
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    const markdown = doc.getText();
    const link = (await readSidecar(uri))?.notion;
    if (!link?.pageId) {
      return; // not linked to Notion
    }
    if (link.lastSyncedHash === hashOf(markdown)) {
      return; // nothing changed locally since last sync
    }

    inFlight.add(key);
    try {
      // Delegates to the sync engine: pushes when only local changed, and
      // surfaces a diff-based resolver when both sides changed.
      await syncLinkedNote(context, uri, link, markdown, "auto");
    } catch (err: any) {
      vscode.window.showErrorMessage(
        "Rich Notes: Notion auto-sync failed — " + (err?.message ?? String(err))
      );
    } finally {
      inFlight.delete(key);
    }
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === "file" && doc.fileName.endsWith(".md")) {
        schedule(doc.uri);
      }
    })
  );
}
