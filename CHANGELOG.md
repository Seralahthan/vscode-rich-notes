# Changelog

All notable changes to **Rich Notes** are documented here.

## 0.3.8

### Editor
- **Slash menu stays open across tab/window switches**: leaving and returning to
  the note no longer dismisses the menu — it stays until you pick an item, press
  Escape, or click elsewhere in the editor (matching Notion).
- **Inline "Type to search" hint**: typing `/` shows a Notion-style ghost hint
  right after the cursor; it disappears as you type a query and the list filters.

## 0.3.7

### Editor
- **Preserve intentional empty-line spacing**: blank lines you add are now
  exported as `<br/>` (and restored on load), so vertical spacing renders in any
  markdown viewer instead of collapsing. Trailing end-of-file blanks are trimmed.
- **Typography**: a comfortable 15px prose base (independent of the small
  code-editor font), a heading scale flattened to match the markdown preview, and
  a wider content column.
- **Muted placeholder**: the "Enter text…" hint uses VS Code's ghost-text color,
  so it reads as a hint rather than real content.

### Notion sync
- `<br/>` spacing lines are ignored by change detection, so added spacing never
  causes spurious conflicts or pushes.

## 0.3.6

### Workspace
- **Hide sidecar files**: the `*.md.blocks.json` companion files are now excluded
  from the Explorer and from search by default (contributed `files.exclude` /
  `search.exclude`), so they no longer clutter the workspace. They remain on disk
  next to each note.

## 0.3.5

### Editor
- **Markdown shortcut for code blocks**: type ` ``` ` at the start of a line to
  turn it into a code block, matching the existing `-`+space → bullet shortcut.

### Notion sync
- **Sync on editor refocus**: returning focus to a note's editor now pulls remote
  changes — previously a pull only ran on open, on save, or when the whole VS Code
  window regained focus.
- **No more false conflicts from code-block languages**: equivalent fence language
  names (`js`/`javascript`, `py`/`python`, `plain`/`plain text`/bare, …) are
  normalized before comparison, so code blocks no longer show as a conflict on
  every sync.
- Cancellation errors during window reload / extension deactivation are no longer
  logged as sync failures.

### Fidelity & robustness
- **Resilient sidecar restore**: the blocks↔markdown hash now tolerates
  trailing-newline and line-ending differences, so full-fidelity blocks aren't
  discarded after a save. If a note's `.md` is emptied outside the editor, the
  blocks are restored from the sidecar instead of showing a blank note.

## 0.3.4

### Notion sync (opt-in, per note)
- **Link & push**: turn any `.md` note into a Notion page under a configured parent.
- **Bidirectional sync**: pushes local edits, pulls Notion edits — triggered on
  save, on open, and when the VS Code window regains focus.
- **Content-based change detection**: compares canonical content against a stored
  base (Notion's `last_edited_time` is only minute-accurate, so timestamps alone
  are unreliable).
- **Conflict resolution**: a diff view (Notion ↔ Local) with toolbar actions —
  keep local, keep remote, or merge & push.
- **Unlink** (keeps both copies) and **delete handling** (prompts to keep or
  archive the Notion page, cleans up the sidecar).
- Force **Pull**/**Push**, a **Sync status** diagnostic, and a **Sync now** command.

### Fidelity & robustness
- Canonical markdown for clean Notion round-trips: normalized list markers,
  tight lists, 2-space nested indentation, bare code fences, dropped empty
  bullets, and split soft line breaks.
- Per-note lock so overlapping syncs can't collide or read a mid-push state.
- Auto-save for notes opened in Rich Notes.

## 0.1.0

- Initial release: a Notion-style rich-text (WYSIWYG) editor for `.md` files,
  powered by BlockNote — slash menu, drag handles, formatting toolbar, quotes,
  code blocks, and list nesting, with the file kept as clean, portable markdown.
