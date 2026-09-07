# JF Custom Pause Screen — Claude project instructions

## Scope override (read first)

Every project gets its **own** graphify graph (`<project>/graphify-out/`) and its **own** Obsidian
folder (`2nd Brain/<project>/`). Never write this project's output into another project's folder.

If `/Users/jeromemabini/CLAUDE.md` still exists, it is a **parent** of this project and loads here
automatically — but it describes the **Stock Hacker / Stock Options** project, not this one. Ignore
its graphify and Obsidian paths; the paths below win. That file has been relocated to
`0000_Stock Hacker 2.0/CLAUDE.md` where it belongs, so once the home copy is deleted this note is
obsolete and can be removed.

## graphify

This project has a knowledge graph at `graphify-out/` (built 2026-09-06: 120 nodes, 202 edges,
10 communities).

- For codebase questions, run `graphify query "<question>"` first. Use `graphify path "<A>" "<B>"`
  for relationships and `graphify explain "<concept>"` for a focused concept. These return a
  scoped subgraph — usually much smaller than `GRAPH_REPORT.md` or raw grep output.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review, or when
  query/path/explain don't surface enough context.
- After changing code, run `graphify update .` to refresh the AST side (no API cost).

### Build scope — now persisted, not a manual ritual

The graph deliberately covers a scoped subset of the tree, not everything. The scope lives in
**`graphify-out/.graphify_build.json`**:

```json
{
  "excludes": ["Archive", "node_modules", "ASSETS", "dist", "logs", ".gemini", ".agents", ".git"],
  "gitignore": false
}
```

`graphify update` reads that file (`cli.py` → `_read_build_excludes` / `_read_build_gitignore`),
so a plain `graphify update .` now reproduces the intended scope on its own. The equivalent
Python call, if you ever build by hand, is:

```python
detect(Path('.'), gitignore=False,
       extra_excludes=['Archive','node_modules','ASSETS','dist','logs','.gemini','.agents','.git'])
```

- `gitignore: false` is required — `PROJECT_CONTEXT.md` is gitignored but is the single most
  valuable doc in the graph.
- `Archive/` (122 near-identical `js-pause-screen_v*.js` snapshots) and `.gemini/scratch/`
  (a 61 KB minified vendor bundle) are excluded on purpose: both produce junk duplicate nodes.

**Do not delete `.graphify_build.json`.** Without it the CLI defaults to `gitignore: true` and no
excludes, which silently drops `PROJECT_CONTEXT.md` and pulls in the `.gemini/scratch/` vendor
bundle — exactly the two things this scope exists to prevent. That is not hypothetical: it happened
on 2026-09-06, when the file did not yet exist and the "run `graphify update .` after changing
code" instruction below therefore contradicted this section every time it was followed.

### Known graph caveats

- `src/services/players/detect.js` and `scripts/smoke.mjs` appear as nodes but **do not exist on
  disk** — they are proposed in `MASTER_PLAN_CLIENT_COMPAT.md`. Treat them as plan, not code.
- ~3% dangling edges (6 of 208), the usual cross-file ID noise. Graph is usable.

## Obsidian / 2nd Brain

Cross-session memory is handled by the two global hooks described in `~/.claude/CLAUDE.md`
(capture on `SessionEnd`, recall on `UserPromptSubmit`). Nothing project-specific to run.

- This project's vault folder is **`2nd Brain/JF Pause Screen/`** — already created, with its
  `Sessions/` subfolder, and pinned in `~/.claude/hooks/project_folders.json`. The name is pinned
  on purpose: left alone, the hook would auto-derive `JF_Custom Pause Screen` from the directory
  basename. Rename it in the vault and in that JSON together, or the hook recreates the old name.
- No Obsidian vault has been exported from this graph. If you ever add one, pass `--dir` explicitly:

  ```
  graphify export obsidian --dir "/Users/jeromemabini/Library/CloudStorage/SynologyDrive-CloudStorage/0000_Obsidian/2nd Brain/JF Pause Screen"
  ```

  Without `--dir` it silently writes a new vault at `graphify-out/obsidian/` instead.
- `graphify export obsidian` only touches graph-derived notes — it does not disturb `Sessions/`.
