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

// The Notion page title is the note's first heading — any level, ignoring
// leading blank lines (falling back to the file name when there's no heading).
// That heading is stripped from the pushed body so it isn't duplicated as the
// first block on the Notion page, and re-added at the same level on pull.
// Editing the heading in the editor therefore renames the Notion page, not its
// content.
const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;

/** The note's first heading (skipping leading blank lines), with the body after it. */
function firstHeading(
  markdown: string
): { level: number; text: string; body: string } | null {
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") {
    i++;
  }
  const m = i < lines.length ? HEADING_LINE.exec(lines[i]) : null;
  if (!m) {
    return null;
  }
  const body = lines.slice(i + 1).join("\n").replace(/^[ \t]*\n/, "");
  return { level: m[1].length, text: m[2].slice(0, 2000), body };
}

/**
 * Split a note into its Notion page title and the body to push (with the title
 * heading removed). Falls back to `fallback` (the file name) when there is no
 * heading.
 */
export function splitTitle(
  markdown: string,
  fallback: string
): { title: string; body: string } {
  const h = firstHeading(markdown);
  return h
    ? { title: h.text, body: h.body }
    : { title: (fallback || "Untitled").slice(0, 2000), body: markdown };
}

/**
 * Rebuild local markdown from a pulled page: re-add the page title as a heading
 * (at the local note's heading level) only when the local note is title-headed,
 * so a headingless note never gains one.
 */
export function joinTitle(localMarkdown: string, title: string, body: string): string {
  const h = firstHeading(localMarkdown);
  return h ? `${"#".repeat(h.level)} ${title}\n\n${body}` : body;
}

function pageTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title") {
      return (props[key].title ?? []).map((t: any) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

async function setPageTitle(client: Client, pageId: string, title: string): Promise<void> {
  await client.pages.update({
    page_id: pageId,
    properties: { title: { title: [{ text: { content: title } }] } },
  } as any);
}

/** Create a new Notion page under the configured parent and push the content. */
export async function createLinkedPage(
  token: string,
  parentPageId: string,
  markdown: string,
  fallbackTitle: string
): Promise<NotionLink> {
  const client = createClient(token);
  const { title, body } = splitTitle(markdown, fallbackTitle);
  const blocks = toNotionBlocks(body);
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

/** Overwrite an existing Notion page's title and content from the markdown. */
export async function pushToPage(
  token: string,
  pageId: string,
  markdown: string,
  fallbackTitle: string
): Promise<NotionLink> {
  const client = createClient(token);
  const { title, body } = splitTitle(markdown, fallbackTitle);
  await setPageTitle(client, pageId, title);
  const blocks = toNotionBlocks(body);
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

/**
 * Fetch a Notion page and convert it to markdown, re-adding the page title as an
 * H1 when the local note is title-headed (so change detection stays stable).
 */
export async function pullFromPage(
  token: string,
  pageId: string,
  localMarkdown: string
): Promise<{ markdown: string; lastEditedTime?: string }> {
  const client = createClient(token);
  const n2m = new NotionToMarkdown({ notionClient: client });
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const body = splitSoftBreaks(n2m.toMarkdownString(mdBlocks).parent ?? "");
  const page = (await client.pages.retrieve({ page_id: pageId })) as any;
  return {
    markdown: joinTitle(localMarkdown, pageTitle(page), body),
    lastEditedTime: page.last_edited_time,
  };
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
