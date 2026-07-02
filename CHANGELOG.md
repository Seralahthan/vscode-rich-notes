# Changelog

All notable changes to **Rich Notes** are documented here.

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
