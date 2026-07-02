import * as vscode from "vscode";
import { readSidecar } from "./sidecar";

// Context key holding a map of { <note fsPath>: true } for notes linked to
// Notion. Menu `when` clauses use `resourcePath in richNotes.syncedNotes` to
// show/hide the manual sync action per file.
const CONTEXT_KEY = "richNotes.syncedNotes";

export class SyncedRegistry {
  private synced = new Set<string>();

  async init(context: vscode.ExtensionContext): Promise<void> {
    await this.scan();
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.md.blocks.json");
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate((u) => this.refresh(u)),
      watcher.onDidChange((u) => this.refresh(u)),
      watcher.onDidDelete((u) => this.remove(u))
    );
  }

  /** Note Uri for a "<name>.md.blocks.json" sidecar Uri. */
  private noteUriFor(sidecarUri: vscode.Uri): vscode.Uri {
    return sidecarUri.with({
      path: sidecarUri.path.replace(/\.blocks\.json$/, ""),
    });
  }

  private async scan(): Promise<void> {
    this.synced.clear();
    const sidecars = await vscode.workspace.findFiles("**/*.md.blocks.json");
    for (const sidecar of sidecars) {
      const noteUri = this.noteUriFor(sidecar);
      const sc = await readSidecar(noteUri);
      if (sc?.notion?.pageId) {
        this.synced.add(noteUri.fsPath);
      }
    }
    this.push();
  }

  private async refresh(sidecarUri: vscode.Uri): Promise<void> {
    const noteUri = this.noteUriFor(sidecarUri);
    const sc = await readSidecar(noteUri);
    if (sc?.notion?.pageId) {
      this.synced.add(noteUri.fsPath);
    } else {
      this.synced.delete(noteUri.fsPath);
    }
    this.push();
  }

  private remove(sidecarUri: vscode.Uri): void {
    this.synced.delete(this.noteUriFor(sidecarUri).fsPath);
    this.push();
  }

  /** Immediately mark a note as synced (avoids waiting for the file watcher). */
  markSynced(noteUri: vscode.Uri): void {
    this.synced.add(noteUri.fsPath);
    this.push();
  }

  /** Immediately mark a note as no longer synced. */
  markUnsynced(noteUri: vscode.Uri): void {
    this.synced.delete(noteUri.fsPath);
    this.push();
  }

  private push(): void {
    const map: Record<string, boolean> = {};
    for (const p of this.synced) {
      map[p] = true;
    }
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, map);
  }
}
