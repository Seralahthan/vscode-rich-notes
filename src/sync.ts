import * as vscode from "vscode";
import * as path from "path";
import { readSidecar, updateNotionLink, hashOf, NotionLink } from "./sidecar";
import { getToken, pushToPage, pullFromPage } from "./notionSync";
import { canonicalizeMarkdown } from "./markdown";

export type SyncTrigger = "manual" | "auto";

/**
 * True for the "Canceled" errors VS Code throws when in-flight async work is
 * aborted — e.g. an on-focus sync interrupted by window reload / host
 * deactivation. These are expected, not failures, so callers skip logging them.
 */
export function isCancellation(err: unknown): boolean {
  return (
    err instanceof vscode.CancellationError ||
    (err as { name?: string })?.name === "Canceled"
  );
}

// State for an in-progress diff-based conflict resolution (one at a time).
interface PendingConflict {
  noteUri: vscode.Uri;
  token: string;
  link: NotionLink;
  localMarkdown: string;
  remoteMarkdown: string;
  lastEditedTime?: string;
  leftUri: vscode.Uri; // canonical remote (temp)
  rightUri: vscode.Uri; // canonical local (temp, editable for merge)
}
let pending: PendingConflict | undefined;

// Per-note lock. A sync may be mid-push (pushToPage clears then re-appends
// blocks, leaving Notion transiently partial); a second overlapping sync would
// read that partial state and raise a false conflict. So syncs for the same
// note never overlap — a concurrent one is skipped.
const syncing = new Set<string>();

/** Acquire without waiting; returns false if already locked (used for background syncs). */
function tryLock(key: string): boolean {
  if (syncing.has(key)) {
    return false;
  }
  syncing.add(key);
  return true;
}

/** Acquire, waiting for any in-progress operation (used for user-initiated actions). */
async function lockWait(key: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (syncing.has(key)) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  syncing.add(key); // synchronous right after the check — no interleaving
  return true;
}

function unlock(key: string): void {
  syncing.delete(key);
}

/** Replace a note's content, updating the open editor if there is one, and save. */
async function setNoteContent(uri: vscode.Uri, text: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)),
    text
  );
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

function linkFrom(pageId: string, markdown: string, lastEditedTime?: string): NotionLink {
  return {
    pageId,
    lastSyncedHash: hashOf(markdown),
    lastSyncedMarkdown: markdown,
    lastEditedTime,
    lastSyncedAt: new Date().toISOString(),
  };
}

/**
 * Bidirectional sync for a note already linked to Notion. Detects which side(s)
 * changed and pushes, pulls, or resolves a conflict accordingly.
 */
export async function syncLinkedNote(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri,
  link: NotionLink,
  markdown: string,
  trigger: SyncTrigger
): Promise<void> {
  const key = noteUri.toString();
  if (!tryLock(key)) {
    return; // a sync is already running for this note — don't read a mid-push state
  }
  try {
    await runSync(context, noteUri, link, markdown, trigger);
  } finally {
    unlock(key);
  }
}

async function runSync(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri,
  link: NotionLink,
  markdown: string,
  trigger: SyncTrigger
): Promise<void> {
  const token = await getToken(context);
  if (!token) {
    if (trigger === "manual") {
      vscode.window.showWarningMessage("Set your Notion token first.");
    }
    return;
  }

  // Change detection is CONTENT-based, not timestamp-based: Notion's
  // last_edited_time is truncated to the minute, so an edit within the same
  // minute as the last sync would be invisible. We compare canonical content of
  // local and remote against the stored base (lastSyncedMarkdown).
  const { markdown: remote, lastEditedTime } = await pullFromPage(
    token,
    link.pageId,
    markdown
  );
  const cLocal = canonicalizeMarkdown(markdown);
  const cRemote = canonicalizeMarkdown(remote);
  const cBase = canonicalizeMarkdown(link.lastSyncedMarkdown ?? "");
  const localChanged = cLocal !== cBase;
  const remoteChanged = cRemote !== cBase;

  if (!localChanged && !remoteChanged) {
    if (trigger === "manual") {
      vscode.window.showInformationMessage("Already up to date with Notion.");
    }
    return;
  }

  if (localChanged && !remoteChanged) {
    const newLink = await pushToPage(
      token,
      link.pageId,
      markdown,
      path.basename(noteUri.fsPath, ".md")
    );
    await updateNotionLink(noteUri, markdown, newLink);
    if (trigger === "manual") {
      vscode.window.showInformationMessage("Pushed to Notion.");
    }
    return;
  }

  if (!localChanged && remoteChanged) {
    await setNoteContent(noteUri, remote);
    await updateNotionLink(noteUri, remote, linkFrom(link.pageId, remote, lastEditedTime));
    if (trigger === "manual") {
      vscode.window.showInformationMessage("Pulled the latest from Notion.");
    }
    return;
  }

  // Both sides changed. If they already match, just reconcile — no prompt.
  if (cLocal === cRemote) {
    await updateNotionLink(
      noteUri,
      markdown,
      linkFrom(link.pageId, markdown, lastEditedTime)
    );
    if (trigger === "manual") {
      vscode.window.showInformationMessage("Local and Notion already match — reconciled.");
    }
    return;
  }

  // A genuine conflict.
  if (trigger === "auto") {
    const pick = await vscode.window.showWarningMessage(
      `“${path.basename(noteUri.fsPath)}” changed both locally and in Notion.`,
      "Resolve…",
      "Later"
    );
    if (pick !== "Resolve…") {
      return;
    }
  }
  await openConflict(context, token, noteUri, link, markdown, remote, lastEditedTime);
}

