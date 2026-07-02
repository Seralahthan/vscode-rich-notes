import * as vscode from "vscode";
import { createHash } from "crypto";

/** Link between a local note and its Notion page, stored in the sidecar. */
export interface NotionLink {
  /** The Notion page id this note is synced with. */
  pageId: string;
  /** Hash of the markdown at the last successful sync (local-change detection). */
  lastSyncedHash: string;
  /** The markdown at the last successful sync (the merge base). */
  lastSyncedMarkdown?: string;
  /** Notion page `last_edited_time` at the last sync (remote-change detection). */
  lastEditedTime?: string;
  /** ISO timestamp of the last sync. */
  lastSyncedAt?: string;
}

/**
 * Companion file stored next to each note ("<name>.md.blocks.json"). Holds the
 * exact BlockNote blocks (lossless fidelity) plus optional Notion link state.
 */
export interface Sidecar {
  version: number;
  /** Hash of the markdown these blocks correspond to. */
  markdownHash: string;
  blocks: unknown;
  notion?: NotionLink;
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sidecarUriFor(docUri: vscode.Uri): vscode.Uri {
  return docUri.with({ path: docUri.path + ".blocks.json" });
}

export async function readSidecar(docUri: vscode.Uri): Promise<Sidecar | null> {
  try {
    const raw = await vscode.workspace.fs.readFile(sidecarUriFor(docUri));
    return JSON.parse(Buffer.from(raw).toString("utf8")) as Sidecar;
  } catch {
    return null; // missing or unreadable
  }
}

export async function writeSidecar(
  docUri: vscode.Uri,
  data: Sidecar
): Promise<void> {
  await vscode.workspace.fs.writeFile(
    sidecarUriFor(docUri),
    Buffer.from(JSON.stringify(data), "utf8")
  );
}

/** Update only the Notion link portion of a note's sidecar, preserving blocks. */
export async function updateNotionLink(
  docUri: vscode.Uri,
  markdown: string,
  notion: NotionLink | undefined
): Promise<void> {
  const existing = await readSidecar(docUri);
  await writeSidecar(docUri, {
    version: existing?.version ?? 1,
    markdownHash: existing?.markdownHash ?? hashOf(markdown),
    blocks: existing?.blocks ?? [],
    notion,
  });
}
