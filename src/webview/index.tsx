import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useCreateBlockNote,
  useBlockNoteEditor,
  useComponentsContext,
  useEditorChange,
  useEditorSelectionChange,
  FormattingToolbar,
  FormattingToolbarController,
  BlockTypeSelect,
  FileCaptionButton,
  FileReplaceButton,
  BasicTextStyleButton,
  TextAlignButton,
  ColorStyleButton,
  CreateLinkButton,
  NestBlockButton,
  UnnestBlockButton,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { en } from "@blocknote/core/locales";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./theme.css";

// Minimal typing for the VS Code webview bridge.
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
};
const vscode = acquireVsCodeApi();

/**
 * BlockNote's markdown importer mishandles "loose" lists (items separated by
 * blank lines): it produces empty list items with the text demoted to a nested
 * paragraph. BlockNote's own exporter also writes loose lists, so its output
 * does not round-trip through its own parser. We tighten lists before parsing by
 * dropping blank lines that sit strictly between two list items, which makes the
 * parser produce the correct nested structure. Blank lines before a following
 * non-list paragraph are preserved.
 */
function tightenMarkdownLists(md: string): string {
  const lines = md.split("\n");
  const isListItem = (l: string) => /^\s*([*+-]|\d+[.)])\s+/.test(l);
  const isBlank = (l: string) => l.trim() === "";
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) {
      const prev = out[out.length - 1];
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) {
        j++;
      }
      const next = j < lines.length ? lines[j] : null;
      if (prev !== undefined && next !== null && isListItem(prev) && isListItem(next)) {
        continue; // drop the blank line between two list items
      }
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * BlockNote serializes language-less code blocks with its default language
 * ("```text"). Markdown's plain fence is just "```", so we strip the default
 * language while leaving explicitly-chosen languages (e.g. "```javascript")
 * untouched.
 */
function bareifyDefaultCodeFences(md: string): string {
  return md.replace(/^(\s*)```text$/gm, "$1```");
}

/**
 * Canonical form written to disk: bare code fences, "-" list markers (not
 * BlockNote's "*"), tight lists, no trailing whitespace, single trailing
 * newline. This keeps saved files clean and byte-consistent with what
 * notion-to-md produces, so Notion round-trips don't create cosmetic diffs.
 * Idempotent: re-parsing and re-exporting yields the same output.
 */
function canonicalizeOutput(md: string): string {
  let out = bareifyDefaultCodeFences(md);
  out = out.replace(/^(\s*)[*+](\s+)/gm, "$1-$2"); // list markers -> "-"
  out = tightenMarkdownLists(out);
  out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  return out.replace(/\n*$/, "\n"); // exactly one trailing newline
}

// Block types where Tab should NOT nest. Tab nesting is reserved for list items
// (real markdown nesting); on these it would create structure markdown can't
// express, so we suppress it.
const NO_TAB_NEST = new Set(["paragraph", "heading", "quote"]);

// Plain text of a block's inline content (ignores non-text inline nodes).
function blockPlainText(block: { content?: unknown }): string {
  const content = block.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((c: any) => (c?.type === "text" ? c.text ?? "" : ""))
    .join("");
}

// A block whose inline content has no text.
function isEmptyBlock(block: { content?: unknown }): boolean {
  const content = block.content;
  if (!Array.isArray(content)) {
    return true;
  }
  return content.every(
    (c: any) => c?.type === "text" && (c.text ?? "") === ""
  ) || content.length === 0;
}

const LIST_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
]);

/**
 * Custom formatting toolbar:
 *  - list items keep the Nest / Unnest (indent) buttons
 *  - other blocks (paragraph, heading, quote) get a Quote toggle instead,
 *    since indenting them can't be represented in markdown
 */
function CustomToolbar() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const [blockType, setBlockType] = useState<string>("paragraph");

  const syncBlockType = () => {
    try {
      setBlockType(editor.getTextCursorPosition().block.type);
    } catch {
      /* no cursor */
    }
  };
  useEditorSelectionChange(syncBlockType);
  useEditorChange(syncBlockType);

  const isList = LIST_TYPES.has(blockType);
  const isQuote = blockType === "quote";

  const toggleQuote = () => {
    const block = editor.getTextCursorPosition().block;
    editor.updateBlock(block, { type: isQuote ? "paragraph" : "quote" });
    editor.focus();
  };

  return (
    <FormattingToolbar>
      <BlockTypeSelect key="blockType" />
      <FileCaptionButton key="fileCaption" />
      <FileReplaceButton key="fileReplace" />
      <BasicTextStyleButton basicTextStyle="bold" key="bold" />
      <BasicTextStyleButton basicTextStyle="italic" key="italic" />
      <BasicTextStyleButton basicTextStyle="underline" key="underline" />
      <BasicTextStyleButton basicTextStyle="strike" key="strike" />
      <TextAlignButton textAlignment="left" key="alignLeft" />
      <TextAlignButton textAlignment="center" key="alignCenter" />
      <TextAlignButton textAlignment="right" key="alignRight" />
      <ColorStyleButton key="colors" />
      {isList ? (
        <>
          <NestBlockButton key="nest" />
          <UnnestBlockButton key="unnest" />
        </>
      ) : (
        <Components.FormattingToolbar.Button
          key="quote"
          label="Quote"
          mainTooltip={isQuote ? "Remove quote" : "Quote"}
          isSelected={isQuote}
          onClick={toggleQuote}
        >
          <QuoteIcon />
        </Components.FormattingToolbar.Button>
      )}
      <CreateLinkButton key="link" />
    </FormattingToolbar>
  );
}

function QuoteIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 7h5v6c0 2.8-1.8 4.6-4.5 5l-.5-1.4c1.5-.4 2.3-1.2 2.4-2.6H7V7zm8 0h5v6c0 2.8-1.8 4.6-4.5 5l-.5-1.4c1.5-.4 2.3-1.2 2.4-2.6H15V7z" />
    </svg>
  );
}

function Editor() {
  // Blank the "List" / "Toggle" placeholders shown in empty list items.
  const editor = useCreateBlockNote({
    dictionary: {
      ...en,
      placeholders: {
        ...en.placeholders,
        bulletListItem: "",
        numberedListItem: "",
        checkListItem: "",
        toggleListItem: "",
      },
    },
  });

  // True while we apply content from the host, so the resulting onChange is
  // not echoed back as a user edit.
  const applyingRemote = useRef(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The canonical markdown the editor's current blocks serialize to.
  const lastSerialized = useRef<string | null>(null);
  // The canonical blocks JSON currently in the editor. We compare blocks (not
  // just markdown) so structural edits markdown can't express (e.g. nested
  // paragraphs) are still detected and persisted to the sidecar.
  const lastBlocks = useRef<string | null>(null);

  // Serialize the current document to markdown (with our fence fix). Used both
  // for change detection and for what we write to the .md file.
  const toMarkdown = async () =>
    canonicalizeOutput(await editor.blocksToMarkdownLossy(editor.document));

  // Load content from the host. Prefer the exact sidecar blocks when present;
  // otherwise parse the markdown.
  const setContent = async (markdown: string, blocksJson: string | null) => {
    if (blocksJson != null && blocksJson === lastBlocks.current) {
      vscode.postMessage({ type: "acked" });
      return;
    }
    if (blocksJson == null && markdown === lastSerialized.current) {
      vscode.postMessage({ type: "acked" });
      return;
    }
    applyingRemote.current = true;
    try {
      const blocks =
        blocksJson != null
          ? JSON.parse(blocksJson)
          : await editor.tryParseMarkdownToBlocks(tightenMarkdownLists(markdown));
      editor.replaceBlocks(
        editor.document,
        blocks.length > 0 ? blocks : [{ type: "paragraph" }]
      );
      lastSerialized.current = await toMarkdown();
      lastBlocks.current = JSON.stringify(editor.document);
    } finally {
      setTimeout(() => {
        applyingRemote.current = false;
        vscode.postMessage({ type: "acked" });
      }, 0);
    }
  };

  const pushEdit = async () => {
    const markdown = await toMarkdown();
    const blocksJson = JSON.stringify(editor.document);
    if (markdown === lastSerialized.current && blocksJson === lastBlocks.current) {
      return; // nothing changed
    }
    lastSerialized.current = markdown;
    lastBlocks.current = blocksJson;
    vscode.postMessage({ type: "edit", text: markdown, blocks: blocksJson });
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg && msg.type === "setContent") {
        void setContent(
          String(msg.text ?? ""),
          typeof msg.blocks === "string" ? msg.blocks : null
        );
      }
    };

    // Capture phase so we intercept before BlockNote's ProseMirror keymap runs.
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      // Markdown shortcut: typing the third backtick at the start of a
      // paragraph (content is exactly "``") turns the block into a code block,
      // mirroring the "- " → bullet rule. BlockNote otherwise only offers code
      // blocks via the "/" menu. Intentionally no language preset: it adds no
      // local rendering (syntax highlighting isn't enabled) and its language
      // label mismatches Notion's spelling (js↔javascript), causing false
      // sync conflicts. Pick a language from the block's dropdown if needed.
      if (e.key === "`") {
        try {
          const block = editor.getTextCursorPosition().block;
          if (block && block.type === "paragraph" && blockPlainText(block) === "``") {
            e.preventDefault();
            e.stopPropagation();
            editor.updateBlock(block, { type: "codeBlock", content: [] });
            editor.setTextCursorPosition(block, "end");
            editor.focus();
          }
        } catch {
          /* no cursor */
        }
        return;
      }

      // Suppress Tab-nesting on non-list blocks (paragraph/heading/quote) —
      // markdown can't express an indented paragraph.
      if (e.key === "Tab" && !e.shiftKey) {
        try {
          const block = editor.getTextCursorPosition().block;
          if (block && NO_TAB_NEST.has(block.type)) {
            e.preventDefault();
            e.stopPropagation();
          }
        } catch {
          /* no cursor */
        }
        return;
      }

      // Enter on an EMPTY list item: outdent one level instead of BlockNote's
      // default (turning it into a paragraph stuck at the nested depth, which
      // markdown can't represent). When already at the top level, exit the list
      // by becoming a plain paragraph.
      if (e.key === "Enter" && !e.shiftKey) {
        try {
          const block = editor.getTextCursorPosition().block;
          if (block && LIST_TYPES.has(block.type) && isEmptyBlock(block)) {
            e.preventDefault();
            e.stopPropagation();
            if (editor.canUnnestBlock()) {
              editor.unnestBlock();
            } else {
              editor.updateBlock(block, { type: "paragraph" });
            }
          }
        } catch {
          /* no cursor */
        }
      }
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDownCapture, true);
    vscode.postMessage({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDownCapture, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BlockNoteView
      editor={editor}
      formattingToolbar={false}
      onChange={() => {
        if (applyingRemote.current) {
          return;
        }
        if (debounce.current) {
          clearTimeout(debounce.current);
        }
        debounce.current = setTimeout(() => void pushEdit(), 250);
      }}
    >
      <FormattingToolbarController formattingToolbar={CustomToolbar} />
    </BlockNoteView>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <Editor />
  </StrictMode>
);