/**
 * Open a canonicalized diff (remote ↔ local) and expose resolution actions as
 * diff-toolbar buttons (via the richNotes.conflictActive context key), so the
 * diff stays fully visible while choosing.
 */
async function openConflict(
  context: vscode.ExtensionContext,
  token: string,
  noteUri: vscode.Uri,
  link: NotionLink,
  localMarkdown: string,
  remoteMarkdown: string,
  lastEditedTime: string | undefined
): Promise<void> {
  if (pending) {
    return; // a conflict is already open for resolution — don't stack another
  }
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const name = path.basename(noteUri.fsPath);
  const leftUri = vscode.Uri.joinPath(context.globalStorageUri, "notion-remote~" + name);
  const rightUri = vscode.Uri.joinPath(context.globalStorageUri, "your-local~" + name);
  // Canonicalize both sides so only genuine content differences show.
  await vscode.workspace.fs.writeFile(
    leftUri,
    Buffer.from(canonicalizeMarkdown(remoteMarkdown), "utf8")
  );
  await vscode.workspace.fs.writeFile(
    rightUri,
    Buffer.from(canonicalizeMarkdown(localMarkdown), "utf8")
  );

  pending = {
    noteUri,
    token,
    link,
    localMarkdown,
    remoteMarkdown,
    lastEditedTime,
    leftUri,
    rightUri,
  };

  await vscode.commands.executeCommand(
    "vscode.diff",
    leftUri,
    rightUri,
    `Resolve: Notion (remote) ↔ Local — ${name}`
  );
  await vscode.commands.executeCommand("setContext", "richNotes.conflictActive", true);
  vscode.window.setStatusBarMessage(
    "Rich Notes: resolve the conflict using the toolbar buttons (↑ keep local · ↓ keep remote · merge · ✗)",
    8000
  );
}

type ResolveMode = "local" | "remote" | "merge" | "cancel";

async function finishResolve(mode: ResolveMode): Promise<void> {
  const p = pending;
  if (!p) {
    return;
  }
  // Claim the conflict synchronously so a second click (before the awaits below
  // settle) can't start a concurrent push against the same page.
  pending = undefined;
  await vscode.commands.executeCommand("setContext", "richNotes.conflictActive", false);

  const key = p.noteUri.toString();
  // Serialize the resolve's Notion writes against any background sync.
  const locked = mode === "cancel" ? false : await lockWait(key);
  try {
    if (mode !== "cancel" && !locked) {
      vscode.window.showWarningMessage(
        "A sync is in progress — please resolve again in a moment."
      );
    } else if (mode === "remote") {
      await setNoteContent(p.noteUri, p.remoteMarkdown);
      await updateNotionLink(
        p.noteUri,
        p.remoteMarkdown,
        linkFrom(p.link.pageId, p.remoteMarkdown, p.lastEditedTime)
      );
      vscode.window.showInformationMessage("Replaced the local note with the Notion version.");
    } else if (mode === "local") {
      const newLink = await pushToPage(
        p.token,
        p.link.pageId,
        p.localMarkdown,
        path.basename(p.noteUri.fsPath, ".md")
      );
      await updateNotionLink(p.noteUri, p.localMarkdown, newLink);
      vscode.window.showInformationMessage("Pushed your local version to Notion.");
    } else if (mode === "merge") {
      // The user edited the (right) local side in the diff; use that.
      const bytes = await vscode.workspace.fs.readFile(p.rightUri);
      const merged = Buffer.from(bytes).toString("utf8");
      await setNoteContent(p.noteUri, merged);
      const newLink = await pushToPage(
        p.token,
        p.link.pageId,
        merged,
        path.basename(p.noteUri.fsPath, ".md")
      );
      await updateNotionLink(p.noteUri, merged, newLink);
      vscode.window.showInformationMessage("Merged and pushed to Notion.");
    }
  } catch (err: any) {
    vscode.window.showErrorMessage("Resolve failed: " + (err?.message ?? String(err)));
  } finally {
    if (locked) {
      unlock(key);
    }
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    for (const uri of [p.leftUri, p.rightUri]) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Register the diff-toolbar resolution commands. */
export function registerConflictCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("richNotes.resolveKeepLocal", () => finishResolve("local")),
    vscode.commands.registerCommand("richNotes.resolveKeepRemote", () => finishResolve("remote")),
    vscode.commands.registerCommand("richNotes.resolveMergePush", () => finishResolve("merge")),
    vscode.commands.registerCommand("richNotes.resolveCancel", () => finishResolve("cancel"))
  );
}

