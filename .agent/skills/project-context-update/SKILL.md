---
name: project-context-update
description: Update PROJECT_CONTEXT.md Context Digest + long-form Session Snapshot from current git state and version files. Use when handing off between Codex and Antigravity.
---

# Project Context Update

## Goal
Update the small Digest (what agents read every session) and the long-form Session Snapshot (for humans) without touching the rest of `PROJECT_CONTEXT.md`.

## What This Updates
- Digest keys: `version`, `tool` (if provided), `branch`, `dirty`, `mods`
- Optional Digest keys (only if provided): `now`, `next` (max 3), `blocks`, `confidence`
- Long-form Session Snapshot bullets: Current Status (optional), Last Active Tool (if provided), Active Branch, Working Tree, Key Modified Files, Current Version, Confidence Level (optional)

## Run
- Codex:
  - Invoke: `$project-context-update` (or `/use project-context-update`)
  - Command: `node scripts/update_project_context.mjs --tool Codex`
- Antigravity:
  - Command: `node scripts/update_project_context.mjs --tool Antigravity`

Optional fields:
- `--now "What you are doing"`
- `--next "Critical fix"` (repeat up to 3 times)
- `--blocks "What is blocking you"`
- `--confidence High|Medium|Low`

## Verify (Digest Only)
`sed -n '/<!-- CONTEXT_DIGEST_START -->/,/<!-- CONTEXT_DIGEST_END -->/p' PROJECT_CONTEXT.md`

## Guardrails
- Refuses to run if versions do not match across `package.json`, `package-lock.json`, and `src/config.js`.
- Digest must stay <= 25 lines (markers included).
