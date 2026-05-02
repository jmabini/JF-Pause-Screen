# Agent Protocol (Codex ↔ Antigravity)

## Session Start (Token Budget)
1. Read only the Context Digest block from `PROJECT_CONTEXT.md`:
   `sed -n '/<!-- CONTEXT_DIGEST_START -->/,/<!-- CONTEXT_DIGEST_END -->/p' PROJECT_CONTEXT.md`
2. Do not read the LONG FORM section unless you need specific details.
3. Treat `non_negotiables` as hard constraints.

## If You Need More Context
- Ask for a specific file or section; do not ingest large docs by default.
- Prefer targeted reads (e.g. `rg` on one file, or `sed -n` on a small range).

## Updating Context (Manual)
- Do not auto-edit `PROJECT_CONTEXT.md` every chat.
- Use the on-demand update skill/script in `.agent/skills/project-context-update/` (runs `scripts/update_project_context.mjs`).

## Antigravity Note
- If your editor supports “always-loaded files”, do not always-load the full `PROJECT_CONTEXT.md`; load only the Digest block.
