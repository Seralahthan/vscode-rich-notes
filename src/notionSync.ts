import * as vscode from "vscode";
import { Client } from "@notionhq/client";
import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import { NotionLink, hashOf } from "./sidecar";
import { splitSoftBreaks } from "./markdown";

const SECRET_KEY = "richNotes.notionToken";

// ---- Token (SecretStorage) -------------------------------------------------

export function getToken(context: vscode.ExtensionContext): Thenable<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function setTokenInteractive(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const token = await vscode.window.showInputBox({
    title: "Notion integration token",
    prompt:
      "Paste your Notion internal integration secret (from notion.so/my-integrations).",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "ntn_… or secret_…",
  });
  if (!token) {
    return false;
  }
  await context.secrets.store(SECRET_KEY, token.trim());
  return true;
}

export async function clearToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

// ---- Config ----------------------------------------------------------------

export function getParentPageId(): string | undefined {
  const v = vscode.workspace
    .getConfiguration("richNotes")
    .get<string>("notion.parentPageId");
  return v?.trim() || undefined;
}

// ---- Conversion / page operations ------------------------------------------

function createClient(token: string): Client {
  return new Client({ auth: token });
}

export function deriveTitle(markdown: string, fallback: string): string {
  const m = markdown.match(/^#{1,6}\s+(.+)$/m);
  const title = (m?.[1] ?? fallback).trim();
  return (title || fallback).slice(0, 200);
}

// martian returns Notion block-request objects; their precise type is awkward,
// so we treat them loosely here.
function toNotionBlocks(markdown: string): any[] {
  return markdownToBlocks(markdown) as any[];
}

async function appendInBatches(
  client: Client,
  pageId: string,
  children: any[]
): Promise<void> {
  for (let i = 0; i < children.length; i += 100) {
    await client.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + 100),
    });
  }
}

async function clearChildren(client: Client, pageId: string): Promise<void> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
    });
    for (const block of res.results) {
      ids.push((block as any).id);
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  for (const id of ids) {
    await client.blocks.delete({ block_id: id });
  }
}

async function editedTime(client: Client, pageId: string): Promise<string | undefined> {
  const page = (await client.pages.retrieve({ page_id: pageId })) as any;
  return page.last_edited_time;
}

/** Create a new Notion page under the configured parent and push the content. */
export async function createLinkedPage(
  token: string,
  parentPageId: string,
  title: string,
  markdown: string
): Promise<NotionLink> {
  const client = createClient(token);
  const blocks = toNotionBlocks(markdown);
  const page = (await client.pages.create({
    parent: { type: "page_id", page_id: parentPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: blocks.slice(0, 100),
  })) as any;
  if (blocks.length > 100) {
    await appendInBatches(client, page.id, blocks.slice(100));
  }
  return {
    pageId: page.id,
    lastSyncedHash: hashOf(markdown),
    lastSyncedMarkdown: markdown,
    lastEditedTime: await editedTime(client, page.id),
    lastSyncedAt: new Date().toISOString(),
  };
}

/** Overwrite an existing Notion page's content with the given markdown. */
export async function pushToPage(
  token: string,
  pageId: string,
  markdown: string
): Promise<NotionLink> {
  const client = createClient(token);
  const blocks = toNotionBlocks(markdown);
  await clearChildren(client, pageId);
  await appendInBatches(client, pageId, blocks);
  return {
    pageId,
    lastSyncedHash: hashOf(markdown),
    lastSyncedMarkdown: markdown,
    lastEditedTime: await editedTime(client, pageId),
    lastSyncedAt: new Date().toISOString(),
  };
}

/** Fetch a Notion page and convert it to markdown. */
export async function pullFromPage(
  token: string,
  pageId: string
): Promise<{ markdown: string; lastEditedTime?: string }> {
  const client = createClient(token);
  const n2m = new NotionToMarkdown({ notionClient: client });
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const markdown = splitSoftBreaks(n2m.toMarkdownString(mdBlocks).parent ?? "");
  return { markdown, lastEditedTime: await editedTime(client, pageId) };
}

/** Current `last_edited_time` of a page (for remote-change detection). */
export async function getPageEditedTime(
  token: string,
  pageId: string
): Promise<string | undefined> {
  return editedTime(createClient(token), pageId);
}

/** Move a Notion page to the trash (recoverable in Notion). */
export async function archivePage(token: string, pageId: string): Promise<void> {
  await createClient(token).pages.update({ page_id: pageId, archived: true });
}
