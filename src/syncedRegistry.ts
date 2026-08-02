import * as vscode from "vscode";
import { noteLink } from "./frontmatter";

// Context key holding a map of { <note fsPath>: true } for notes linked to
// Notion. Menu `when` clauses use `resourcePath in richNotes.syncedNotes` to
// show/hide the manual sync action per file.
const CONTEXT_KEY = "richNotes.syncedNotes";

export class SyncedRegistry {
  private synced = new Set<string>();

  async init(context: vscode.ExtensionContext): Promise<void> {
    await this.scan();
    // The Notion link now lives in each note's frontmatter, so watch the notes
    // themselves (previously we watched the `.md.blocks.json` sidecars).
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.md");
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate((u) => this.refresh(u)),
      watcher.onDidChange((u) => this.refresh(u)),
      watcher.onDidDelete((u) => this.remove(u))
    );
  }

  private async isLinked(noteUri: vscode.Uri): Promise<boolean> {
    try {
      const bytes = await vscode.workspace.fs.readFile(noteUri);
      return !!noteLink(Buffer.from(bytes).toString("utf8"))?.pageId;
    } catch {
      return false;
    }
  }

  private async scan(): Promise<void> {
    this.synced.clear();
    const notes = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
    for (const noteUri of notes) {
      if (await this.isLinked(noteUri)) {
        this.synced.add(noteUri.fsPath);
      }
    }
    this.push();
  }

  private async refresh(noteUri: vscode.Uri): Promise<void> {
    if (await this.isLinked(noteUri)) {
      this.synced.add(noteUri.fsPath);
    } else {
      this.synced.delete(noteUri.fsPath);
    }
    this.push();
  }

  private remove(noteUri: vscode.Uri): void {
    this.synced.delete(noteUri.fsPath);
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
