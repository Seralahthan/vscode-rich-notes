# Rich Notes — rich-text markdown editor for VS Code

A rich-text editor for `.md` files, with Notion-style inline rendering
(type `-` and get a real bullet, headings render as you type). Files stay plain
markdown on disk, so they remain portable and version-controllable — and ready
for optional Notion sync in iteration 2.

## Iteration 1 (this version) — the editor

- Notion-style **block editor** for `.md` files powered by
  [BlockNote](https://www.blocknotejs.org/) (ProseMirror + React): slash (`/`)
  menu, draggable blocks, floating formatting toolbar, text alignment, checklists.
- Edits the underlying `TextDocument` as markdown, so **save (`Cmd+S`), dirty
  indicator, and undo/redo work natively** and files stay portable.
- Two-way sync: external changes to the file (git checkout, find/replace) update
  the editor; edits in the editor update the file.
- Adopts the active VS Code color theme.
- All assets are bundled locally — **no network calls, no telemetry**.

### Full fidelity via a sidecar

Markdown can't express everything a block editor can (e.g. nested/indented
paragraphs). To avoid silently losing such edits, each note keeps a companion
file next to it:

```
my-note.md              <- readable, portable markdown (normal Cmd+S)
my-note.md.blocks.json  <- BlockNote's exact blocks + a hash of the markdown
```

- On **load**, if the sidecar's hash matches the current `.md`, the exact blocks
  are restored (nesting and all). If the `.md` was changed outside the editor,
  the hash won't match and we parse the markdown instead.
- On **edit**, the sidecar is written automatically, so structure-only changes
  (which don't alter the markdown) are still persisted.

You can commit the sidecar for cross-machine fidelity, or `.gitignore` it and
rely on the markdown — the note still opens either way.

### List normalization

BlockNote's markdown importer mishandles "loose" lists (blank lines between
items); its own exporter also writes them. We tighten lists before parsing so
they round-trip correctly. A deliberately multi-paragraph list item is the one
structure this doesn't preserve in the markdown — but the sidecar keeps it.

### Markdown-native behavior

- **Blockquotes** use markdown's native `>` (BlockNote 0.47 `quote` block). Type
  `> ` to start a quote; quotes import/export as `>`.
- **Tab** nests **list items only**. On paragraphs / headings / quotes it is
  suppressed (markdown can't express an indented paragraph). Use a quote for
  call-outs instead.
- **Code blocks** with no language export as a plain ```` ``` ```` fence (not
  ```` ```text ````). Explicitly chosen languages (e.g. ```` ```javascript ````)
  are preserved.

### Known gap: nested blockquotes (`>>`)

BlockNote's exporter flattens nested quotes to separate top-level `>` blocks, so
the `.md` won't contain `>>`. Nesting still displays correctly in the editor
(restored from the sidecar). True `>>` in the markdown would need custom
serialization — not yet implemented.

### Run it

```bash
npm install
npm run compile
```

Then press **F5** in VS Code (Run Extension). In the new window:

- Open any `.md` file, then run **"Rich Notes: Open as rich text"** from the
  command palette (or the editor title bar button), **or**
- Run **"Rich Notes: New note"** to create one and open it directly.

To make it the default for markdown: right-click a `.md` file → *Open With…* →
*Configure default editor* → *Rich Notes (rich text)*.

## Iteration 2 (planned) — optional Notion sync

Per-note, opt-in sync. Design:

1. **Connection**: user supplies a Notion integration token (stored in VS Code
   `SecretStorage`, never in the file or settings) and shares a parent page/DB
   with the integration.
2. **Per-note opt-in**: a "Sync with Notion" action on a note. Two entry points:
   - *Link existing note* → creates a Notion page from the current markdown.
   - *New synced note* → creates the Notion page first, then the local file.
3. **Mapping**: store the Notion `pageId` + last-synced hash in a sidecar
   (`.richnotes.json`) or YAML front-matter, so only opted-in notes sync.
4. **Conversion**: markdown ⇄ Notion blocks via `@tryfabric/martian`
   (md → blocks) and `notion-to-md` (blocks → md).
5. **Sync engine**: on save, push if local changed; offer pull if remote changed;
   detect conflicts via the stored hash.

The clean-markdown-on-disk design of iteration 1 is what makes this tractable.

## Security notes

- The webview runs with a strict CSP and a script nonce; only local bundled
  assets load.
- No analytics or external requests in iteration 1.
- Iteration 2's Notion token will live in `SecretStorage`, and sync will be
  **opt-in per note** — nothing leaves your machine unless you explicitly link a
  note to Notion.
