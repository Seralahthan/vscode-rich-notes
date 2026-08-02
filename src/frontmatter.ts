import { createHash } from "crypto";
import * as YAML from "yaml";
import { canonicalizeMarkdown } from "./markdown";

/**
 * Link between a local note and its Notion page. Stored in the note's YAML
 * frontmatter (previously a separate `.md.blocks.json` sidecar). Change
 * detection is hash-based: `syncedHash` is the hash of the canonical body at the
 * last sync, so we no longer store the full base markdown.
 */
export interface NotionLink {
  /** The Notion page id this note is synced with. */
  pageId: string;
  /** Hash of the canonical body (frontmatter excluded) at the last sync. */
  syncedHash: string;
  /** Notion page `last_edited_time` at the last sync (remote-change detection). */
  lastEditedTime?: string;
  /** ISO timestamp of the last sync. */
  lastSyncedAt?: string;
}

export interface ParsedNote {
  /** The Notion link parsed from frontmatter, if any. */
  link?: NotionLink;
  /** The markdown body with the frontmatter block removed. */
  body: string;
  /** All parsed frontmatter keys (so non-notion keys survive a re-serialize). */
  frontmatter: Record<string, unknown>;
}

// A leading YAML frontmatter block: `---` … `---` at the very top of the file.
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of the canonical body — the stable identity used for change detection. */
export function bodyHash(body: string): string {
  return hashOf(canonicalizeMarkdown(body));
}

function toLink(raw: unknown): NotionLink | undefined {
  const n = raw as Record<string, unknown> | undefined;
  if (!n || typeof n.pageId !== "string" || !n.pageId) {
    return undefined;
  }
  return {
    pageId: n.pageId,
    syncedHash: typeof n.syncedHash === "string" ? n.syncedHash : "",
    lastEditedTime: typeof n.lastEditedTime === "string" ? n.lastEditedTime : undefined,
    lastSyncedAt: typeof n.lastSyncedAt === "string" ? n.lastSyncedAt : undefined,
  };
}

/** Split a note's raw text into its Notion link, body, and any other frontmatter. */
export function parseNote(text: string): ParsedNote {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    return { body: text, frontmatter: {} };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed frontmatter — treat the whole thing as body rather than lose it.
    return { body: text, frontmatter: {} };
  }
  // Drop the blank line(s) separating the frontmatter block from the body, so
  // the editor/Notion never see a spurious leading empty line.
  const body = text.slice(m[0].length).replace(/^(?:\r?\n)+/, "");
  return { link: toLink(data.notion), body, frontmatter: data };
}

/** Just the body (frontmatter stripped) — what the editor and Notion operate on. */
export function noteBody(text: string): string {
  return parseNote(text).body;
}

/** Just the link, if the note is synced. */
export function noteLink(text: string): NotionLink | undefined {
  return parseNote(text).link;
}

/**
 * Reattach frontmatter to a body. Updates only the `notion` key, preserving any
 * other user frontmatter keys. When `link` is undefined the notion key is
 * removed, and if no other keys remain the frontmatter block is dropped entirely
 * (so an unsynced note is clean markdown with no `---` block).
 */
export function serializeNote(
  body: string,
  link: NotionLink | undefined,
  existingFrontmatter: Record<string, unknown> = {}
): string {
  const data: Record<string, unknown> = { ...existingFrontmatter };
  if (link) {
    data.notion = {
      pageId: link.pageId,
      syncedHash: link.syncedHash,
      ...(link.lastEditedTime ? { lastEditedTime: link.lastEditedTime } : {}),
      ...(link.lastSyncedAt ? { lastSyncedAt: link.lastSyncedAt } : {}),
    };
  } else {
    delete data.notion;
  }
  if (Object.keys(data).length === 0) {
    return body.replace(/^\s+/, ""); // no frontmatter — clean body
  }
  const yaml = YAML.stringify(data).replace(/\n+$/, "");
  return `---\n${yaml}\n---\n\n${body.replace(/^\s+/, "")}`;
}

/** Build a fresh NotionLink from a page id and the body it was synced against. */
export function linkFrom(
  pageId: string,
  body: string,
  lastEditedTime?: string
): NotionLink {
  return {
    pageId,
    syncedHash: bodyHash(body),
    lastEditedTime,
    lastSyncedAt: new Date().toISOString(),
  };
}