// Per-note cooldown so overlapping triggers (open + tab-activation, rapid
// focus toggles) don't run duplicate content fetches back-to-back.
const recentChecks = new Map<string, number>();
const CHECK_COOLDOWN_MS = 1500;

/**
 * When a linked note is opened, becomes the active editor, or the window regains
 * focus, run a content-based sync: pull remote changes, push local changes, or
 * open the resolver if both changed. (Silent when nothing changed.)
 */
export async function checkRemoteOnOpen(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri
): Promise<void> {
  const key = noteUri.toString();
  const now = Date.now();
  if (now - (recentChecks.get(key) ?? 0) < CHECK_COOLDOWN_MS) {
    return; // deduped: checked this note a moment ago
  }
  recentChecks.set(key, now);

  const link = (await readSidecar(noteUri))?.notion;
  if (!link?.pageId) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(noteUri);
  await syncLinkedNote(context, noteUri, link, doc.getText(), "auto");
}

/** Diagnostic: report what the sync engine sees for a note. */
export async function syncStatus(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri
): Promise<void> {
  const link = (await readSidecar(noteUri))?.notion;
  if (!link?.pageId) {
    vscode.window.showInformationMessage("This note isn’t linked to Notion.");
    return;
  }
  const token = await getToken(context);
  if (!token) {
    vscode.window.showWarningMessage("Set your Notion token first.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(noteUri);
  const { markdown: remote, lastEditedTime } = await pullFromPage(
    token,
    link.pageId,
    doc.getText()
  );

  // Content-based (matches the sync engine): compare canonical local/remote to base.
  const cLocal = canonicalizeMarkdown(doc.getText());
  const cRemote = canonicalizeMarkdown(remote);
  const cBase = canonicalizeMarkdown(link.lastSyncedMarkdown ?? "");

  vscode.window.showInformationMessage(
    [
      `Page id: ${link.pageId}`,
      `Local changed since sync: ${cLocal !== cBase}`,
      `Remote changed since sync: ${cRemote !== cBase}`,
      `Local == Remote: ${cLocal === cRemote}`,
      `Notion last-edited now: ${lastEditedTime ?? "unknown"} (minute-truncated)`,
      `Last synced at: ${link.lastSyncedAt ?? "none"}`,
    ].join("\n"),
    { modal: true }
  );
}

/** Force: overwrite the local note with the Notion version (ignores change detection). */
export async function forcePull(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri
): Promise<void> {
  const link = (await readSidecar(noteUri))?.notion;
  if (!link?.pageId) {
    vscode.window.showInformationMessage("This note isn’t linked to Notion.");
    return;
  }
  const token = await getToken(context);
  if (!token) {
    vscode.window.showWarningMessage("Set your Notion token first.");
    return;
  }
  const key = noteUri.toString();
  if (!(await lockWait(key))) {
    vscode.window.showWarningMessage("A sync is in progress — try again in a moment.");
    return;
  }
  try {
    const local = (await vscode.workspace.openTextDocument(noteUri)).getText();
    const { markdown, lastEditedTime } = await pullFromPage(token, link.pageId, local);
    await setNoteContent(noteUri, markdown);
    await updateNotionLink(noteUri, markdown, linkFrom(link.pageId, markdown, lastEditedTime));
    vscode.window.showInformationMessage("Pulled from Notion — local note replaced.");
  } finally {
    unlock(key);
  }
}

/** Force: overwrite the Notion page with the local version (ignores change detection). */
export async function forcePush(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri
): Promise<void> {
  const link = (await readSidecar(noteUri))?.notion;
  if (!link?.pageId) {
    vscode.window.showInformationMessage("This note isn’t linked to Notion.");
    return;
  }
  const token = await getToken(context);
  if (!token) {
    vscode.window.showWarningMessage("Set your Notion token first.");
    return;
  }
  const key = noteUri.toString();
  if (!(await lockWait(key))) {
    vscode.window.showWarningMessage("A sync is in progress — try again in a moment.");
    return;
  }
  try {
    const md = (await vscode.workspace.openTextDocument(noteUri)).getText();
    const newLink = await pushToPage(
      token,
      link.pageId,
      md,
      path.basename(noteUri.fsPath, ".md")
    );
    await updateNotionLink(noteUri, md, newLink);
    vscode.window.showInformationMessage("Pushed to Notion — remote page replaced.");
  } finally {
    unlock(key);
  }
}

/** Manual "sync now" for the given note (links if needed via the caller). */
export async function manualSync(
  context: vscode.ExtensionContext,
  noteUri: vscode.Uri
): Promise<void> {
  const link = (await readSidecar(noteUri))?.notion;
  if (!link?.pageId) {
    vscode.window.showInformationMessage(
      "This note isn’t linked to Notion yet — use “Rich Notes: Sync to Notion”."
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(noteUri);
  await syncLinkedNote(context, noteUri, link, doc.getText(), "manual");
}
